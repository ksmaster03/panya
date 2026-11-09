// วัดความแม่นของผู้คุมสมองในการจัดหมวดปัญญา 3 บน eval/panya3.json
// ปรับน้ำหนักคำบ่งชี้บนข้อคู่ (tune) แล้วรายงานผลบนข้อคี่ (holdout) ที่ไม่ได้ใช้ปรับ
//   bun eval/govern.ts [--ollama] [--model qwen3:4b] [--misses]
// --ollama  วัดโมเดลภาษาในเครื่องด้วย (ต้องเปิด Ollama และ pull โมเดลไว้แล้ว)
import { localEmbedder } from '../src/embed'
import { config } from '../src/config'
import { OllamaGovernor, PANYA, PrototypeGovernor, type Panya, type Verdict } from '../src/governor'
import data from './panya3.json'
import freshData from './panya3-fresh.json'

const argv = process.argv
const items = data.items as { text: string; panya: Panya }[]
const tune = items.filter((_, i) => i % 2 === 0)
const holdout = items.filter((_, i) => i % 2 === 1)
// ชุดแยกที่ไม่เคยใช้ปรับค่าใด ๆ: ตัวเลขที่ควรเชื่อที่สุด
const fresh = freshData.items as typeof items
const NAMES: Record<Panya, string> = { suta: 'สุตมย', cinta: 'จินตมย', bhavana: 'ภาวนามย' }

function report(name: string, set: typeof items, got: Verdict[], ms?: number) {
  const confusion = Object.fromEntries(PANYA.map((p) => [p, Object.fromEntries(PANYA.map((q) => [q, 0]))])) as Record<Panya, Record<Panya, number>>
  let ok = 0
  const misses: string[] = []
  set.forEach((x, i) => {
    confusion[x.panya][got[i]!.panya]++
    if (got[i]!.panya === x.panya) ok++
    else misses.push(`${x.panya} -> ${got[i]!.panya} (${got[i]!.confidence}) ${x.text}`)
  })
  // ความมั่นใจสูง: ป้ายที่ความมั่นใจ >= 0.6 ถูกกี่ส่วน (ใช้ตัดสินว่าควรเชื่อป้ายอัตโนมัติแค่ไหน)
  const sure = set.map((x, i) => ({ ok: got[i]!.panya === x.panya, c: got[i]!.confidence })).filter((r) => r.c >= 0.6)
  console.log(`${name}: ถูก ${((ok / set.length) * 100).toFixed(0)}% (${ok}/${set.length})` +
    ` · มั่นใจ>=0.6 ${sure.length} ข้อ ถูก ${sure.length ? ((sure.filter((r) => r.ok).length / sure.length) * 100).toFixed(0) : '-'}%` +
    (ms !== undefined ? ` · ${ms.toFixed(0)} ms/ข้อ` : ''))
  for (const p of PANYA) {
    const row = confusion[p]
    const n = PANYA.reduce((s, q) => s + row[q], 0)
    console.log(`    ${NAMES[p].padEnd(8)} ถูก ${row[p]}/${n} · ทายเป็น ${PANYA.map((q) => `${q}:${row[q]}`).join(' ')}`)
  }
  if (argv.includes('--misses')) for (const m of misses) console.log('      ' + m)
  return ok / set.length
}

const proto = new PrototypeGovernor(localEmbedder)
const t0 = performance.now()
const all = [...items, ...fresh]
const scores = await proto.scores(all.map((x) => x.text))
const protoMs = (performance.now() - t0) / all.length
const scoreOf = new Map(all.map((x, i) => [x.text, scores[i]!]))
const run = (set: typeof items, w: number, prior = config.governor.sutaPrior) => set.map((x) => PrototypeGovernor.decide(scoreOf.get(x.text)!, w, prior))
const acc = (set: typeof items, w: number, prior: number) => run(set, w, prior).filter((v, i) => v.panya === set[i]!.panya).length / set.length

// เท่ากันเลือกค่าที่น้อยกว่า: ปรับน้อยที่สุดเท่าที่จำเป็น
let best = { w: 0, prior: 0, acc: -1 }
for (const w of [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1])
  for (const prior of [0, 0.002, 0.004, 0.006, 0.008, 0.01, 0.015, 0.02]) {
    const a = acc(tune, w, prior)
    if (a > best.acc + 1e-9) best = { w, prior, acc: a }
  }

console.log(`=== ผู้คุมสมอง · ${config.embed.model} · ${items.length} ข้อ (tune ${tune.length} / holdout ${holdout.length})`)
report(`proto เวกเตอร์อย่างเดียว (holdout)`, holdout, run(holdout, 0, 0))
report(`proto ค่าใน config cueWeight=${config.governor.cueWeight} sutaPrior=${config.governor.sutaPrior} (holdout)`, holdout, run(holdout, config.governor.cueWeight), protoMs)
console.log(`ค่าที่ดีที่สุดบน tune: cueWeight=${best.w} sutaPrior=${best.prior} (tune ${(best.acc * 100).toFixed(0)}%)`)
report(`proto ค่าที่ดีที่สุดบน tune (holdout)`, holdout, run(holdout, best.w, best.prior))
report(`proto ค่าใน config ชุดแยก (fresh)`, fresh, run(fresh, config.governor.cueWeight))
report(`proto ค่าที่ดีที่สุดบน tune ชุดแยก (fresh)`, fresh, run(fresh, best.w, best.prior))

if (argv.includes('--ollama')) {
  const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1]! : config.governor.model
  // fallback ที่ล้มเสมอ: ถ้าโมเดลตอบไม่ได้ ข้อนั้นจะถูกนับเป็นผิด ไม่ถูกช่วยด้วย proto
  const llm = new OllamaGovernor({ name: 'none', classify: async (t) => t.map(() => ({ panya: 'suta' as Panya, confidence: 0, by: 'llm' as const })) }, config.governor.ollamaUrl, model)
  await llm.classify(['warmup'])
  const t1 = performance.now()
  const got = await llm.classify(holdout.map((x) => x.text))
  report(`llm ${model} (holdout)`, holdout, got, (performance.now() - t1) / holdout.length)
  report(`llm ${model} ชุดแยก (fresh)`, fresh, await llm.classify(fresh.map((x) => x.text)))
}
process.exit(0)
