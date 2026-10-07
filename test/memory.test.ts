// เทสต์รวม: ต้องมี seekdb รันอยู่ (bun run db:up) ใช้โมเดล embedding จริง
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { localEmbedder } from '../src/embed'
import { MemoryStore } from '../src/memory'

const A = 'test_tenant_a'
const B = 'test_tenant_b'
const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 6)
let store: MemoryStore

beforeAll(async () => {
  store = await MemoryStore.open(localEmbedder, { collection: 'memories_test' })
  await store.clear(A)
  await store.clear(B)
  await store.remember({ container: A, text: 'ผู้ขนส่ง สยามโลจิสติกส์ มาสายเกิน 45 นาที ติดต่อกัน 3 วัน ที่ท่า D-04 ช่วงเช้า', now: T0 })
  await store.remember({ container: A, text: 'รถทะเบียน 70-1234 ถูกปฏิเสธที่ประตูเพราะเอกสารวัตถุอันตรายไม่ครบ', now: T0 })
  await store.remember({ container: A, text: 'ผู้จัดการคลังต้องการรายงานสรุปทุกเช้าเป็นตาราง', kind: 'preference', now: T0 })
  await store.remember({ container: B, text: 'ผู้ขนส่ง บางนาทรานสปอร์ต ลานจอดแน่นทุกบ่ายวันศุกร์', now: T0 })
}, 120_000)

afterAll(async () => {
  await store.clear(A)
  await store.clear(B)
  await store.close()
})

describe('search', () => {
  test('เก็บข้อความตามต้นฉบับทุกตัวอักษร', async () => {
    const r = await store.search(A, 'ผู้ขนส่งมาสาย', { now: T0 })
    expect(r.hits[0]?.text).toBe('ผู้ขนส่ง สยามโลจิสติกส์ มาสายเกิน 45 นาที ติดต่อกัน 3 วัน ที่ท่า D-04 ช่วงเช้า')
  })

  test('ค้นด้วยรหัสตรงตัว', async () => {
    const r = await store.search(A, 'ทะเบียน 70-1234', { now: T0 })
    expect(r.hits[0]?.text).toContain('70-1234')
  })

  test('ไม่ข้าม container', async () => {
    const a = await store.search(A, 'บางนาทรานสปอร์ต ลานจอดแน่น', { now: T0 })
    expect(a.hits.some((h) => h.text.includes('บางนา'))).toBe(false)
    const b = await store.search(B, 'สยามโลจิสติกส์ มาสาย', { now: T0 })
    expect(b.hits.some((h) => h.text.includes('สยาม'))).toBe(false)
  })

  test('คำถามนอกเรื่องต้องไม่ได้คำตอบ', async () => {
    const r = await store.search(A, 'คะแนนฟุตบอลเมื่อคืน', { now: T0 })
    expect(r.abstained).toBe(true)
    expect(r.hits).toEqual([])
  })
})

describe('ข้อเท็จจริงที่มีคีย์', () => {
  test('รุ่นใหม่แทนรุ่นเก่า และยังดูประวัติได้', async () => {
    const k = { container: A, subject: 'carrier:สยามโลจิสติกส์', attribute: 'coordinator' }
    await store.remember({ ...k, text: 'ผู้ประสานงานของสยามโลจิสติกส์คือคุณสมศักดิ์', now: T0 })
    const second = await store.remember({ ...k, text: 'ผู้ประสานงานของสยามโลจิสติกส์คือคุณวิภา', now: T0 + DAY })
    expect(second.action).toBe('superseded')

    const r = await store.search(A, 'ผู้ประสานงานของสยามโลจิสติกส์คือใคร', { now: T0 + DAY })
    expect(r.hits[0]?.text).toContain('คุณวิภา')
    expect(r.hits.some((h) => h.text.includes('คุณสมศักดิ์'))).toBe(false)

    const h = await store.history(A, k.subject, k.attribute)
    expect(h.map((m) => m.active)).toEqual([true, false])
    expect(h[1]?.supersededBy).toBe(second.memory.id)
  })

  test('หมดอายุแล้วค้นไม่เจอ', async () => {
    await store.remember({
      container: A, subject: 'dock:D-02', attribute: 'status',
      text: 'ท่า D-02 ปิดซ่อมแผ่นปรับระดับ', validUntil: T0 + 2 * DAY, now: T0,
    })
    const before = await store.search(A, 'ท่า D-02 ปิดซ่อม', { now: T0 + DAY })
    expect(before.hits[0]?.text).toContain('D-02')
    const after = await store.search(A, 'ท่า D-02 ปิดซ่อม', { now: T0 + 3 * DAY })
    expect(after.hits.some((h) => h.text.includes('D-02'))).toBe(false)
  })
})

describe('ของซ้ำและโปรไฟล์', () => {
  test('ข้อความเดิมซ้ำถูกรวมและนับเพิ่ม', async () => {
    const r = await store.remember({ container: A, text: 'รถทะเบียน 70-1234 ถูกปฏิเสธที่ประตูเพราะเอกสารวัตถุอันตรายไม่ครบ', now: T0 + DAY })
    expect(r.action).toBe('merged')
    expect(r.memory.count).toBe(2)
  })

  test('โปรไฟล์แยกความชอบ ข้อเท็จจริงมีคีย์ และรายการล่าสุด', async () => {
    const p = await store.profile(A, { now: T0 + DAY })
    expect(p.preferences.map((m) => m.text)).toEqual(['ผู้จัดการคลังต้องการรายงานสรุปทุกเช้าเป็นตาราง'])
    expect(p.keyed.some((m) => m.text.includes('คุณวิภา'))).toBe(true)
    expect(p.recent.some((m) => m.text.includes('70-1234'))).toBe(true)
  })

  test('ลบข้าม container ไม่ได้', async () => {
    const r = await store.search(B, 'บางนาทรานสปอร์ต ลานจอด', { now: T0 })
    const id = r.hits[0]!.id
    expect(await store.forget(A, id)).toBe(false)
    expect(await store.forget(B, id)).toBe(true)
  })
})

describe('ชื่อเฉพาะ', () => {
  const C = 'test_tenant_entities'
  beforeAll(async () => {
    await store.clear(C)
    await store.entities.register(C, 'customer', ['ลูกค้า'], ['ไทยฟู้ดส์', 'เมดิแคร์ซัพพลาย'])
    await store.remember({ container: C, text: 'ลูกค้า ไทยฟู้ดส์ ขอให้ขึ้นของเสร็จก่อนเที่ยงทุกวันจันทร์', now: T0 })
    await store.remember({ container: C, text: 'ลูกค้า เมดิแคร์ซัพพลาย ต้องการเอกสารส่งมอบพร้อมลายเซ็นทุกเที่ยว', now: T0 })
  })
  afterAll(() => store.clear(C))

  test('ถามถึงรายที่ไม่เคยเห็น ต้องไม่ได้ข้อมูลของรายอื่น', async () => {
    const r = await store.search(C, 'ลูกค้า โกลบอลเทรด ต้องการอะไร', { now: T0 })
    expect(r.abstained).toBe(true)
    expect(r.reason).toBe('unknown_entity')
  })

  test('ถามถึงรายที่รู้จัก ได้เฉพาะความจำของรายนั้น', async () => {
    const r = await store.search(C, 'ลูกค้า เมดิแคร์ซัพพลาย ต้องการอะไร', { now: T0 })
    expect(r.hits.length).toBe(1)
    expect(r.hits[0]?.text).toContain('เมดิแคร์ซัพพลาย')
  })

  test('คำนำหน้าที่ตามด้วยคำทั่วไปไม่ถูกมองเป็นชื่อ', async () => {
    const r = await store.search(C, 'ลูกค้าต้องการเอกสารอะไร', { now: T0 })
    expect(r.reason).not.toBe('unknown_entity')
    expect(r.hits[0]?.text).toContain('เอกสารส่งมอบ')
  })

  test('subject แบบ type:name ลงทะเบียนชื่อให้เอง', async () => {
    await store.remember({ container: C, subject: 'carrier:อีสานเฟรท', attribute: 'fleet', text: 'อีสานเฟรท ใช้รถพ่วง 18 ล้อ', now: T0 })
    const types = await store.entities.list(C)
    expect(types.find((t) => t.type === 'carrier')?.names).toEqual(['อีสานเฟรท'])
  })
})
