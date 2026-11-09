// Chunking + Retrieval Evaluation: เทียบวิธีตัดเอกสารเป็นท่อน โดยวัดว่าค้นเจอท่อนที่มีคำตอบหรือไม่บน eval/docs.json
//   bun eval/chunks.ts [--misses <ชื่อวิธี>]
// ท่อนหนึ่ง "เกี่ยว" กับคำถามเมื่อมีข้อความ answer อยู่ครบในท่อนนั้น (ตัดช่องว่างก่อนเทียบ)
// ตัวชี้วัด: Recall@1/3/5, MRR, nDCG@5 บนคำถามที่มีคำตอบ · ไม่ตอบถูก บนคำถามที่ไม่มีคำตอบ (ใช้เกณฑ์ minScore ใน config)
//            บริบท = จำนวนตัวอักษรของ 3 ท่อนแรกที่ส่งให้ผู้ใช้/LLM อ่าน (น้อย = ประหยัด)
import { localEmbedder } from '../src/embed'
import { config } from '../src/config'
import { MemoryStore } from '../src/memory'
import { chunk } from '../src/import-md'
import { chunkDoc, CHUNK_DEFAULTS } from '../src/chunk'
import data from './docs.json'
import { rankScores } from './metrics'

const CONTAINER = 'eval_chunks'
const squash = (s: string) => s.replace(/\s+/g, '')

type Strategy = { name: string; cut: (doc: string) => string[] }
const STRATEGIES: Strategy[] = [
  { name: 'ย่อหน้า 700 (เดิม)', cut: (d) => chunk(d, 700) },
  { name: 'ย่อหน้า 400', cut: (d) => chunk(d, 400) },
]
for (const max of [300, 500, 800])
  for (const overlap of [0, 120])
    for (const headings of [false, true])
      STRATEGIES.push({
        name: `ประโยค ${max}${overlap ? ` ซ้อน ${overlap}` : ''}${headings ? ' +หัวข้อ' : ''}`,
        cut: (d) => chunkDoc(d, { max, overlap, headings }).map((c) => c.text),
      })

const store = await MemoryStore.open(localEmbedder, { collection: `memories_eval_${config.embed.dimension}` })
const questions = data.docs.flatMap((d) => d.questions)
const showMisses = process.argv.includes('--misses') ? process.argv[process.argv.indexOf('--misses') + 1] : undefined

const pct = (x: number) => (x * 100).toFixed(0).padStart(3) + '%'
const rows: { name: string; r1: number; r3: number; r5: number; mrr: number; ndcg: number; abstain: number; falseAbstain: number; chunks: number; avg: number; ctx: number }[] = []

for (const s of STRATEGIES) {
  await store.clear(CONTAINER)
  let chunks = 0, chars = 0
  for (const d of data.docs) {
    const parts = s.cut(d.text)
    chunks += parts.length
    chars += parts.reduce((n, p) => n + p.length, 0)
    await store.rememberMany(parts.map((text, i) => ({ container: CONTAINER, text, source: d.source, ref: `${d.id}#${i}` })))
  }
  // ท่อนที่มีคำตอบทั้งหมดในคลัง: ใช้เป็นตัวหารของ nDCG
  const all = await store.exportAll(CONTAINER)
  let r1 = 0, r3 = 0, r5 = 0, mrr = 0, ndcg = 0, answerable = 0, falseAbstain = 0, unanswerable = 0, abstain = 0, ctx = 0
  const misses: string[] = []
  for (const q of questions) {
    // ดึงอันดับโดยไม่ตัดเกณฑ์ เพื่อวัดคุณภาพการเรียง แล้วค่อยใช้เกณฑ์ minScore ตัดสินว่าตอบหรือไม่
    const r = await store.search(CONTAINER, q.q, { limit: 10, tuning: { minScore: -1 } })
    const kept = r.hits.filter((h) => h.score >= config.search.minScore)
    ctx += kept.slice(0, 3).reduce((n, h) => n + h.text.length, 0)
    if (!q.answer) {
      unanswerable++
      if (!kept.length) abstain++
      else misses.push(`ไม่มีคำตอบแต่ตอบ: ${q.q} -> ${kept[0]!.text.slice(0, 60).replace(/\n/g, ' / ')}`)
      continue
    }
    answerable++
    const a = squash(q.answer)
    const rel = r.hits.map((h) => squash(h.text).includes(a))
    const sc = rankScores(rel, Math.max(1, all.filter((m) => squash(m.text).includes(a)).length))
    r1 += sc.r1; r3 += sc.r3; r5 += sc.r5; mrr += sc.mrr; ndcg += sc.ndcg
    if (!kept.length) falseAbstain++
    if (!sc.r3) misses.push(`ไม่เจอใน 3: ${q.q} [${q.answer}] -> ${r.hits[0]?.text.slice(0, 60).replace(/\n/g, ' / ') ?? '-'}`)
  }
  rows.push({ name: s.name, r1: r1 / answerable, r3: r3 / answerable, r5: r5 / answerable, mrr: mrr / answerable, ndcg: ndcg / answerable,
    abstain: abstain / unanswerable, falseAbstain: falseAbstain / answerable, chunks, avg: chars / chunks, ctx: ctx / questions.length })
  if (showMisses && s.name.includes(showMisses)) { console.log(`--- ${s.name}`); for (const m of misses) console.log('  ' + m) }
}

const answerable = questions.filter((q) => q.answer).length
console.log(`=== Chunking eval · ${config.embed.model} · เอกสาร ${data.docs.length} ฉบับ · คำถาม ${questions.length} (มีคำตอบ ${answerable} ไม่มี ${questions.length - answerable}) · minScore ${config.search.minScore}`)
console.log('วิธีตัด                       ท่อน  ยาวเฉลี่ย  R@1  R@3  R@5   MRR  nDCG@5  ไม่ตอบถูก  ไม่ตอบผิด  บริบท')
for (const r of rows) {
  console.log(`${r.name.padEnd(26)} ${String(r.chunks).padStart(4)} ${r.avg.toFixed(0).padStart(8)} ${pct(r.r1)} ${pct(r.r3)} ${pct(r.r5)} ${r.mrr.toFixed(3)} ${r.ndcg.toFixed(3).padStart(7)} ${pct(r.abstain).padStart(9)} ${pct(r.falseAbstain).padStart(9)} ${r.ctx.toFixed(0).padStart(6)}`)
}
// เลือกด้วย MRR ก่อน (คำตอบอยู่สูงแค่ไหน) แล้ว nDCG แล้วบริบทที่สั้นกว่า
const best = [...rows].sort((a, b) => b.mrr - a.mrr || b.ndcg - a.ndcg || a.ctx - b.ctx)[0]!
console.log(`ดีที่สุดตาม MRR: ${best.name} · ค่าเริ่มต้นของ chunkDoc ตอนนี้: max ${CHUNK_DEFAULTS.max} overlap ${CHUNK_DEFAULTS.overlap} headings ${CHUNK_DEFAULTS.headings}`)

await store.clear(CONTAINER)
await store.close()
process.exit(0)
