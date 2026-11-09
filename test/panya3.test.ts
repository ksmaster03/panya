// หมวดปัญญา 3 และผู้คุมสมอง: ติดป้ายตอนบันทึก, ป้ายของผู้ใช้ชนะ, กรองตอนค้น, แก้ป้าย, ส่งออก/นำเข้า · ต้องมี seekdb รันอยู่
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { localEmbedder } from '../src/embed'
import { OllamaGovernor, PrototypeGovernor, isPanya, type Governor } from '../src/governor'
import { MemoryStore } from '../src/memory'
import { createApp } from '../src/server'

const B = 'p3_brain'
const B2 = 'p3_copy'
const KEY = 'p3-machine-key'
let store: MemoryStore
let app: ReturnType<typeof createApp>

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: body ? JSON.stringify(body) : undefined })
const json = async (r: Response) => (await r.json()) as any

beforeAll(async () => {
  store = await MemoryStore.open(localEmbedder, { database: 'panya_test', collection: 'memories_panya3_test', labeler: new PrototypeGovernor(localEmbedder) })
  await store.clear(B); await store.clear(B2)
  app = createApp(store, [KEY], { publicDashboard: 'off' })
}, 120_000)

afterAll(async () => {
  await store.clear(B); await store.clear(B2)
  await store.close()
})

describe('ติดป้ายตอนบันทึก', () => {
  test('ไม่ระบุหมวด: ผู้คุมสมองติดป้ายให้ พร้อมที่มาและความมั่นใจ', async () => {
    const r = await store.remember({ container: B, text: 'บทเรียน: ลองย้ายของโดยไม่ติดป้ายตำแหน่งก่อน ของหายเยอะมาก' })
    expect(r.memory.panya).toBe('bhavana')
    expect(r.memory.panyaBy).toBe('proto')
    expect(r.memory.panyaConf).toBeGreaterThan(0)
    expect(r.memory.panyaConf).toBeLessThanOrEqual(1)
  })

  test('ระบุหมวดเอง: ใช้ตามนั้น ความมั่นใจ 1', async () => {
    const r = await store.remember({ container: B, text: 'คู่มือระบุว่าเครื่องพิมพ์ฉลากรองรับกระดาษกว้างสูงสุด 4 นิ้ว', panya: 'cinta' })
    expect(r.memory).toMatchObject({ panya: 'cinta', panyaBy: 'user', panyaConf: 1 })
  })

  test('บันทึกเป็นชุด: แต่ละรายการได้ป้าย ลำดับตรงกับที่ส่ง', async () => {
    const rs = await store.rememberMany([
      { container: B, text: 'เราตัดสินใจย้ายรอบส่งของไปช่วงบ่าย เพราะเช้ารถติดมาก' },
      { container: B, text: 'ฝ่ายบุคคลแจ้งว่าวันหยุดชดเชยปีนี้คือวันที่ 2 มกราคม', panya: 'suta' },
    ])
    expect(rs[0]!.memory.panya).toBe('cinta')
    expect(rs[1]!.memory).toMatchObject({ panya: 'suta', panyaBy: 'user' })
  })

  test('ข้อความซ้ำที่ส่งมาพร้อมหมวด: ป้ายของผู้ใช้ทับป้ายที่ระบบเดา', async () => {
    const text = 'ทีมคลังซ้อมดับเพลิงเดือนละครั้งที่ลานจอดรถด้านหลัง'
    const first = await store.remember({ container: B, text })
    expect(first.memory.panyaBy).toBe('proto')
    const again = await store.remember({ container: B, text, panya: 'bhavana' })
    expect(again.action).toBe('merged')
    expect(again.memory).toMatchObject({ panya: 'bhavana', panyaBy: 'user' })
  })
})

describe('ค้นและแก้ป้าย', () => {
  test('กรองตามหมวด: ค้นคำเดียวกันได้ผลเฉพาะหมวดที่ขอ', async () => {
    await store.remember({ container: B, text: 'ผู้ขายแจ้งว่าสายพานลำเลียงรุ่น X2 รับน้ำหนักได้ 50 กิโลต่อเมตร', panya: 'suta' })
    await store.remember({ container: B, text: 'ใช้สายพานลำเลียงรุ่น X2 มาหกเดือน พบว่าควรหยอดน้ำมันทุกสองสัปดาห์ ไม่งั้นเสียงดัง', panya: 'bhavana' })
    const all = await store.search(B, 'สายพานลำเลียงรุ่น X2', { limit: 10 })
    expect(new Set(all.hits.map((h) => h.panya))).toEqual(new Set(['suta', 'bhavana']))
    const doing = await store.search(B, 'สายพานลำเลียงรุ่น X2', { limit: 10, panya: ['bhavana'] })
    expect(doing.hits.length).toBeGreaterThan(0)
    expect(doing.hits.every((h) => h.panya === 'bhavana')).toBe(true)
    const none = await store.search(B, 'สายพานลำเลียงรุ่น X2', { panya: ['cinta'] })
    expect(none.hits.every((h) => h.panya === 'cinta')).toBe(true)
  })

  test('API: ค้นด้วย panya ค่าเดียวหรือหลายค่า และปฏิเสธค่าที่ไม่รู้จัก', async () => {
    const one = await json(await call('POST', '/v1/search', { brain: B, q: 'สายพานลำเลียงรุ่น X2', panya: 'suta', limit: 10 }))
    expect(one.hits.length).toBeGreaterThan(0)
    expect(one.hits.every((h: any) => h.panya === 'suta')).toBe(true)
    const two = await json(await call('POST', '/v1/search', { brain: B, q: 'สายพานลำเลียงรุ่น X2', panya: ['suta', 'bhavana'], limit: 10 }))
    expect(two.hits.length).toBe(2)
    expect((await call('POST', '/v1/search', { brain: B, q: 'x', panya: 'wisdom' })).status).toBe(400)
  })

  test('API: บันทึกด้วยหมวดที่ไม่รู้จักถูกปฏิเสธ', async () => {
    const r = await call('POST', '/v1/memories', { brain: B, text: 'ทดสอบหมวดผิด', panya: 'prajna' })
    expect(r.status).toBe(400)
  })

  test('PATCH แก้ป้ายเป็นของผู้ใช้ และล้างป้ายได้', async () => {
    const m = (await store.remember({ container: B, text: 'ประชุมทีมสรุปว่าจะเลิกใช้ไฟล์ Excel คุมสต็อกภายในปีนี้' })).memory
    const fixed = await json(await call('PATCH', `/v1/memories/${m.id}`, { brain: B, panya: 'cinta' }))
    expect(fixed.memory).toMatchObject({ panya: 'cinta', panyaBy: 'user', panyaConf: 1 })
    const cleared = await json(await call('PATCH', `/v1/memories/${m.id}`, { brain: B, panya: '' }))
    expect(cleared.memory).toMatchObject({ panya: '', panyaBy: '' })
    expect((await call('PATCH', `/v1/memories/${m.id}`, { brain: B, panya: 'x' })).status).toBe(400)
    // id ของ brain อื่นแก้ไม่ได้
    expect((await call('PATCH', `/v1/memories/${m.id}`, { brain: B2, panya: 'suta' })).status).toBe(404)
  })

  test('สถิติแยกตามหมวด', async () => {
    const s = (await store.overview()).find((x) => x.brain === B)!
    expect(s.panya.suta + s.panya.cinta + s.panya.bhavana + s.panya.none).toBe(s.live)
    expect(s.panya.bhavana).toBeGreaterThan(0)
  })
})

describe('ส่งออกและนำเข้า', () => {
  test('ป้ายและที่มาของป้ายถูกคงไว้', async () => {
    const exp = await json(await call('GET', `/v1/export?brain=${B}`))
    expect(exp.memories.every((m: any) => m.panya === '' || isPanya(m.panya))).toBe(true)
    const r = await call('POST', '/v1/import', { brain: B2, memories: exp.memories })
    expect(r.status).toBe(201)
    const back = await store.exportAll(B2)
    const src = new Map<string, any>(exp.memories.map((m: any) => [m.text, m]))
    for (const m of back) {
      const o = src.get(m.text)!
      // ป้ายที่ระบบเดาไว้ยังเป็นป้ายที่ระบบเดา ไม่กลายเป็นป้ายของผู้ใช้
      if (o.panyaBy === 'user' || o.panyaBy === 'llm') expect([m.panya, m.panyaBy]).toEqual([o.panya, o.panyaBy])
      if (o.panyaBy === 'proto') expect(m.panyaBy).toBe('proto')
    }
  })
})

describe('ผู้คุมสมองแบบ Ollama', () => {
  test('ล้มเมื่อไรใช้ตัวสำรองแทน ไม่ทำให้งานพัง', async () => {
    const backup: Governor = { name: 'backup', classify: async (t) => t.map(() => ({ panya: 'suta' as const, confidence: 0.5, by: 'proto' as const })) }
    // พอร์ตที่ไม่มีใครฟัง: ต่อไม่ได้ทันที
    const llm = new OllamaGovernor(backup, 'http://127.0.0.1:9', 'none', 2000)
    expect(await llm.classify(['อะไรก็ได้'])).toEqual([{ panya: 'suta', confidence: 0.5, by: 'proto' }])
  })
})

describe('เอกสารยาว /v1/documents', () => {
  const doc = '# คู่มือสาขา\n\n## บางนา\n### เวลาทำการ\nเปิด 06:00 ถึง 15:00\n\n## ลาดกระบัง\n### เวลาทำการ\nเปิด 08:00 ถึง 20:00'
  test('ตัดเป็นท่อนพร้อมหัวข้อ และค้นแยกสาขาได้', async () => {
    const r = await call('POST', '/v1/documents', { brain: B, text: doc, source: 'manual.md' })
    expect(r.status).toBe(201)
    expect((await json(r)).chunks).toBe(2)
    const hit = (await store.search(B, 'ลาดกระบังเปิดกี่โมง')).hits[0]!
    expect(hit.text).toContain('ลาดกระบัง › เวลาทำการ')
    expect(hit.text).toContain('08:00')
    expect(hit.ref).toBe('manual.md#1')
  })
  test('ส่ง source เดิมซ้ำ = แทนที่ชุดเก่า ไม่ซ้อน', async () => {
    await call('POST', '/v1/documents', { brain: B, text: doc.replace('06:00', '07:00'), source: 'manual.md' })
    const mine = (await store.exportAll(B)).filter((m) => m.source === 'manual.md')
    expect(mine).toHaveLength(2)
    expect(mine.some((m) => m.text.includes('07:00'))).toBe(true)
    expect(mine.some((m) => m.text.includes('06:00'))).toBe(false)
  })
  test('ต้องมี source และท่อนที่มีความลับทำให้ไม่บันทึกอะไรเลย', async () => {
    expect((await call('POST', '/v1/documents', { brain: B, text: doc })).status).toBe(400)
    const before = (await store.exportAll(B)).length
    const bad = await call('POST', '/v1/documents', { brain: B, text: doc + '\n\n## คีย์\nAKIAABCDEFGHIJKLMNOP', source: 'leak.md' })
    expect(bad.status).toBe(400)
    expect((await store.exportAll(B)).length).toBe(before)
  })
})
