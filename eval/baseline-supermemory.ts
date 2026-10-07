// ตัวเทียบ: supermemory (self-host) บนชุดวัดผลเดียวกัน
//   bun eval/baseline-supermemory.ts ingest    ป้อนความจำ แล้วรอจนประมวลผลครบ
//   bun eval/baseline-supermemory.ts measure   วัดผล (ปรับเกณฑ์คะแนนบน tune รายงานบน holdout เหมือน panya)
// ต้องมี SUPERMEMORY_URL และ SUPERMEMORY_API_KEY
import data from './dataset.json'
import { measure, report, split, type Q, type Ranked } from './metrics'

const BASE = process.env.SUPERMEMORY_URL ?? 'http://127.0.0.1:6767'
const KEY = process.env.SUPERMEMORY_API_KEY ?? ''
const TAG = process.env.SUPERMEMORY_TAG ?? 'panya_eval_v2'
const MAP = process.env.SUPERMEMORY_MAP ?? new URL('./.baseline-map.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
if (!KEY) throw new Error('SUPERMEMORY_API_KEY is required')

async function call(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as any
}

const step = process.argv[2]

if (step === 'ingest') {
  const map: Record<string, string> = {}
  const t0 = Date.now()
  for (const m of data.memories) {
    const r = await call('/v3/documents', { content: m.text, containerTag: TAG })
    map[r.id] = m.id
  }
  await Bun.write(MAP, JSON.stringify(map))
  console.log(`queued ${data.memories.length} in ${Date.now() - t0} ms`)
  for (;;) {
    const l = await call('/v3/documents/list', { limit: 200, containerTags: [TAG] })
    const counts: Record<string, number> = {}
    for (const d of l.memories ?? []) counts[d.status] = (counts[d.status] ?? 0) + 1
    const pending = Object.entries(counts).filter(([s]) => s !== 'done' && s !== 'failed').reduce((a, [, n]) => a + n, 0)
    console.log(`${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(counts))
    if (pending === 0) break
    await Bun.sleep(30_000)
  }
  console.log(`total ${(Date.now() - t0) / 1000}s · ${((Date.now() - t0) / data.memories.length / 1000).toFixed(1)} s/รายการ`)
}

if (step === 'measure') {
  const map = (await Bun.file(MAP).json()) as Record<string, string>
  const queries = data.queries as Q[]
  const modes = {
    'v4 hybrid (ความจำ + เนื้อหา)': async (q: string): Promise<Ranked> => {
      const r = await call('/v4/search', { q, containerTag: TAG, limit: 10, searchMode: 'hybrid', threshold: 0, include: { documents: true } })
      const out: Ranked = []
      for (const it of r.results ?? []) {
        const docId = it.documents?.[0]?.id ?? it.documentId
        const id = map[docId]
        if (id && !out.some((x) => x.id === id)) out.push({ id, score: it.similarity ?? 0 })
      }
      return out
    },
    'v3 ค้นเนื้อหาเอกสาร': async (q: string): Promise<Ranked> => {
      const r = await call('/v3/search', { q, containerTags: [TAG], limit: 10, chunkThreshold: 0, documentThreshold: 0 })
      return (r.results ?? []).map((it: any) => ({ id: map[it.documentId]!, score: it.score ?? 0 })).filter((x: any) => x.id)
    },
  }
  for (const [name, fn] of Object.entries(modes)) {
    const raw = new Map<string, Ranked>()
    const lat: number[] = []
    for (const q of queries) {
      const t = Date.now()
      raw.set(q.q, await fn(q.q))
      lat.push(Date.now() - t)
    }
    const at = (th: number) => (q: Q) => raw.get(q.q)!.filter((h) => h.score >= th)
    const { tune, holdout } = split(queries)
    let best = { th: 0, combined: -1 }
    for (let th = 0; th <= 1.0001; th += 0.01) {
      const c = measure(tune, at(th)).combined
      if (c > best.combined) best = { th, combined: c }
    }
    console.log(`\n=== supermemory · ${name} · ค้นเฉลี่ย ${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(0)} ms`)
    report('holdout ไม่ตั้งเกณฑ์ (พฤติกรรมตั้งต้น)', holdout, at(0))
    console.log(`เกณฑ์คะแนนที่ดีที่สุดบน tune: ${best.th.toFixed(2)}`)
    report('holdout ใช้เกณฑ์', holdout, at(best.th), process.argv.includes('--misses'))
  }
}
process.exit(0)
