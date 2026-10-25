// ความสามารถของ MemoryStore: ประวัติ/ย้อนเวลา, RRF + explain, ลดน้ำหนักเหตุการณ์ตามอายุ, บริบทตั้งต้น · ต้องมี seekdb รันอยู่
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { localEmbedder } from '../src/embed'
import { MemoryStore, recencyDecay } from '../src/memory'

const B = 'feat_brain'
let store: MemoryStore
const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 10)

beforeAll(async () => {
  store = await MemoryStore.open(localEmbedder, { database: 'panya_test', collection: 'memories_features_test' })
  await store.clear(B)
  // ราคาเปลี่ยนสามครั้ง: ม.ค. → ก.พ. → มี.ค.
  await store.remember({ container: B, text: 'ค่าส่งด่วนกรุงเทพ 120 บาท', subject: 'price:express-bkk', attribute: 'amount', now: T0 })
  await store.remember({ container: B, text: 'ค่าส่งด่วนกรุงเทพ 150 บาท', subject: 'price:express-bkk', attribute: 'amount', now: T0 + 30 * DAY })
  await store.remember({ container: B, text: 'ค่าส่งด่วนกรุงเทพ 180 บาท', subject: 'price:express-bkk', attribute: 'amount', now: T0 + 60 * DAY })
  await store.remember({ container: B, text: 'ลูกค้าชอบให้ส่งช่วงเช้าก่อนสิบโมง', kind: 'preference', now: T0 + 5 * DAY })
  await store.remember({ container: B, text: 'รถส่งของคันที่ 7 ยางแตกที่บางนา', kind: 'event', now: T0 + 61 * DAY })
}, 120_000)

afterAll(async () => {
  await store.clear(B)
  await store.close()
})

describe('ประวัติและการค้นย้อนเวลา', () => {
  test('ค่าปัจจุบันคือรุ่นล่าสุด', async () => {
    const r = await store.search(B, 'ค่าส่งด่วนกรุงเทพเท่าไร', { now: T0 + 70 * DAY })
    expect(r.hits[0]!.text).toBe('ค่าส่งด่วนกรุงเทพ 180 บาท')
    expect(r.hits.filter((h) => h.text.startsWith('ค่าส่งด่วน'))).toHaveLength(1)
  })

  test('asOf คืนค่าที่ใช้อยู่ ณ เวลานั้น', async () => {
    const feb = await store.search(B, 'ค่าส่งด่วนกรุงเทพเท่าไร', { asOf: T0 + 40 * DAY })
    expect(feb.hits[0]!.text).toBe('ค่าส่งด่วนกรุงเทพ 150 บาท')
    const jan = await store.search(B, 'ค่าส่งด่วนกรุงเทพเท่าไร', { asOf: T0 + 1 * DAY })
    expect(jan.hits[0]!.text).toBe('ค่าส่งด่วนกรุงเทพ 120 บาท')
    // ก่อนมีข้อมูลใดเลย: ไม่รู้
    const before = await store.search(B, 'ค่าส่งด่วนกรุงเทพเท่าไร', { asOf: T0 - DAY })
    expect(before.abstained).toBe(true)
  })

  test('includeSuperseded คืนทุกรุ่น และรุ่นเก่ามี invalidAt', async () => {
    const r = await store.search(B, 'ค่าส่งด่วนกรุงเทพ', { includeSuperseded: true, limit: 10, now: T0 + 70 * DAY })
    const prices = r.hits.filter((h) => h.text.startsWith('ค่าส่งด่วน'))
    expect(prices).toHaveLength(3)
    const old = prices.find((h) => h.text.includes('120'))!
    expect(old.active).toBe(false)
    expect(old.invalidAt).toBe(T0 + 30 * DAY)
  })

  test('history เรียงใหม่สุดก่อน', async () => {
    const h = await store.history(B, 'price:express-bkk', 'amount')
    expect(h.map((m) => m.text)).toEqual(['ค่าส่งด่วนกรุงเทพ 180 บาท', 'ค่าส่งด่วนกรุงเทพ 150 บาท', 'ค่าส่งด่วนกรุงเทพ 120 บาท'])
  })
})

describe('explain และ RRF', () => {
  test('explain แนบคะแนนแยกส่วน', async () => {
    const r = await store.search(B, 'ค่าส่งด่วนกรุงเทพ', { explain: true, now: T0 + 70 * DAY })
    const e = r.hits[0]!.explain!
    expect(e.denseRank).toBeGreaterThan(0)
    expect(e.weighted).toBeCloseTo(r.hits[0]!.score, 3)
    expect(e.rrf).toBeGreaterThan(0)
    expect(e.fusion).toBe('weighted')
  })

  test('fusion=rrf ให้ผลที่ผ่านเกณฑ์ชุดเดียวกัน (เกณฑ์ไม่รู้ไม่เปลี่ยน)', async () => {
    const q = 'ลูกค้าอยากได้ของช่วงไหน'
    const w = await store.search(B, q, { now: T0 + 70 * DAY })
    const r = await store.search(B, q, { now: T0 + 70 * DAY, tuning: { fusion: 'rrf' } })
    expect(new Set(r.hits.map((h) => h.id))).toEqual(new Set(w.hits.map((h) => h.id)))
    expect(r.abstained).toBe(w.abstained)
  })

  test('ไม่ขอ explain ไม่มีฟิลด์ explain', async () => {
    const r = await store.search(B, 'ค่าส่งด่วนกรุงเทพ', { now: T0 + 70 * DAY })
    expect(r.hits[0]!.explain).toBeUndefined()
  })
})

describe('ลดน้ำหนักเหตุการณ์ตามอายุ', () => {
  test('เหตุการณ์ลดครึ่งทุก halfLife วัน ข้อเท็จจริงไม่ลด', () => {
    const now = T0 + 90 * DAY
    expect(recencyDecay({ kind: 'event', lastSeenAt: T0, createdAt: T0 }, now, 90)).toBeCloseTo(0.5, 5)
    expect(recencyDecay({ kind: 'event', lastSeenAt: now, createdAt: now }, now, 90)).toBe(1)
    expect(recencyDecay({ kind: 'fact', lastSeenAt: T0, createdAt: T0 }, now, 90)).toBe(1)
    expect(recencyDecay({ kind: 'event', lastSeenAt: T0, createdAt: T0 }, now, 0)).toBe(1)
  })

  test('decay ปรากฏใน explain ของเหตุการณ์เก่า', async () => {
    const r = await store.search(B, 'รถส่งของยางแตก', { explain: true, now: T0 + 61 * DAY + 180 * DAY })
    expect(r.hits[0]!.kind).toBe('event')
    expect(r.hits[0]!.explain!.decay).toBeCloseTo(0.25, 2)
  })
})

describe('บริบทตั้งต้น', () => {
  test('current = ค่าปัจจุบันของคีย์, preferences, recent ไม่ซ้ำกัน', async () => {
    const c = await store.context(B, { now: T0 + 62 * DAY, days: 30 })
    expect(c.current.map((m) => m.text)).toEqual(['ค่าส่งด่วนกรุงเทพ 180 บาท'])
    expect(c.preferences.map((m) => m.text)).toEqual(['ลูกค้าชอบให้ส่งช่วงเช้าก่อนสิบโมง'])
    expect(c.recent.map((m) => m.text)).toEqual(['รถส่งของคันที่ 7 ยางแตกที่บางนา'])
  })

  test('days สั้นลง recent ว่าง', async () => {
    const c = await store.context(B, { now: T0 + 200 * DAY, days: 7 })
    expect(c.recent).toHaveLength(0)
    expect(c.current).toHaveLength(1)
  })
})
