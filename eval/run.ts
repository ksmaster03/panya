// วัดคุณภาพการค้นคืนของ panya บน eval/dataset.json
// ปรับเกณฑ์บนคำถามครึ่งหนึ่ง (tune) แล้วรายงานผลบนอีกครึ่งที่ไม่ได้ใช้ปรับ (holdout)
//   bun eval/run.ts [--no-entities] [--misses]
import { localEmbedder } from '../src/embed'
import { config, type SearchTuning } from '../src/config'
import { MemoryStore, type SearchHit } from '../src/memory'
import data from './dataset.json'
import { measure, report, split, type Q, type Ranked } from './metrics'

const CONTAINER = 'eval'
const useEntities = !process.argv.includes('--no-entities')

const store = await MemoryStore.open(localEmbedder, { collection: `memories_eval_${config.embed.dimension}` })
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

// ดึงผู้สมัครครั้งเดียวต่อคำถาม (ไม่ตัดด้วยเกณฑ์) แล้วลองเกณฑ์ต่าง ๆ โดยไม่ต้องยิงฐานข้อมูลซ้ำ
const queries = data.queries as Q[]
const raw = new Map<string, SearchHit[]>()
const lat: number[] = []
for (const query of queries) {
  const t = Date.now()
  const r = await store.search(CONTAINER, query.q, { limit: 20, tuning: { minScore: -1 } })
  lat.push(Date.now() - t)
  raw.set(query.q, r.hits)
}

const clamp = (x: number) => Math.max(0, Math.min(1, x))
const at = (t: SearchTuning) => (q: Q): Ranked =>
  raw.get(q.q)!
    .map((h) => ({ id: idOf.get(h.id)!, score: (1 - t.lexWeight) * clamp((h.sim - t.simFloor) / (t.simCeil - t.simFloor)) + t.lexWeight * h.coverage }))
    .sort((a, b) => b.score - a.score)
    .filter((h) => h.score >= t.minScore)

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

console.log(`=== panya · ${config.embed.model} · ทะเบียนชื่อเฉพาะ ${useEntities ? 'เปิด' : 'ปิด'} · ความจำ ${data.memories.length} · คำถาม ${queries.length}`)
console.log(`บันทึกเฉลี่ย ${addMs.toFixed(0)} ms/รายการ · ค้นเฉลี่ย ${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(0)} ms · ช้าสุด ${Math.max(...lat)} ms · RSS ${Math.round(process.memoryUsage().rss / 1e6)} MB`)
report('ค่าใน config (ทั้งหมด)', queries, at(config.search))
const b = best.t
console.log(`เกณฑ์ที่ดีที่สุดบน tune: lexWeight=${b.lexWeight} simFloor=${b.simFloor} simCeil=${b.simCeil} minScore=${b.minScore}`)
report('holdout', holdout, at(b), process.argv.includes('--misses'))

await store.clear(CONTAINER)
await store.close()
process.exit(0)
