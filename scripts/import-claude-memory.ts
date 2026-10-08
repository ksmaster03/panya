// นำไฟล์ความจำของ Claude Code เข้า panya
//   bun scripts/import-claude-memory.ts [โฟลเดอร์ ...] [--brain claude-memory] [--dry] [--no-redact]
// ไม่ระบุโฟลเดอร์ = ทุก ~/.claude/projects/*/memory
// รันซ้ำได้: ความจำเดิมของไฟล์เดียวกันถูกลบก่อนแล้วใส่ใหม่ ไฟล์ MEMORY.md (ดัชนี) ถูกข้าม
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { localEmbedder } from '../src/embed'
import { chunk, kindOf, parseMemoryFile, redact } from '../src/import-md'
import { MemoryStore, type RememberInput } from '../src/memory'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string, d: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1]! : d }
const container = opt('--brain', opt('--container', 'claude-memory'))
const dry = flag('--dry')
const doRedact = !flag('--no-redact')
let dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--container' && args[i - 1] !== '--brain')

if (!dirs.length) {
  const root = join(homedir(), '.claude', 'projects')
  for (const p of await readdir(root).catch(() => [])) dirs.push(join(root, p, 'memory'))
}

const inputs: RememberInput[] = []
const sources: string[] = []
let files = 0, redactions = 0
for (const dir of dirs) {
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
  // ชื่อโปรเจกต์ = โฟลเดอร์ที่ครอบ memory อยู่
  const project = basename(join(dir, '..'))
  for (const file of names) {
    const parsed = parseMemoryFile(await Bun.file(join(dir, file)).text(), file.replace(/\.md$/, ''))
    const source = `${project}/${file}`
    const subject = `claude-memory/${project}/${parsed.name}`
    const parts = [parsed.description, ...chunk(parsed.body)].filter(Boolean)
    if (!parts.length) continue
    files++
    sources.push(source)
    parts.forEach((raw, i) => {
      const r = doRedact ? redact(raw) : { text: raw, count: 0 }
      redactions += r.count
      inputs.push({ container, text: r.text.slice(0, 2000), subject, attribute: i === 0 && parsed.description ? 'description' : `p${i}`, kind: kindOf(parsed.type), source })
    })
  }
}

console.log(`พบ ${files} ไฟล์ จาก ${dirs.length} โฟลเดอร์ · ${inputs.length} ความจำ · ปิดข้อมูลลับ ${redactions} จุด · brain "${container}"`)
if (dry) {
  console.log('โหมด --dry: ไม่ได้บันทึกอะไร')
  process.exit(0)
}
if (!inputs.length) process.exit(0)

const store = await MemoryStore.open(localEmbedder)
const t0 = Date.now()
for (const s of sources) await store.forgetSource(container, s)
for (let i = 0; i < inputs.length; i += 100) {
  await store.rememberMany(inputs.slice(i, i + 100))
  process.stdout.write(`\rบันทึกแล้ว ${Math.min(i + 100, inputs.length)}/${inputs.length}`)
}
console.log(`\nเสร็จใน ${((Date.now() - t0) / 1000).toFixed(1)} วินาที · เปิดดูที่ /brain ด้วย brain "${container}"`)
await store.close()
process.exit(0)
