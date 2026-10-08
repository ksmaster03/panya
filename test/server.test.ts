// เทสต์ API: ต้องมี seekdb รันอยู่
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { localEmbedder } from '../src/embed'
import { MemoryStore } from '../src/memory'
import { createApp } from '../src/server'

const A = 'api_tenant_a'
const B = 'api_tenant_b'
let store: MemoryStore
let app: ReturnType<typeof createApp>

const call = (method: string, path: string, key: string | null, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })

beforeAll(async () => {
  store = await MemoryStore.open(localEmbedder, { collection: 'memories_test' })
  await store.clear(A)
  await store.clear(B)
  app = createApp(store, ['admin-key', `a-key@${A}`])
}, 120_000)

afterAll(async () => {
  await store.clear(A)
  await store.clear(B)
  await store.close()
})

describe('auth', () => {
  test('ไม่มี key หรือ key ผิด = 401', async () => {
    expect((await call('POST', '/v1/search', null, { brain: A, q: 'x' })).status).toBe(401)
    expect((await call('POST', '/v1/search', 'wrong', { brain: A, q: 'x' })).status).toBe(401)
  })

  test('key ที่ผูก container เขียน อ่าน และลบของ container อื่นไม่ได้', async () => {
    const made = await call('POST', '/v1/memories', 'admin-key', { brain: B, text: 'ลานจอดของ tenant B แน่นทุกวันศุกร์' })
    expect(made.status).toBe(201)
    const id = ((await made.json()) as any).memory.id

    expect((await call('POST', '/v1/memories', 'a-key', { brain: B, text: 'x' })).status).toBe(403)
    expect((await call('POST', '/v1/search', 'a-key', { brain: B, q: 'ลานจอด' })).status).toBe(403)
    expect((await call('GET', `/v1/profile?brain=${B}`, 'a-key')).status).toBe(403)
    expect((await call('DELETE', `/v1/memories/${id}?brain=${B}`, 'a-key')).status).toBe(403)
    // อ้าง container ของตัวเองแต่ใช้ id ของคนอื่นก็ต้องลบไม่ได้
    expect((await call('DELETE', `/v1/memories/${id}?brain=${A}`, 'a-key')).status).toBe(404)
  })
})

describe('memories', () => {
  test('บันทึกแล้วค้นเจอ ผ่าน key ที่ผูก container', async () => {
    const r = await call('POST', '/v1/memories', 'a-key', {
      brain: A, text: 'ท่า D-07 ใช้ได้เฉพาะรถ 6 ล้อ', subject: 'dock:D-07', attribute: 'restriction',
    })
    expect(r.status).toBe(201)
    const s = (await (await call('POST', '/v1/search', 'a-key', { brain: A, q: 'ท่า D-07 รับรถแบบไหน' })).json()) as any
    expect(s.abstained).toBe(false)
    expect(s.hits[0].text).toBe('ท่า D-07 ใช้ได้เฉพาะรถ 6 ล้อ')
  })

  test('บันทึกเป็นชุด: รายการหลังทับรายการก่อนที่คีย์เดียวกัน', async () => {
    const r = await call('POST', '/v1/memories/batch', 'a-key', {
      brain: A,
      memories: [
        { text: 'รถยก FL-21 พร้อมใช้งาน', subject: 'forklift:FL-21', attribute: 'status' },
        { text: 'ลานจอดฝั่งตะวันออกปิดปรับปรุงพื้น' },
        { text: 'รถยก FL-21 ส่งซ่อมแบตเตอรี่', subject: 'forklift:FL-21', attribute: 'status' },
      ],
    })
    expect(r.status).toBe(201)
    const body = (await r.json()) as any
    expect(body.results.map((x: any) => x.action)).toEqual(['created', 'created', 'superseded'])
    const s = (await (await call('POST', '/v1/search', 'a-key', { brain: A, q: 'รถยก FL-21' })).json()) as any
    expect(s.hits.map((h: any) => h.text)).toEqual(['รถยก FL-21 ส่งซ่อมแบตเตอรี่'])
  })

  test('บันทึกเป็นชุด: มีรายการผิดรูปแบบ ต้องไม่บันทึกอะไรเลย', async () => {
    const r = await call('POST', '/v1/memories/batch', 'a-key', {
      brain: A, memories: [{ text: 'ประตู 9 เปิดเฉพาะวันเสาร์' }, { text: '' }],
    })
    expect(r.status).toBe(400)
    const s = (await (await call('POST', '/v1/search', 'a-key', { brain: A, q: 'ประตู 9 เปิดเฉพาะวันเสาร์' })).json()) as any
    expect(s.hits.some((h: any) => h.text.includes('ประตู 9'))).toBe(false)
    expect((await call('POST', '/v1/memories/batch', 'a-key', { brain: B, memories: [{ text: 'x' }] })).status).toBe(403)
  })

  test('ปฏิเสธข้อมูลที่ไม่ถูกรูปแบบ', async () => {
    expect((await call('POST', '/v1/memories', 'a-key', { brain: A, text: '   ' })).status).toBe(400)
    expect((await call('POST', '/v1/memories', 'a-key', { brain: A, text: 'x', kind: 'rumor' })).status).toBe(400)
    expect((await call('POST', '/v1/memories', 'a-key', { brain: A, text: 'x', validUntil: 'ไม่ใช่วันที่' })).status).toBe(400)
    expect((await call('POST', '/v1/memories', 'a-key', { brain: A, text: 'ก'.repeat(2001) })).status).toBe(400)
    expect((await call('POST', '/v1/search', 'a-key', { brain: A })).status).toBe(400)
  })
})

describe('นำข้อมูลเข้าออก', () => {
  const X = 'api_export_src'
  const Y = 'api_export_dst'
  beforeAll(async () => { await store.clear(X); await store.clear(Y) })
  afterAll(async () => { await store.clear(X); await store.clear(Y) })
  const json = async (r: Response | Promise<Response>) => (await (await r).json()) as any

  test('ส่งออกแล้วนำเข้าอีกสมองหนึ่ง ได้ข้อความ คีย์ รหัสอ้างอิง และชื่อเฉพาะครบ', async () => {
    await call('PUT', '/v1/entities', 'admin-key', { brain: X, type: 'customer', cues: ['ลูกค้า'], names: ['ไทยฟู้ดส์'] })
    await call('POST', '/v1/memories/batch', 'admin-key', {
      brain: X,
      memories: [
        { text: 'รถยก FL-30 พร้อมใช้งาน', subject: 'forklift:FL-30', attribute: 'status' },
        { text: 'รถยก FL-30 ส่งซ่อม', subject: 'forklift:FL-30', attribute: 'status', ref: 'row-77', source: 'fleet.csv' },
        { text: 'ลูกค้า ไทยฟู้ดส์ รับของเฉพาะช่วงเช้า', kind: 'preference' },
      ],
    })
    const exp = await call('GET', `/v1/export?brain=${X}`, 'admin-key')
    expect(exp.status).toBe(200)
    const data = await json(exp)
    expect(data.format).toBe('panya-export')
    // รุ่นที่ถูกแทนไม่อยู่ในไฟล์ส่งออกปกติ
    expect(data.memories.map((m: any) => m.text).sort()).toEqual(['รถยก FL-30 ส่งซ่อม', 'ลูกค้า ไทยฟู้ดส์ รับของเฉพาะช่วงเช้า'].sort())

    const imp = await call('POST', '/v1/import', 'admin-key', { ...data, brain: Y })
    expect(imp.status).toBe(201)
    expect((await json(imp)).imported).toBe(2)

    const s = await json(call('POST', '/v1/search', 'admin-key', { brain: Y, q: 'รถยก FL-30' }))
    expect(s.hits[0].text).toBe('รถยก FL-30 ส่งซ่อม')
    expect(s.hits[0].ref).toBe('row-77')
    expect(s.hits[0].brain).toBe(Y)
    const ents = await json(call('GET', `/v1/entities?brain=${Y}`, 'admin-key'))
    expect(ents.types.find((t: any) => t.type === 'customer').names).toEqual(['ไทยฟู้ดส์'])
    expect((await json(call('GET', `/v1/stats?brain=${Y}`, 'admin-key'))).memories).toBe(2)
  })

  test('ส่งออกแบบมีประวัติ แล้วนำเข้า ต้องไม่ทำให้ค่าเก่ากลับมาทับค่าปัจจุบัน', async () => {
    const data = await json(call('GET', `/v1/export?brain=${X}&history=1`, 'admin-key'))
    expect(data.memories.length).toBe(3)
    await call('POST', '/v1/import', 'admin-key', { ...data, brain: Y, replace: true })
    const s = await json(call('POST', '/v1/search', 'admin-key', { brain: Y, q: 'รถยก FL-30' }))
    expect(s.hits.map((h: any) => h.text)).toEqual(['รถยก FL-30 ส่งซ่อม'])
  })

  test('ลบตามแหล่ง และล้างทั้งสมองต้องยืนยันชื่อ', async () => {
    expect((await call('DELETE', `/v1/sources?brain=${X}&source=fleet.csv`, 'admin-key')).status).toBe(200)
    const s = await json(call('POST', '/v1/search', 'admin-key', { brain: X, q: 'รถยก FL-30' }))
    expect(s.hits.some((h: any) => h.text.includes('ส่งซ่อม'))).toBe(false)
    expect((await call('DELETE', `/v1/brain?brain=${Y}`, 'admin-key')).status).toBe(400)
    expect((await call('DELETE', `/v1/brain?brain=${Y}&confirm=${Y}`, 'admin-key')).status).toBe(200)
    expect((await json(call('GET', `/v1/stats?brain=${Y}`, 'admin-key'))).memories).toBe(0)
  })

  test('key ที่ผูกสมองหนึ่ง ส่งออก นำเข้า หรือล้างสมองอื่นไม่ได้ · ชื่อฟิลด์ container ยังใช้ได้', async () => {
    expect((await call('GET', `/v1/export?brain=${X}`, 'a-key')).status).toBe(403)
    expect((await call('POST', '/v1/import', 'a-key', { brain: X, memories: [{ text: 'x' }] })).status).toBe(403)
    expect((await call('DELETE', `/v1/brain?brain=${X}&confirm=${X}`, 'a-key')).status).toBe(403)
    expect((await call('POST', '/v1/search', 'a-key', { container: A, q: 'ท่า D-07' })).status).toBe(200)
    expect((await call('POST', '/v1/import', 'admin-key', { brain: Y, memories: [{ text: 'ดี' }, { text: '' }] })).status).toBe(400)
  })
})
