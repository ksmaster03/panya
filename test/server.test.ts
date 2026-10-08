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
    expect((await call('POST', '/v1/search', null, { container: A, q: 'x' })).status).toBe(401)
    expect((await call('POST', '/v1/search', 'wrong', { container: A, q: 'x' })).status).toBe(401)
  })

  test('key ที่ผูก container เขียน อ่าน และลบของ container อื่นไม่ได้', async () => {
    const made = await call('POST', '/v1/memories', 'admin-key', { container: B, text: 'ลานจอดของ tenant B แน่นทุกวันศุกร์' })
    expect(made.status).toBe(201)
    const id = ((await made.json()) as any).memory.id

    expect((await call('POST', '/v1/memories', 'a-key', { container: B, text: 'x' })).status).toBe(403)
    expect((await call('POST', '/v1/search', 'a-key', { container: B, q: 'ลานจอด' })).status).toBe(403)
    expect((await call('GET', `/v1/profile?container=${B}`, 'a-key')).status).toBe(403)
    expect((await call('DELETE', `/v1/memories/${id}?container=${B}`, 'a-key')).status).toBe(403)
    // อ้าง container ของตัวเองแต่ใช้ id ของคนอื่นก็ต้องลบไม่ได้
    expect((await call('DELETE', `/v1/memories/${id}?container=${A}`, 'a-key')).status).toBe(404)
  })
})

describe('memories', () => {
  test('บันทึกแล้วค้นเจอ ผ่าน key ที่ผูก container', async () => {
    const r = await call('POST', '/v1/memories', 'a-key', {
      container: A, text: 'ท่า D-07 ใช้ได้เฉพาะรถ 6 ล้อ', subject: 'dock:D-07', attribute: 'restriction',
    })
    expect(r.status).toBe(201)
    const s = (await (await call('POST', '/v1/search', 'a-key', { container: A, q: 'ท่า D-07 รับรถแบบไหน' })).json()) as any
    expect(s.abstained).toBe(false)
    expect(s.hits[0].text).toBe('ท่า D-07 ใช้ได้เฉพาะรถ 6 ล้อ')
  })

  test('บันทึกเป็นชุด: รายการหลังทับรายการก่อนที่คีย์เดียวกัน', async () => {
    const r = await call('POST', '/v1/memories/batch', 'a-key', {
      container: A,
      memories: [
        { text: 'รถยก FL-21 พร้อมใช้งาน', subject: 'forklift:FL-21', attribute: 'status' },
        { text: 'ลานจอดฝั่งตะวันออกปิดปรับปรุงพื้น' },
        { text: 'รถยก FL-21 ส่งซ่อมแบตเตอรี่', subject: 'forklift:FL-21', attribute: 'status' },
      ],
    })
    expect(r.status).toBe(201)
    const body = (await r.json()) as any
    expect(body.results.map((x: any) => x.action)).toEqual(['created', 'created', 'superseded'])
    const s = (await (await call('POST', '/v1/search', 'a-key', { container: A, q: 'รถยก FL-21' })).json()) as any
    expect(s.hits.map((h: any) => h.text)).toEqual(['รถยก FL-21 ส่งซ่อมแบตเตอรี่'])
  })

  test('บันทึกเป็นชุด: มีรายการผิดรูปแบบ ต้องไม่บันทึกอะไรเลย', async () => {
    const r = await call('POST', '/v1/memories/batch', 'a-key', {
      container: A, memories: [{ text: 'ประตู 9 เปิดเฉพาะวันเสาร์' }, { text: '' }],
    })
    expect(r.status).toBe(400)
    const s = (await (await call('POST', '/v1/search', 'a-key', { container: A, q: 'ประตู 9 เปิดเฉพาะวันเสาร์' })).json()) as any
    expect(s.hits.some((h: any) => h.text.includes('ประตู 9'))).toBe(false)
    expect((await call('POST', '/v1/memories/batch', 'a-key', { container: B, memories: [{ text: 'x' }] })).status).toBe(403)
  })

  test('ปฏิเสธข้อมูลที่ไม่ถูกรูปแบบ', async () => {
    expect((await call('POST', '/v1/memories', 'a-key', { container: A, text: '   ' })).status).toBe(400)
    expect((await call('POST', '/v1/memories', 'a-key', { container: A, text: 'x', kind: 'rumor' })).status).toBe(400)
    expect((await call('POST', '/v1/memories', 'a-key', { container: A, text: 'x', validUntil: 'ไม่ใช่วันที่' })).status).toBe(400)
    expect((await call('POST', '/v1/memories', 'a-key', { container: A, text: 'ก'.repeat(2001) })).status).toBe(400)
    expect((await call('POST', '/v1/search', 'a-key', { container: A })).status).toBe(400)
  })
})
