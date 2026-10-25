// วัดคุณภาพการค้นคืนของ panya บน eval/dataset.json
// ปรับเกณฑ์บนคำถามครึ่งหนึ่ง (tune) แล้วรายงานผลบนอีกครึ่งที่ไม่ได้ใช้ปรับ (holdout)
//   bun eval/run.ts [--no-entities] [--misses] [--rerank] [--haystack <brain>[:<จำนวน>]]
// --rerank    วัดแบบมี reranker เทียบกับแบบเดิม และหาค่า rerankWeight / rerankMinScore / จำนวนผู้สมัครที่ดีที่สุด
// --haystack  เติมความจำจริงจาก brain ที่ระบุเข้าไปเป็นตัวกวน เพื่อวัดที่ขนาดใกล้ของจริง
//             (อ่านจากฐานข้อมูลตอนรัน ไม่มีข้อมูลจริงถูกเขียนลงไฟล์ และถูกลบออกจากชุดทดสอบเมื่อจบ)
import { localEmbedder } from '../src/embed'
import { config, type SearchTuning } from '../src/config'
import { MemoryStore, type SearchHit } from '../src/memory'
import { localReranker } from '../src/rerank'
import data from './dataset.json'
import { measure, report, split, type Q, type Ranked } from './metrics'

const CONTAINER = 'eval'
const argv = process.argv
const useEntities = !argv.includes('--no-entities')
const useRerank = argv.includes('--rerank')
const haystack = argv.includes('--haystack') ? argv[argv.indexOf('--haystack') + 1] : undefined

const store = await MemoryStore.open(localEmbedder, { collection: `memories_eval_${config.embed.dimension}`, reranker: useRerank ? localReranker : null })
await store.clear(CONTAINER)
const idOf = new Map<string, string>()
const tAdd = Date.now()
for (const m of data.memories) {
  const r = await store.remember({ container: CONTAINER, text: m.text })
  idOf.set(r.memory.id, m.id)
}
const addMs = (Date.now() - tAdd) / data.memories.length
if (idOf.size !== data.memories.length) console.log(`! ความจำถูกรวมเหลือ ${idOf.size} จาก ${data.memories.length} (dedupe รวมของที่ไม่ควรรวม)`)
if (useEntities) for (const e of data.entities) await store.entities.register(CONTAINER, e.type, e.cues, e.names)

let distractors = 0
if (haystack) {
  const [brain, n] = haystack.split(':')
  const main = await MemoryStore.open(localEmbedder)
  const texts = (await main.exportAll(brain!)).slice(0, n ? Number(n) : undefined).map((m) => m.text)
  await main.close()
  for (let i = 0; i < texts.length; i += 100) {
    await store.rememberMany(texts.slice(i, i + 100).map((text) => ({ container: CONTAINER, text })))
    process.stdout.write(`\rเติมตัวกวนจาก "${brain}" ${Math.min(i + 100, texts.length)}/${texts.length}`)
  }
  distractors = texts.length
  console.log()
}

// ดึงผู้สมัครครั้งเดียวต่อคำถาม (ไม่ตัดด้วยเกณฑ์) แล้วลองเกณฑ์ต่าง ๆ โดยไม่ต้องยิงฐานข้อมูลซ้ำ
// เมื่อเปิด reranker ผู้สมัครทั้ง 20 รายการได้คะแนน rerank ติดมาด้วย
const queries = data.queries as Q[]
const raw = new Map<string, SearchHit[]>()
const lat: number[] = []
for (const query of queries) {
  const t = Date.now()
  const r = await store.search(CONTAINER, query.q, { limit: 20, rerankTop: 20, explain: true, tuning: { minScore: -1, rerankMinScore: -1 } })
  lat.push(Date.now() - t)
  raw.set(query.q, r.hits)
}

const clamp = (x: number) => Math.max(0, Math.min(1, x))
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
// ความจำจริงที่เป็นตัวกวนไม่มีรหัสในชุดทดสอบ: ติดอันดับเมื่อไรถือว่าตอบผิด
const nameOf = (h: SearchHit) => idOf.get(h.id) ?? 'real:' + h.id.slice(0, 8)
const baseScore = (t: SearchTuning, h: SearchHit) => (1 - t.lexWeight) * clamp((h.sim - t.simFloor) / (t.simCeil - t.simFloor)) + t.lexWeight * h.coverage
// เกณฑ์ "รู้/ไม่รู้" ใช้คะแนน weighted เสมอ ส่วนลำดับเรียงตาม fusion ที่ตั้งไว้ (PANYA_FUSION=rrf วัดแบบ RRF)
const at = (t: SearchTuning) => (q: Q): Ranked =>
  raw.get(q.q)!
    .map((h) => ({ id: nameOf(h), score: baseScore(t, h), order: t.fusion === 'rrf' ? h.explain!.rrf : baseScore(t, h) }))
    .sort((a, b) => b.order - a.order)
    .filter((h) => h.score >= t.minScore)
    .map(({ id, score }) => ({ id, score }))
// จำลองสิ่งที่ search() ทำเมื่อเปิด reranker: เลือก top ตามคะแนนเดิม ผสมคะแนน แล้วตัดด้วย rerankMinScore
const atRerank = (t: SearchTuning, top: number) => (q: Q): Ranked =>
  raw.get(q.q)!
    .map((h) => ({ h, base: baseScore(t, h) }))
    .sort((a, b) => b.base - a.base)
    .slice(0, top)
    .map(({ h, base }) => ({ id: nameOf(h), score: (1 - t.rerankWeight) * base + t.rerankWeight * h.rerank! }))
    .sort((a, b) => b.score - a.score)
    .filter((h) => h.score >= t.rerankMinScore)

const { tune, holdout } = split(queries)
let best = { t: config.search, combined: -1 }
for (const lexWeight of [0.3, 0.4, 0.5, 0.6, 0.7])
  for (const simFloor of [0.76, 0.78, 0.8, 0.82, 0.84])
    for (const simCeil of [0.86, 0.88, 0.9, 0.92])
      for (const minScore of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
        const t = { ...config.search, lexWeight, simFloor, simCeil, minScore }
        const c = measure(tune, at(t)).combined
        if (c > best.combined) best = { t, combined: c }
      }

console.log(`=== panya · ${config.embed.model} · ทะเบียนชื่อเฉพาะ ${useEntities ? 'เปิด' : 'ปิด'} · ความจำ ${data.memories.length}${distractors ? ` + ตัวกวนจริง ${distractors}` : ''} · คำถาม ${queries.length}`)
console.log(`บันทึกเฉลี่ย ${addMs.toFixed(0)} ms/รายการ · ค้นเฉลี่ย ${mean(lat).toFixed(0)} ms${useRerank ? ' (รวม rerank 20 รายการ)' : ''} · ช้าสุด ${Math.max(...lat)} ms · RSS ${Math.round(process.memoryUsage().rss / 1e6)} MB`)
report('ค่าใน config (ทั้งหมด)', queries, at(config.search))
const b = best.t
console.log(`เกณฑ์ที่ดีที่สุดบน tune: lexWeight=${b.lexWeight} simFloor=${b.simFloor} simCeil=${b.simCeil} minScore=${b.minScore}`)
report('holdout', holdout, at(b), argv.includes('--misses'))

if (useRerank) {
  // เลือกค่าบน tune: ถ้าคะแนนเท่ากัน เอาจำนวนผู้สมัครน้อยกว่า เพราะเร็วกว่า
  let rr = { t: b, top: config.rerank.top, combined: -1 }
  for (const top of [5, 8, 10, 15, 20])
    for (const rerankWeight of [0.3, 0.5, 0.7, 0.85, 1])
      for (const rerankMinScore of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6]) {
        const t = { ...b, rerankWeight, rerankMinScore }
        const c = measure(tune, atRerank(t, top)).combined
        if (c > rr.combined + 1e-9) rr = { t, top, combined: c }
      }
  console.log(`\n--- reranker · ${config.rerank.model}`)
  report('ค่าใน config (ทั้งหมด)', queries, atRerank({ ...config.search }, config.rerank.top))
  console.log(`ค่าที่ดีที่สุดบน tune: top=${rr.top} rerankWeight=${rr.t.rerankWeight} rerankMinScore=${rr.t.rerankMinScore}`)
  report('holdout', holdout, atRerank(rr.t, rr.top), argv.includes('--misses'))

  // เวลาจริงของการค้นด้วยค่าที่เลือก เทียบกับไม่ใช้ reranker บนคำถามชุดเดียวกัน
  const time = async (rerank: boolean) => {
    const ms: number[] = []
    for (const query of holdout) {
      const t0 = performance.now()
      await store.search(CONTAINER, query.q, { tuning: rr.t, rerank, rerankTop: rr.top })
      ms.push(performance.now() - t0)
    }
    ms.sort((x, y) => x - y)
    return `เฉลี่ย ${mean(ms).toFixed(0)} ms · p95 ${ms[Math.floor(ms.length * 0.95)]!.toFixed(0)} ms`
  }
  console.log(`เวลาค้นจริง: ไม่ใช้ reranker ${await time(false)} | ใช้ reranker (top ${rr.top}) ${await time(true)}`)
}

await store.clear(CONTAINER)
await store.close()
process.exit(0)
