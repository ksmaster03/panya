// เทสต์ล็อกอินด้วยชื่อผู้ใช้และรหัสผ่าน: ต้องมี seekdb รันอยู่
// ใช้ฐานข้อมูลแยก (panya_test) เพราะตารางผู้ใช้ใช้ร่วมกันทั้งฐาน ถ้าสร้างผู้ใช้ในฐานจริง เซิร์ฟเวอร์จริงจะเริ่มบังคับล็อกอิน
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { localEmbedder } from '../src/embed'
import { MemoryStore } from '../src/memory'
import { createApp, SESSION_COOKIE } from '../src/server'

const A = 'auth_brain_a'
const B = 'auth_brain_b'
let store: MemoryStore
let app: ReturnType<typeof createApp>

const call = (method: string, path: string, opts: { cookie?: string; key?: string; body?: unknown; origin?: string } = {}) =>
  app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: `${SESSION_COOKIE}=${opts.cookie}` } : {}),
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  })

const login = async (username: string, password: string) => {
  const r = await call('POST', '/auth/login', { body: { username, password } })
  const m = (r.headers.get('set-cookie') ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
  return { status: r.status, cookie: m?.[1] ?? '', setCookie: r.headers.get('set-cookie') ?? '' }
}

beforeAll(async () => {
  store = await MemoryStore.open(localEmbedder, { database: 'panya_test', collection: 'memories_auth_test' })
  for (const u of await store.users.list()) await store.users.remove(u.username)
  for (const b of (await store.brains.list()).keys()) { await store.clear(b); await store.brains.remove(b) }
  await store.clear(A)
  await store.clear(B)
  app = createApp(store, ['machine-key', `bound-key@${A}`], { publicDashboard: 'off' })
}, 120_000)

afterAll(async () => {
  for (const u of await store.users.list()) await store.users.remove(u.username)
  await store.clear(A)
  await store.clear(B)
  await store.close()
})

describe('ยังไม่มีผู้ใช้', () => {
  test('หน้าเว็บเปิดได้เหมือนเดิม (ใช้ API key)', async () => {
    expect((await call('GET', '/dashboard')).status).toBe(200)
  })
})

describe('มีผู้ใช้แล้ว', () => {
  beforeAll(async () => {
    await store.users.create('boss', 'boss-password-1', 'admin', ['*'])
    await store.users.create('mem', 'mem-password-1', 'member', [A])
    await store.users.create('look', 'look-password-1', 'viewer', [A])
  })

  test('หน้าเว็บพาไปหน้าล็อกอินเมื่อยังไม่ล็อกอิน', async () => {
    const r = await call('GET', '/dashboard?brain=x')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/login?next=%2Fdashboard%3Fbrain%3Dx')
    expect((await call('GET', '/login')).status).toBe(200)
  })

  test('รหัสผิดหรือชื่อไม่มีอยู่ = 401 และไม่ได้ cookie', async () => {
    expect((await login('boss', 'nope-nope-nope')).status).toBe(401)
    const ghost = await login('ghost', 'whatever-123')
    expect(ghost.status).toBe(401)
    expect(ghost.cookie).toBe('')
  })

  test('ล็อกอินถูก: cookie HttpOnly, หน้าเว็บมีข้อมูลผู้ใช้, /v1 ใช้ได้โดยไม่มี key', async () => {
    const s = await login('BOSS', 'boss-password-1')
    expect(s.status).toBe(200)
    expect(s.setCookie).toContain('HttpOnly')
    expect(s.setCookie).toContain('SameSite=Lax')
    const page = await call('GET', '/dashboard', { cookie: s.cookie })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('window.PANYA_USER={"username":"boss","role":"admin"')
    const me = (await (await call('GET', '/auth/me', { cookie: s.cookie })).json()) as any
    expect(me.username).toBe('boss')
    const o = (await (await call('GET', '/v1/overview', { cookie: s.cookie })).json()) as any
    expect(o.me).toEqual({ username: 'boss', role: 'admin' })
    expect(o.server).toBeDefined()
  })

  test('member อ่านสมองที่ admin อนุญาตได้ แต่เขียนไม่ได้ (เขียนได้เฉพาะสมองของตัวเอง)', async () => {
    const admin = (await login('boss', 'boss-password-1')).cookie
    expect((await call('POST', '/v1/memories', { cookie: admin, body: { brain: A, text: 'ประตูหลังล็อกหลังสองทุ่ม' } })).status).toBe(201)
    const { cookie } = await login('mem', 'mem-password-1')
    expect((await call('POST', '/v1/search', { cookie, body: { brain: A, q: 'ประตูหลัง' } })).status).toBe(200)
    expect((await call('POST', '/v1/memories', { cookie, body: { brain: A, text: 'x' } })).status).toBe(403)
    expect((await call('POST', '/v1/memories', { cookie, body: { brain: B, text: 'x' } })).status).toBe(403)
    expect((await call('POST', '/v1/search', { cookie, body: { brain: B, q: 'x' } })).status).toBe(403)
    const o = (await (await call('GET', '/v1/overview', { cookie })).json()) as any
    expect(o.brains.every((b: any) => b.brain === A)).toBe(true)
    expect(o.server).toBeUndefined()
    expect((await call('GET', '/v1/users', { cookie })).status).toBe(403)
  })

  test('viewer ค้นได้ แต่เขียนหรือลบไม่ได้', async () => {
    const { cookie } = await login('look', 'look-password-1')
    expect((await call('POST', '/v1/search', { cookie, body: { brain: A, q: 'ประตูหลัง' } })).status).toBe(200)
    expect((await call('POST', '/v1/memories', { cookie, body: { brain: A, text: 'x' } })).status).toBe(403)
    expect((await call('DELETE', `/v1/brain?brain=${A}&confirm=${A}`, { cookie })).status).toBe(403)
  })

  test('คำขอเขียนข้ามเว็บด้วย cookie ถูกปฏิเสธ', async () => {
    const { cookie } = await login('mem', 'mem-password-1')
    expect((await call('POST', '/v1/memories', { cookie, origin: 'https://evil.example', body: { brain: A, text: 'x' } })).status).toBe(403)
    expect((await call('POST', '/auth/login', { origin: 'https://evil.example', body: { username: 'mem', password: 'mem-password-1' } })).status).toBe(403)
  })

  test('API key ของโปรแกรมยังใช้ได้ และ key ที่ผูกสมองยังถูกจำกัด', async () => {
    expect((await call('POST', '/v1/search', { key: 'machine-key', body: { brain: B, q: 'x' } })).status).toBe(200)
    expect((await call('POST', '/v1/search', { key: 'bound-key', body: { brain: B, q: 'x' } })).status).toBe(403)
    expect((await call('POST', '/v1/search', { key: 'wrong-key', body: { brain: A, q: 'x' } })).status).toBe(401)
  })

  test('ออกจากระบบแล้ว cookie เดิมใช้ไม่ได้', async () => {
    const { cookie } = await login('mem', 'mem-password-1')
    expect((await call('POST', '/auth/logout', { cookie })).status).toBe(200)
    expect((await call('GET', '/v1/overview', { cookie })).status).toBe(401)
  })

  test('ระงับผู้ใช้แล้ว session เดิมหลุดทันที และล็อกอินใหม่ไม่ได้', async () => {
    const { cookie } = await login('look', 'look-password-1')
    const admin = (await login('boss', 'boss-password-1')).cookie
    expect((await call('PATCH', '/v1/users/look', { cookie: admin, body: { disabled: true } })).status).toBe(200)
    expect((await call('GET', '/v1/overview', { cookie })).status).toBe(401)
    expect((await login('look', 'look-password-1')).status).toBe(401)
    await call('PATCH', '/v1/users/look', { cookie: admin, body: { disabled: false } })
  })

  test('admin สร้างผู้ใช้ได้ ระบบสุ่มรหัสให้และใช้ล็อกอินได้', async () => {
    const admin = (await login('boss', 'boss-password-1')).cookie
    const r = await call('POST', '/v1/users', { cookie: admin, body: { username: 'newbie', role: 'member', brains: [A, B] } })
    expect(r.status).toBe(201)
    const body = (await r.json()) as any
    expect(body.password).toHaveLength(20)
    expect(body.user.pass_hash).toBeUndefined()
    expect((await login('newbie', body.password)).status).toBe(200)
    expect((await call('POST', '/v1/users', { cookie: admin, body: { username: 'newbie', role: 'member' } })).status).toBe(409)
    expect((await call('POST', '/v1/users', { cookie: admin, body: { username: 'x', role: 'god' } })).status).toBe(400)
    expect((await call('POST', '/v1/users', { cookie: admin, body: { username: 'shorty', role: 'viewer', password: 'short' } })).status).toBe(400)
    // API key ที่ไม่ผูกสมองจัดการผู้ใช้ได้ (ใช้ตอนตั้งระบบ) ส่วน key ที่ผูกสมองไม่ได้
    expect((await call('GET', '/v1/users', { key: 'machine-key' })).status).toBe(200)
    expect((await call('GET', '/v1/users', { key: 'bound-key' })).status).toBe(403)
  })

  test('ลดสิทธิ์หรือลบ admin คนสุดท้ายไม่ได้', async () => {
    const admin = (await login('boss', 'boss-password-1')).cookie
    expect((await call('PATCH', '/v1/users/boss', { cookie: admin, body: { role: 'member' } })).status).toBe(409)
    expect((await call('PATCH', '/v1/users/boss', { cookie: admin, body: { disabled: true } })).status).toBe(409)
    expect((await call('DELETE', '/v1/users/boss', { cookie: admin })).status).toBe(409)
  })

  test('เปลี่ยนรหัสของตัวเองต้องใส่รหัสเดิม และ session อื่นหลุด', async () => {
    const one = (await login('mem', 'mem-password-1')).cookie
    const two = (await login('mem', 'mem-password-1')).cookie
    expect((await call('POST', '/auth/password', { cookie: two, body: { current: 'wrong-wrong', next: 'mem-password-2' } })).status).toBe(401)
    const r = await call('POST', '/auth/password', { cookie: two, body: { current: 'mem-password-1', next: 'mem-password-2' } })
    expect(r.status).toBe(200)
    expect((await call('GET', '/v1/overview', { cookie: one })).status).toBe(401)
    expect((await login('mem', 'mem-password-2')).status).toBe(200)
  })

  test('member สร้างสมองของตัวเอง เขียนได้ แชร์ให้อ่านได้ แต่คนที่ได้รับแชร์เขียนไม่ได้', async () => {
    await store.users.create('alice', 'alice-password-1', 'member', [])
    await store.users.create('bob', 'bob-password-1', 'member', [])
    const alice = (await login('alice', 'alice-password-1')).cookie
    const bob = (await login('bob', 'bob-password-1')).cookie
    const OWN = 'alice_notes'
    expect((await call('POST', '/v1/brains', { cookie: alice, body: { name: OWN, description: 'โน้ตงาน' } })).status).toBe(201)
    expect((await call('POST', '/v1/brains', { cookie: bob, body: { name: OWN } })).status).toBe(409)
    expect((await call('POST', '/v1/brains', { cookie: bob, body: { name: A } })).status).toBe(409) // ชื่อซ้ำกับสมองเดิม
    expect((await call('POST', '/v1/memories', { cookie: alice, body: { brain: OWN, text: 'ประชุมทีมทุกวันจันทร์ 10 โมง' } })).status).toBe(201)
    // ยังไม่แชร์: bob อ่านไม่ได้
    expect((await call('POST', '/v1/search', { cookie: bob, body: { brain: OWN, q: 'ประชุม' } })).status).toBe(403)
    expect((await call('PATCH', `/v1/brains/${OWN}`, { cookie: bob, body: { readers: ['bob'] } })).status).toBe(403)
    expect((await call('PATCH', `/v1/brains/${OWN}`, { cookie: alice, body: { readers: ['bob'] } })).status).toBe(200)
    // แชร์แล้ว: bob ค้นได้ แต่เขียน ลบ หรือนำเข้าไม่ได้
    const s = (await (await call('POST', '/v1/search', { cookie: bob, body: { brain: OWN, q: 'ประชุมทีม' } })).json()) as any
    expect(s.hits[0].text).toBe('ประชุมทีมทุกวันจันทร์ 10 โมง')
    expect((await call('POST', '/v1/memories', { cookie: bob, body: { brain: OWN, text: 'แทรก' } })).status).toBe(403)
    expect((await call('POST', '/v1/import', { cookie: bob, body: { brain: OWN, memories: [{ text: 'แทรก' }] } })).status).toBe(403)
    expect((await call('DELETE', `/v1/brain?brain=${OWN}&confirm=${OWN}`, { cookie: bob })).status).toBe(403)
    expect((await call('DELETE', `/v1/brains/${OWN}?confirm=${OWN}`, { cookie: bob })).status).toBe(403)
    // member เขียนสมองที่ admin อนุญาตให้อ่านไม่ได้ (A อยู่ใน brains ของ mem แต่ไม่ใช่เจ้าของ)
    const list = (await (await call('GET', '/v1/brains', { cookie: bob })).json()) as any
    const mine = list.brains.find((x: any) => x.name === OWN)
    expect(mine.access).toBe('read')
    expect(mine.readers).toBeUndefined()
    // เจ้าของลบสมองทั้งก้อนได้
    expect((await call('DELETE', `/v1/brains/${OWN}?confirm=${OWN}`, { cookie: alice })).status).toBe(200)
    expect((await call('POST', '/v1/memories', { cookie: alice, body: { brain: OWN, text: 'x' } })).status).toBe(403)
  })

  test('viewer สร้างสมองไม่ได้', async () => {
    const { cookie } = await login('look', 'look-password-1')
    expect((await call('POST', '/v1/brains', { cookie, body: { name: 'look_brain' } })).status).toBe(403)
  })

  test('ห้ามบันทึกความลับ ทุกช่องทาง (ผู้ใช้, API key, นำเข้า)', async () => {
    const admin = (await login('boss', 'boss-password-1')).cookie
    const secret = 'รหัสผ่าน wifi คือ Home@2024!'
    const r = await call('POST', '/v1/memories', { cookie: admin, body: { brain: A, text: secret } })
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error).toContain('never stores secrets')
    expect((await call('POST', '/v1/memories', { key: 'machine-key', body: { brain: A, text: 'key AKIAIOSFODNN7EXAMPLE' } })).status).toBe(400)
    expect((await call('POST', '/v1/import', { key: 'machine-key', body: { brain: A, memories: [{ text: 'ok' }, { text: 'x', source: 'postgres://u:p4ssword@h/db' }] } })).status).toBe(400)
    expect((await call('POST', '/v1/memories', { cookie: admin, body: { brain: A, text: 'ผู้ใช้ลืมรหัสผ่านให้กดรีเซ็ตที่หน้า login' } })).status).toBe(201)
  })

  test('API key ของผู้ใช้: สร้างจากหน้าเว็บ สิทธิ์เท่าเจ้าของ ยกเลิกได้', async () => {
    const alice = (await login('alice', 'alice-password-1')).cookie
    await call('POST', '/v1/brains', { cookie: alice, body: { name: 'alice_api' } })
    const made = await call('POST', '/v1/keys', { cookie: alice, body: { name: 'laptop' } })
    expect(made.status).toBe(201)
    const { key, id } = (await made.json()) as any
    expect(key).toMatch(/^pnu_[a-z0-9]{12}_/)
    expect((await call('POST', '/v1/memories', { key, body: { brain: 'alice_api', text: 'เขียนผ่าน key ได้' } })).status).toBe(201)
    expect((await call('POST', '/v1/memories', { key, body: { brain: B, text: 'x' } })).status).toBe(403)
    // key สร้าง key ต่อเองไม่ได้ และรายการ key ไม่คืนค่า key เต็ม
    expect((await call('POST', '/v1/keys', { key, body: { name: 'evil' } })).status).toBe(403)
    const list = (await (await call('GET', '/v1/keys', { cookie: alice })).json()) as any
    expect(JSON.stringify(list)).not.toContain(key)
    expect((await call('DELETE', `/v1/keys/${id}`, { cookie: alice })).status).toBe(200)
    expect((await call('POST', '/v1/search', { key, body: { brain: 'alice_api', q: 'x' } })).status).toBe(401)
    await call('DELETE', '/v1/brains/alice_api?confirm=alice_api', { cookie: alice })
  })

  test('ใส่รหัสผิดเกิน 5 ครั้งถูกพัก 429', async () => {
    await store.users.create('target', 'target-password-1', 'viewer', [A])
    for (let i = 0; i < 5; i++) expect((await login('target', 'bad-password-' + i)).status).toBe(401)
    expect((await login('target', 'target-password-1')).status).toBe(429)
  })
})
