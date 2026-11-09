// ผู้คุมสมองรอบย้อนหลัง: ติดป้ายหมวดปัญญา 3 ให้ความจำที่ยังไม่มีป้าย หรือมีแต่ป้ายที่ระบบเดาไว้
//   bun scripts/govern.ts <brain> [--mode ollama|proto] [--model qwen3:4b-instruct] [--limit N] [--dry-run]
// ป้ายที่ผู้ใช้ระบุเอง (panyaBy = user) ไม่ถูกแตะ · ป้ายจาก llm ไม่ถูกทับด้วย proto
// ต่อฐานข้อมูลตาม .env โดยตรง (ใช้บนเครื่องที่รัน panya) · ไม่แก้ข้อความของความจำ แก้แค่ป้าย
import { localEmbedder } from '../src/embed'
import { config } from '../src/config'
import { MemoryStore } from '../src/memory'
import { OllamaGovernor, PrototypeGovernor, type Governor } from '../src/governor'

const argv = process.argv.slice(2)
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const brain = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
if (!brain) {
  console.error('usage: bun scripts/govern.ts <brain> [--mode ollama|proto] [--model name] [--limit N] [--dry-run]')
  process.exit(2)
}
const mode = flag('--mode') ?? (config.governor.mode === 'ollama' ? 'ollama' : 'proto')
const limit = Number(flag('--limit') ?? Infinity)
const dry = argv.includes('--dry-run')

const proto = new PrototypeGovernor(localEmbedder)
const gov: Governor = mode === 'ollama' ? new OllamaGovernor(proto, config.governor.ollamaUrl, flag('--model') ?? config.governor.model) : proto
const store = await MemoryStore.open(localEmbedder)
const todo = (await store.exportAll(brain))
  .filter((m) => m.panyaBy === '' || (mode === 'ollama' && m.panyaBy === 'proto'))
  .slice(0, limit)
console.log(`${brain}: ${todo.length} รายการรอติดป้าย · ผู้คุมสมอง ${gov.name}${dry ? ' · dry-run' : ''}`)

const counts = { suta: 0, cinta: 0, bhavana: 0, changed: 0, fallback: 0 }
const t0 = performance.now()
for (let i = 0; i < todo.length; i++) {
  const m = todo[i]!
  const [v] = await gov.classify([m.text])
  counts[v!.panya]++
  if (mode === 'ollama' && v!.by === 'proto') counts.fallback++
  if (v!.panya !== m.panya) counts.changed++
  if (!dry) await store.setPanya(brain, m.id, v!.panya, v!.by, v!.confidence)
  if ((i + 1) % 20 === 0 || i === todo.length - 1) {
    const rate = (performance.now() - t0) / (i + 1)
    process.stdout.write(`\r${i + 1}/${todo.length} · ${rate.toFixed(0)} ms/รายการ · เหลือราว ${Math.round(((todo.length - i - 1) * rate) / 60000)} นาที   `)
  }
}
console.log(`\nสุตมย ${counts.suta} · จินตมย ${counts.cinta} · ภาวนามย ${counts.bhavana} · ป้ายเปลี่ยน ${counts.changed}` +
  (counts.fallback ? ` · Ollama ล้มแล้วใช้ proto แทน ${counts.fallback}` : ''))
await store.close()
process.exit(0)
