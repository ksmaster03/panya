// ส่งออกเฉพาะความจำที่สร้างหลังเวลาที่กำหนด จากเซิร์ฟเวอร์ในเครื่อง (ใช้ย้ายส่วนที่เพิ่มหลังย้ายรอบแรก)
//   bun aws-deploy/export-delta.ts <out-dir> <ISO cutoff>   (รันจากโฟลเดอร์ repo ให้ bun อ่าน key จาก .env)
import { mkdirSync, writeFileSync } from 'node:fs'

const [out, since] = process.argv.slice(2)
const cutoff = Date.parse(since ?? '')
if (!out || !Number.isFinite(cutoff)) throw new Error('usage: bun aws-deploy/export-delta.ts <out-dir> <ISO cutoff>')
const base = process.env.PANYA_URL ?? 'http://127.0.0.1:6800'
const key = (process.env.PANYA_API_KEYS ?? '').split(',').map((s) => s.trim()).find((k) => k && !k.includes('@'))
if (!key) throw new Error('no unbound key in PANYA_API_KEYS')
const get = async (path: string) => {
  const r = await fetch(base + path, { headers: { authorization: `Bearer ${key}` } })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json() as Promise<any>
}

mkdirSync(out, { recursive: true })
const counts: Record<string, number> = {}
for (const b of (await get('/v1/overview')).brains as { brain: string }[]) {
  const data = await get(`/v1/export?brain=${encodeURIComponent(b.brain)}`)
  const fresh = data.memories.filter((m: any) => m.createdAt > cutoff)
  if (!fresh.length) continue
  writeFileSync(`${out}/${b.brain}.json.gz`, Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ ...data, memories: fresh }))))
  counts[b.brain] = fresh.length
  console.log(`${b.brain}: ${fresh.length} new since ${new Date(cutoff).toISOString()}`)
}
writeFileSync(`${out}/counts.json`, JSON.stringify(counts, null, 1))
