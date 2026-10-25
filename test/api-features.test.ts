// /v1/context, /v1/history, พารามิเตอร์ค้นหาใหม่, key แบบจำกัดขอบเขต และ MCP · ต้องมี seekdb รันอยู่
// ใช้ฐานข้อมูล panya_test (ตารางผู้ใช้ใช้ร่วมทั้งฐาน ห้ามสร้างผู้ใช้ในฐานจริง)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { localEmbedder } from '../src/embed'
import { MemoryStore } from '../src/memory'
import { createApp, SESSION_COOKIE } from '../src/server'

const OWN = 'apif_own'
const OTHER = 'apif_other'
let store: MemoryStore
let app: ReturnType<typeof createApp>
let cookie = ''
let fullKey = ''

const call = (method: string, path: string, opts: { key?: string; cookie?: string; body?: unknown } = {}) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.cookie ? { cookie: `${SESSION_COOKIE}=${opts.cookie}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
const json = async (r: Response) => (await r.json()) as any
let rpcId = 0
const mcp = async (key: string, method: string, params?: unknown) => {
  const r = await call('POST', '/mcp', { key, body: { jsonrpc: '2.0', id: ++rpcId, method, params } })
  return { status: r.status, body: r.status === 202 ? null : await json(r) }
}
const tool = async (key: string, name: string, args: unknown) => (await mcp(key, 'tools/call', { name, arguments: args })).body.result as { content: { text: string }[]; isError: boolean }

beforeAll(async () => {
  store = await MemoryStore.open(localEmbedder, { database: 'panya_test', collection: 'memories_apif_test' })
  for (const u of await store.users.list()) await store.users.remove(u.username)
  for (const b of (await store.brains.list()).keys()) { await store.clear(b); await store.brains.remove(b) }
  await store.clear(OWN); await store.clear(OTHER)
  app = createApp(store, ['machine-key'], { publicDashboard: 'off' })
  await store.users.create('carol', 'carol-password-1', 'member', [])
  const login = await call('POST', '/auth/login', { body: { username: 'carol', password: 'carol-password-1' } })
  cookie = (login.headers.get('set-cookie') ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1]!
  await call('POST', '/v1/brains', { cookie, body: { name: OWN } })
  await call('POST', '/v1/brains', { cookie, body: { name: OTHER } })
  fullKey = (await json(await call('POST', '/v1/keys', { cookie, body: { name: 'full' } }))).key
  const now = Date.now(), DAY = 86_400_000
  // ค่าเก่าเมื่อ 20 วันก่อน (createdAt รับเฉพาะตอนนำเข้า)
  await call('POST', '/v1/import', { key: fullKey, body: { brain: OWN, memories: [{ text: 'ทีมขายประชุมทุกวันอังคาร', subject: 'meeting:sales', attribute: 'day', createdAt: now - 20 * DAY }] } })
  await call('POST', '/v1/memories', { key: fullKey, body: { brain: OWN, text: 'ทีมขายประชุมทุกวันพฤหัส', subject: 'meeting:sales', attribute: 'day' } })
  await call('POST', '/v1/memories', { key: fullKey, body: { brain: OWN, text: 'หัวหน้าทีมชอบสรุปเป็นข้อ ๆ สั้น ๆ', kind: 'preference' } })
}, 120_000)

afterAll(async () => {
  for (const u of await store.users.list()) await store.users.remove(u.username)
  for (const b of [OWN, OTHER]) { await store.clear(b); await store.brains.remove(b) }
  await store.close()
})

describe('/v1/context และ /v1/history', () => {
  test('context: ค่าปัจจุบันของคีย์ + ความชอบ', async () => {
    const r = await json(await call('GET', `/v1/context?brain=${OWN}`, { key: fullKey }))
    expect(r.current.map((m: any) => m.text)).toEqual(['ทีมขายประชุมทุกวันพฤหัส'])
    expect(r.preferences.map((m: any) => m.text)).toEqual(['หัวหน้าทีมชอบสรุปเป็นข้อ ๆ สั้น ๆ'])
    expect(r.current[0].brain).toBe(OWN)
  })
  test('context format=text พร้อมใส่ prompt', async () => {
    const t = await (await call('GET', `/v1/context?brain=${OWN}&format=text`, { key: fullKey })).text()
    expect(t).toContain('# panya context: ' + OWN)
    expect(t).toContain('meeting:sales · day: ทีมขายประชุมทุกวันพฤหัส')
    expect(t).toContain('## Preferences')
  })
  test('history: ทุกรุ่น ใหม่สุดก่อน', async () => {
    const r = await json(await call('GET', `/v1/history?brain=${OWN}&subject=meeting:sales&attribute=day`, { key: fullKey }))
    expect(r.versions.map((m: any) => [m.text, m.active])).toEqual([['ทีมขายประชุมทุกวันพฤหัส', true], ['ทีมขายประชุมทุกวันอังคาร', false]])
    expect(r.versions[1].invalidAt).toBeGreaterThan(0)
    expect((await call('GET', `/v1/history?brain=${OWN}&subject=meeting:sales`, { key: fullKey })).status).toBe(400)
  })
})

describe('ค้นหา: explain, includeSuperseded, asOf, fusion', () => {
  test('explain + includeSuperseded', async () => {
    const r = await json(await call('POST', '/v1/search', { key: fullKey, body: { brain: OWN, q: 'ทีมขายประชุมวันไหน', explain: true, includeSuperseded: true, limit: 10 } }))
    expect(r.hits.length).toBeGreaterThanOrEqual(2)
    expect(r.hits[0].explain.weighted).toBeDefined()
    expect(r.hits.some((h: any) => h.active === false)).toBe(true)
  })
  test('asOf ก่อนเปลี่ยนค่า ได้ค่าเดิม', async () => {
    const r = await json(await call('POST', '/v1/search', { key: fullKey, body: { brain: OWN, q: 'ทีมขายประชุมวันไหน', asOf: new Date(Date.now() - 10 * 86_400_000).toISOString() } }))
    expect(r.hits[0].text).toBe('ทีมขายประชุมทุกวันอังคาร')
  })
  test('ค่าผิดรูปแบบถูกปฏิเสธ', async () => {
    expect((await call('POST', '/v1/search', { key: fullKey, body: { brain: OWN, q: 'x', asOf: 'not-a-date' } })).status).toBe(400)
    expect((await call('POST', '/v1/search', { key: fullKey, body: { brain: OWN, q: 'x', fusion: 'magic' } })).status).toBe(400)
    expect((await call('POST', '/v1/search', { key: fullKey, body: { brain: OWN, q: 'ประชุม', fusion: 'rrf' } })).status).toBe(200)
  })
})

describe('key แบบจำกัดขอบเขต', () => {
  test('key เฉพาะสมองเดียว: อ่าน/เขียนได้แค่สมองนั้น สร้างสมองหรือ key ไม่ได้', async () => {
    const k = (await json(await call('POST', '/v1/keys', { cookie, body: { name: 'only-own', brains: [OWN] } }))).key
    expect((await call('POST', '/v1/memories', { key: k, body: { brain: OWN, text: 'บันทึกด้วย key จำกัด' } })).status).toBe(201)
    expect((await call('POST', '/v1/memories', { key: k, body: { brain: OTHER, text: 'x' } })).status).toBe(403)
    expect((await call('POST', '/v1/search', { key: k, body: { brain: OTHER, q: 'x' } })).status).toBe(403)
    const brains = await json(await call('GET', '/v1/brains', { key: k }))
    expect(brains.brains.map((b: any) => b.name)).toEqual([OWN])
    expect((await call('POST', '/v1/brains', { key: k, body: { name: 'apif_new' } })).status).toBe(403)
  })
  test('key อ่านอย่างเดียว: ค้นได้ เขียน/ลบไม่ได้', async () => {
    const k = (await json(await call('POST', '/v1/keys', { cookie, body: { name: 'ro', mode: 'read' } }))).key
    expect((await call('POST', '/v1/search', { key: k, body: { brain: OWN, q: 'ประชุม' } })).status).toBe(200)
    expect((await call('POST', '/v1/memories', { key: k, body: { brain: OWN, text: 'x' } })).status).toBe(403)
    expect((await call('DELETE', `/v1/brain?brain=${OWN}&confirm=${OWN}`, { key: k })).status).toBe(403)
    const list = (await json(await call('GET', '/v1/keys', { cookie }))).keys
    expect(list.find((x: any) => x.name === 'ro').mode).toBe('read')
  })
  test('key หมดอายุใช้ไม่ได้', async () => {
    const { key } = await store.users.createKey('carol', 'old', { expiresAt: Date.now() - 1000 })
    expect((await call('GET', '/v1/brains', { key })).status).toBe(401)
  })
  test('ตรวจค่าที่ส่งมา', async () => {
    expect((await call('POST', '/v1/keys', { cookie, body: { name: 'x', brains: ['not-mine'] } })).status).toBe(403)
    expect((await call('POST', '/v1/keys', { cookie, body: { name: 'x', mode: 'admin' } })).status).toBe(400)
    expect((await call('POST', '/v1/keys', { cookie, body: { name: 'x', expiresInDays: 999 } })).status).toBe(400)
    const r = await json(await call('POST', '/v1/keys', { cookie, body: { name: 'thirty', expiresInDays: 30 } }))
    expect(r.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000)
  })
})

describe('MCP', () => {
  test('ไม่มี key หรือ key ผิด = 401', async () => {
    const none = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })
    expect(none.status).toBe(401)
    expect((await mcp('pnu_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbb', 'initialize')).status).toBe(401)
  })
  test('initialize, notification, tools/list, ping', async () => {
    const init = await mcp(fullKey, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.body.result.protocolVersion).toBe('2025-06-18')
    expect(init.body.result.serverInfo.name).toBe('panya')
    const note = await call('POST', '/mcp', { key: fullKey, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    expect(note.status).toBe(202)
    const tools = (await mcp(fullKey, 'tools/list')).body.result.tools.map((t: any) => t.name)
    expect(tools).toEqual(['list_brains', 'context', 'recall', 'remember', 'history', 'forget'])
    expect((await mcp(fullKey, 'ping')).body.result).toEqual({})
    expect((await mcp(fullKey, 'no/such')).body.error.code).toBe(-32601)
  })
  test('remember → recall → history → forget', async () => {
    const saved = await tool(fullKey, 'remember', { brain: OWN, text: 'โกดังบางนาเปิด 7 โมงเช้า', subject: 'warehouse:bangna', attribute: 'open' })
    expect(saved.isError).toBe(false)
    const id = saved.content[0]!.text.match(/id (\S+)/)![1]
    const found = await tool(fullKey, 'recall', { brain: OWN, query: 'โกดังบางนาเปิดกี่โมง' })
    expect(found.content[0]!.text).toContain('โกดังบางนาเปิด 7 โมงเช้า')
    await tool(fullKey, 'remember', { brain: OWN, text: 'โกดังบางนาเปิด 6 โมงเช้า', subject: 'warehouse:bangna', attribute: 'open' })
    const hist = await tool(fullKey, 'history', { brain: OWN, subject: 'warehouse:bangna', attribute: 'open' })
    expect(hist.content[0]!.text).toMatch(/\(current\): โกดังบางนาเปิด 6 โมงเช้า[\s\S]*replaced/)
    expect((await tool(fullKey, 'forget', { brain: OWN, id })).content[0]!.text).toBe('Deleted.')
  })
  test('recall ที่ไม่รู้ บอกว่าไม่รู้ ไม่เดา', async () => {
    const r = await tool(fullKey, 'recall', { brain: OWN, query: 'ราคาหุ้นบริษัทดาวอังคารวันนี้' })
    expect(r.content[0]!.text).toContain('panya does not know')
  })
  test('context และ list_brains', async () => {
    expect((await tool(fullKey, 'context', { brain: OWN })).content[0]!.text).toContain('ทีมขายประชุมทุกวันพฤหัส')
    expect((await tool(fullKey, 'list_brains', {})).content[0]!.text).toContain(`${OWN} ·`)
  })
  test('ความลับถูกปฏิเสธผ่าน MCP และขอบเขต key ยังมีผล', async () => {
    const s = await tool(fullKey, 'remember', { brain: OWN, text: 'password: Sup3rSecret!' })
    expect(s.isError).toBe(true)
    expect(s.content[0]!.text).toContain('never stores secrets')
    const ro = (await json(await call('POST', '/v1/keys', { cookie, body: { name: 'mcp-ro', mode: 'read' } }))).key
    expect((await tool(ro, 'remember', { brain: OWN, text: 'x' })).isError).toBe(true)
    expect((await tool(ro, 'recall', { brain: OWN, query: 'ประชุม' })).isError).toBe(false)
  })
  test('เรียกเป็นชุด (batch)', async () => {
    const r = await call('POST', '/mcp', { key: fullKey, body: [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }] })
    const out = await json(r)
    expect(out.map((x: any) => x.id)).toEqual(['a', 'b'])
  })
  test('machine key ใช้กับ MCP ได้', async () => {
    expect((await tool('machine-key', 'list_brains', {})).isError).toBe(false)
  })
})
