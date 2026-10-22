// ส่งออกทุกสมองจากเซิร์ฟเวอร์ในเครื่อง (ค่าเริ่มต้น http://127.0.0.1:6800) เป็น <brain>.json.gz พร้อม counts.json
// รันจากโฟลเดอร์ repo เพื่อให้ bun อ่าน key จาก .env เอง (key ไม่ถูกพิมพ์ออกมา):
//   bun aws-deploy/export-local.ts <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs'

const out = process.argv[2]
if (!out) throw new Error('usage: bun aws-deploy/export-local.ts <out-dir>')
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
for (const b of (await get('/v1/overview')).brains as { brain: string; live: number }[]) {
  const data = await get(`/v1/export?brain=${encodeURIComponent(b.brain)}`)
  writeFileSync(`${out}/${b.brain}.json.gz`, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(data))))
  counts[b.brain] = data.memories.length
  console.log(`${b.brain}: ${data.memories.length} (overview live ${b.live})`)
}
writeFileSync(`${out}/counts.json`, JSON.stringify(counts, null, 1))
