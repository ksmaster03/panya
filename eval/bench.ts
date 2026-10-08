// วัดความเร็ว: bun eval/bench.ts
import { localEmbedder } from '../src/embed'
import { config } from '../src/config'
import { MemoryStore } from '../src/memory'
import data from './dataset.json'

const C = 'bench'
const stat = (name: string, xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!
  console.log(`${name.padEnd(26)} เฉลี่ย ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1).padStart(6)} ms · p50 ${p(0.5).toFixed(1).padStart(6)} · p95 ${p(0.95).toFixed(1).padStart(6)} · n=${s.length}`)
}
const time = async <T>(fn: () => Promise<T>) => { const t = performance.now(); await fn(); return performance.now() - t }

const store = await MemoryStore.open(localEmbedder, { collection: `memories_bench_${config.embed.dimension}` })
await store.clear(C)
await localEmbedder.query('warmup')

const writes: number[] = []
for (const m of data.memories) writes.push(await time(() => store.remember({ container: C, text: m.text })))
stat('บันทึกทีละรายการ', writes)

if ('rememberMany' in store) {
  await store.clear(C)
  const t = await time(() => (store as any).rememberMany(data.memories.map((m) => ({ container: C, text: m.text }))))
  console.log(`${'บันทึกเป็นชุด'.padEnd(26)} เฉลี่ย ${(t / data.memories.length).toFixed(1).padStart(6)} ms ต่อรายการ (รวม ${t.toFixed(0)} ms)`)
}
for (const e of data.entities) await store.entities.register(C, e.type, e.cues, e.names)

const qs = data.queries.map((q) => q.q)
const embedOnly: number[] = []
for (const q of qs) embedOnly.push(await time(() => localEmbedder.query(q + ' ')))
stat('embedding คำค้นอย่างเดียว', embedOnly)

const first: number[] = []
for (const q of qs) first.push(await time(() => store.search(C, q)))
stat('ค้น (คำค้นใหม่)', first)
const again: number[] = []
for (const q of qs) again.push(await time(() => store.search(C, q)))
stat('ค้น (คำค้นซ้ำ)', again)

const t = performance.now()
await Promise.all(qs.map((q) => store.search(C, q)))
const wall = performance.now() - t
console.log(`${'ค้นพร้อมกัน 120 คำค้น'.padEnd(26)} รวม ${wall.toFixed(0)} ms · ${(qs.length / (wall / 1000)).toFixed(0)} คำค้น/วินาที`)

await store.clear(C)
await store.close()
process.exit(0)
