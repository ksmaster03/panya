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

  test('member เขียนและค้นได้เฉพาะสมองที่กำหนด', async () => {
    const { cookie } = await login('mem', 'mem-password-1')
    expect((await call('POST', '/v1/memories', { cookie, body: { brain: A, text: 'ประตูหลังล็อกหลังสองทุ่ม' } })).status).toBe(201)
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

  test('ใส่รหัสผิดเกิน 5 ครั้งถูกพัก 429', async () => {
    await store.users.create('target', 'target-password-1', 'viewer', [A])
    for (let i = 0; i < 5; i++) expect((await login('target', 'bad-password-' + i)).status).toBe(401)
    expect((await login('target', 'target-password-1')).status).toBe(429)
  })
})
