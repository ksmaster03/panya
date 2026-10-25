import { Hono, type Context } from 'hono'
import { getConnInfo } from 'hono/bun'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { config } from './config'
import type { Memory, MemoryStore, RememberInput } from './memory'
import { MIN_PASSWORD, ROLES, USERNAME, randomPassword, type Role, type User } from './users'
import { findSecret } from './secrets'

/** ข้อความเมื่อพบความลับ ผู้เรียก (คนหรือโปรแกรม) ต้องเอาความลับออกแล้วส่งใหม่ */
export const SECRET_REFUSED = 'refused: looks like a password, key or token. panya never stores secrets; remove it and send again'

// scope = brain ที่เข้าได้ (null = ทุก brain) · user = ผู้ใช้ที่ล็อกอินด้วยรหัสผ่าน (ไม่มีเมื่อใช้ API key)
// wscope = brain ที่เขียน/ลบได้ (null = ทุก brain) แยกจาก scope ที่อ่านได้ เพราะสมองที่ได้รับแชร์อ่านได้อย่างเดียว
// viaKey = ผู้ใช้เรียกด้วย API key ของตัวเอง (ไม่ใช่ cookie) · จัดการ key และรหัสผ่านได้เฉพาะทาง cookie
type Env = { Variables: { scope: Set<string> | null; wscope: Set<string> | null; viewer?: boolean; user?: User; viaKey?: boolean } }

/** ชื่อ cookie ของ session ผู้ใช้ */
export const SESSION_COOKIE = 'panya_session'

/** error ที่แปลว่าการเชื่อมต่อฐานข้อมูลตายแล้ว (mysql2 ที่ seekdb ใช้ตั้ง fatal และข้อความ closed state) */
export function isLostConnection(err: unknown): boolean {
  const e = err as { fatal?: boolean; message?: string; code?: string } | null
  return !!e && (e.fatal === true || /closed state|connection lost|ECONNRESET|PROTOCOL_CONNECTION_LOST/i.test(`${e.message ?? ''} ${e.code ?? ''}`))
}

/** หมวดของรายการที่กำลังจะบันทึก ใช้บอกรถยกในหน้าคลังว่าต้องไปวางชั้นไหน */
const groupOfInput = (i: RememberInput) => groupOf(i.source ?? '', i.subject ?? '', i.kind ?? 'fact')

const PUBLIC_READ = new Set(['/v1/overview', '/v1/events', '/v1/graph', '/v1/points'])

/** หมวดสั้น ๆ ของความจำสำหรับระบายสีบนภาพสมอง: คำแรกของชื่อไฟล์ต้นทางหรือ subject ถ้ายาวเกินใช้ชนิดแทน (ตรงกับหน้า /brain) */
export function groupOf(source: string, subject: string, kind: string): string {
  const tail = source.split(/[\\/]/).pop() || ''
  const head = (tail || subject || '').split(/[_:.\-\s]/)[0] ?? ''
  return head && head.length <= 14 ? head.toLowerCase() : kind
}

/** ที่อยู่ของเครื่องนี้หรือเครือข่ายภายใน (IPv4 ส่วนตัว, loopback, link-local, IPv6 ULA) */
export function isPrivateAddress(raw: string | undefined): boolean {
  if (!raw) return false
  const ip = raw.toLowerCase().replace(/^::ffff:/, '')
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
  }
  return ip === '::1' || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)
}

const KINDS = new Set(['fact', 'preference', 'event'])
const BRAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const IMPORT_MAX = 5000

/** สิ่งที่ผู้เรียกเห็น: ใช้คำว่า brain แทน container ที่เป็นชื่อภายใน */
const present = ({ container, ...m }: Memory) => ({ ...m, brain: container })

export function createApp(
  store: MemoryStore,
  apiKeys: string[] = config.apiKeys,
  opts: { publicDashboard?: 'off' | 'lan' | 'all'; warmPoints?: boolean; exitOnLostDb?: boolean; trustProxy?: boolean } = {},
) {
  const publicDashboard = opts.publicDashboard ?? config.publicDashboard
  const trustProxy = opts.trustProxy ?? config.trustProxy
  const users = store.users
  // IP ของผู้เรียก · หลัง reverse proxy (Caddy/Cloudflare) ต้องอ่านจาก header ที่ proxy ใส่ให้ ไม่งั้นทุกคนเป็น IP เดียวกัน
  const clientIp = (c: Context<Env>) => {
    if (trustProxy) {
      const h = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]
      if (h) return h.trim()
    }
    try { return getConnInfo(c).remote.address ?? '' } catch { return '' }
  }
  // lan: ใช้ IP ของการเชื่อมต่อจริงจาก Bun ไม่เชื่อ header อย่าง X-Forwarded-For ที่ปลอมได้
  const publicAllowed = (c: Context<Env>) => {
    if (publicDashboard === 'all') return true
    if (publicDashboard !== 'lan') return false
    try { return isPrivateAddress(getConnInfo(c).remote.address) } catch { return false }
  }
  // "key" ใช้ได้ทุก brain · "key@brain" ใช้ได้กับ brain เดียว
  const keys = new Map<string, string | null>()
  for (const k of apiKeys) {
    const at = k.indexOf('@')
    keys.set(at < 0 ? k : k.slice(0, at), at < 0 ? null : k.slice(at + 1))
  }

  const app = new Hono<Env>()
  app.get('/health', (c) => c.json({ ok: true }))

  // ── ผู้ใช้และ session ─────────────────────────────────────────────
  // มีผู้ใช้อย่างน้อยหนึ่งคน = หน้าเว็บต้องล็อกอิน · ยังไม่มีผู้ใช้ = ใช้ API key แบบเดิม
  const sessionOf = async (c: Context<Env>) => {
    const sid = getCookie(c, SESSION_COOKIE)
    return sid ? users.session(sid) : null
  }
  const secureCookie = (c: Context<Env>) =>
    config.cookieSecure === 'auto'
      ? new URL(c.req.url).protocol === 'https:' || (trustProxy && c.req.header('x-forwarded-proto') === 'https')
      : config.cookieSecure
  // cookie ถูกส่งไปกับคำขอข้ามเว็บได้ คำขอที่เขียนข้อมูลด้วย cookie จึงต้องมาจากเว็บนี้เอง
  const sameOrigin = (c: Context<Env>) => {
    const origin = c.req.header('origin')
    if (!origin) return c.req.header('sec-fetch-site') !== 'cross-site'
    try { return new URL(origin).host === (c.req.header('host') ?? new URL(c.req.url).host) } catch { return false }
  }
  const safeNext = (next: string | undefined) => (next && /^\/(?!\/)[^\\]*$/.test(next) ? next : '/dashboard')

  // ผิดเกิน 5 ครั้งใน 15 นาที (ต่อชื่อผู้ใช้ + IP) หรือ 30 ครั้ง (ต่อ IP) พักไว้จนครบ 15 นาที
  const FAIL_WINDOW = 15 * 60_000
  const fails = new Map<string, { n: number; first: number }>()
  const tooMany = (k: string, max: number) => {
    const f = fails.get(k)
    if (f && Date.now() - f.first > FAIL_WINDOW) { fails.delete(k); return false }
    return !!f && f.n >= max
  }
  const fail = (k: string) => {
    const f = fails.get(k)
    if (!f || Date.now() - f.first > FAIL_WINDOW) fails.set(k, { n: 1, first: Date.now() })
    else f.n++
    if (fails.size > 10_000) fails.delete(fails.keys().next().value!)
  }

  const page = (file: string) => async (c: Context<Env>) => {
    let html = await Bun.file(new URL(file, import.meta.url)).text()
    if (users.loginRequired) {
      const s = await sessionOf(c)
      if (s) {
        const me = JSON.stringify({ username: s.user.username, role: s.user.role, brains: s.user.brains }).replace(/</g, '\\u003c')
        html = html.replace('</head>', `<script>window.PANYA_USER=${me}</script><script src="/assets/account.js"></script></head>`)
      } else if (!(file === './dashboard.html' && publicAllowed(c))) {
        const u = new URL(c.req.url)
        return c.redirect('/login?next=' + encodeURIComponent(u.pathname + u.search))
      }
    }
    c.header('cache-control', 'no-store')
    return c.html(html)
  }

  app.get('/login', async (c) => {
    if (await sessionOf(c)) return c.redirect(safeNext(c.req.query('next')))
    return c.html(await Bun.file(new URL('./login.html', import.meta.url)).text())
  })

  app.post('/auth/login', async (c) => {
    if (!sameOrigin(c)) return c.json({ error: 'cross-site request' }, 403)
    const b = await c.req.json().catch(() => null)
    const username = typeof b?.username === 'string' ? b.username.trim().toLowerCase() : ''
    const password = typeof b?.password === 'string' ? b.password : ''
    if (!username || !password || password.length > 256) return c.json({ error: 'username and password are required' }, 400)
    const ip = clientIp(c), k = `${ip}|${username}`
    if (tooMany(k, 5) || tooMany(ip, 30)) return c.json({ error: 'too many attempts, try again in 15 minutes' }, 429)
    const user = await users.verify(username, password)
    if (!user) {
      fail(k); fail(ip)
      console.warn(`[panya] login failed for "${username}" from ${ip}`)
      return c.json({ error: 'wrong username or password' }, 401)
    }
    fails.delete(k)
    const s = await users.startSession(user, ip)
    setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, secure: secureCookie(c), sameSite: 'Lax', path: '/', expires: new Date(s.expiresAt) })
    console.log(`[panya] login ${user.username} (${user.role}) from ${ip}`)
    return c.json({ username: user.username, role: user.role, brains: user.brains, expiresAt: s.expiresAt })
  })

  app.post('/auth/logout', async (c) => {
    const sid = getCookie(c, SESSION_COOKIE)
    if (sid) await users.endSession(sid)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/auth/me', async (c) => {
    const s = await sessionOf(c)
    if (!s) return c.json({ error: 'not signed in', loginRequired: users.loginRequired }, 401)
    return c.json({ username: s.user.username, role: s.user.role, brains: s.user.brains, expiresAt: s.expiresAt })
  })

  // เปลี่ยนรหัสผ่านของตัวเอง ต้องใส่รหัสเดิม · session อื่นของผู้ใช้นี้ถูกปิดหมด แล้วออก session ใหม่ให้เครื่องนี้
  app.post('/auth/password', async (c) => {
    if (!sameOrigin(c)) return c.json({ error: 'cross-site request' }, 403)
    const s = await sessionOf(c)
    if (!s) return c.json({ error: 'not signed in' }, 401)
    const b = await c.req.json().catch(() => null)
    if (typeof b?.next !== 'string' || b.next.length < MIN_PASSWORD || b.next.length > 256) return c.json({ error: `new password must be ${MIN_PASSWORD}-256 characters` }, 400)
    const ip = clientIp(c), k = `${ip}|${s.user.username}`
    if (tooMany(k, 5)) return c.json({ error: 'too many attempts, try again in 15 minutes' }, 429)
    if (typeof b?.current !== 'string' || !(await users.verify(s.user.username, b.current))) { fail(k); return c.json({ error: 'current password is wrong' }, 401) }
    await users.update(s.user.username, { password: b.next })
    const fresh = await users.startSession(s.user, ip)
    setCookie(c, SESSION_COOKIE, fresh.token, { httpOnly: true, secure: secureCookie(c), sameSite: 'Lax', path: '/', expires: new Date(fresh.expiresAt) })
    return c.json({ ok: true })
  })

  // หน้าแผนที่ความจำ: ตัวหน้าไม่มีข้อมูล ข้อมูลมาจาก /v1/graph ซึ่งต้องมี key
  app.get('/brain', page('./brain.html'))
  // หน้าแดชบอร์ดรวมทุก brain: ข้อมูลมาจาก /v1/overview ซึ่งต้องมี key เช่นกัน
  app.get('/dashboard', page('./dashboard.html'))
  // คลังสินค้าสามมิติ: โซน = brain, ชั้นวาง = หมวด, กล่อง = ความจำ · ข้อมูลมาจาก /v1/overview, /v1/points, /v1/events
  app.get('/warehouse', page('./warehouse.html'))
  // หน้าจัดการผู้ใช้ (admin) · ข้อมูลมาจาก /v1/users
  app.get('/users', page('./users.html'))

  // ไฟล์เสียงประกอบของหน้าแดชบอร์ด: เฉพาะไฟล์ใน src/assets และเฉพาะชื่อที่เป็นตัวพิมพ์เล็ก ตัวเลข ขีดกลาง
  // รองรับ Range เพื่อให้เบราว์เซอร์เลื่อนตำแหน่งเพลงและเล่นวนได้
  const AUDIO = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', js: 'text/javascript; charset=utf-8' } as const
  app.get('/assets/:file', async (c) => {
    const m = c.req.param('file').match(/^[a-z0-9-]+\.(mp3|ogg|wav|js)$/)
    if (!m) return c.notFound()
    const file = Bun.file(new URL('./assets/' + m[0], import.meta.url))
    if (!(await file.exists())) return c.notFound()
    const headers = { 'content-type': AUDIO[m[1] as keyof typeof AUDIO], 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' }
    const range = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/)
    if (!range || (!range[1] && !range[2])) return new Response(file, { headers: { ...headers, 'content-length': String(file.size) } })
    // "a-b" = ช่วง, "a-" = ตั้งแต่ a ถึงท้าย, "-n" = n ไบต์สุดท้าย
    const start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1
    if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.size}` } })
    return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${file.size}`, 'content-length': String(end - start + 1) } })
  })

  // ── ตัวนับการใช้งาน ───────────────────────────────────────────────
  // อยู่ในหน่วยความจำของ process นี้ รีสตาร์ตแล้วเริ่มนับใหม่ · วงแหวน 60 ช่อง ช่องละหนึ่งนาที
  // นับรวมทั้งเซิร์ฟเวอร์ และแยกต่อ brain เพื่อให้แดชบอร์ดสลับดูทีละ brain ได้
  const startedAt = Date.now()
  const counter = () => ({ ring: Array.from({ length: 60 }, () => ({ minute: -1, searches: 0, abstained: 0 })), searches: 0, abstained: 0, searchMs: 0 })
  type Counter = ReturnType<typeof counter>
  const usage = counter()
  const usageByBrain = new Map<string, Counter>()
  const bump = (u: Counter, minute: number, ms: number, abstained: boolean) => {
    const slot = u.ring[minute % 60]!
    if (slot.minute !== minute) { slot.minute = minute; slot.searches = 0; slot.abstained = 0 }
    slot.searches++; u.searches++; u.searchMs += ms
    if (abstained) { slot.abstained++; u.abstained++ }
  }
  const recordSearch = (brain: string, ms: number, abstained: boolean) => {
    const minute = Math.floor(Date.now() / 60_000)
    bump(usage, minute, ms, abstained)
    if (!usageByBrain.has(brain)) usageByBrain.set(brain, counter())
    bump(usageByBrain.get(brain)!, minute, ms, abstained)
  }
  // 60 นาทีล่าสุดของตัวนับหนึ่งตัว ช่องสุดท้าย = นาทีปัจจุบัน
  const lastHour = (u: Counter) => {
    const minute = Math.floor(Date.now() / 60_000)
    const slots = Array.from({ length: 60 }, (_, i) => {
      const m = minute - 59 + i, slot = u.ring[m % 60]!
      return slot.minute === m ? slot : { searches: 0, abstained: 0 }
    })
    return {
      total: u.searches, abstained: u.abstained, avgMs: u.searches ? Math.round(u.searchMs / u.searches) : 0,
      minute: slots.map((s) => s.searches), abstainedMinute: slots.map((s) => s.abstained),
    }
  }

  // ── เหตุการณ์สด ───────────────────────────────────────────────────
  // ความจำที่เข้า (เขียน) ออก (ค้น) และถูกลบ ผ่านเซิร์ฟเวอร์นี้ เก็บ 300 รายการล่าสุดไว้ให้หน้าแดชบอร์ดดึงไปแสดง
  type LiveEvent = {
    seq: number; at: number; type: 'in' | 'out' | 'del'; brain: string; n: number; text: string
    created?: number; superseded?: number; merged?: number
    hits?: number; abstained?: boolean; reason?: string; ms?: number; what?: 'memory' | 'source' | 'brain'; group?: string
  }
  const events: LiveEvent[] = []
  let seq = 0
  const snip = (s: string) => (s.length > 140 ? s.slice(0, 140) + '…' : s)
  const emit = (e: Omit<LiveEvent, 'seq' | 'at'>) => {
    events.push({ seq: ++seq, at: Date.now(), ...e })
    if (events.length > 300) events.shift()
  }
  const tally = (results: { action: 'created' | 'superseded' | 'merged' }[]) => {
    const t = { created: 0, superseded: 0, merged: 0 }
    for (const r of results) t[r.action]++
    return t
  }

  // สถิติรวมต้องอ่านทั้ง collection จึงเก็บผลไว้ชั่วครู่ และทิ้งทันทีเมื่อมีการเขียนหรือลบผ่านเซิร์ฟเวอร์นี้
  const OVERVIEW_TTL = 5000
  type Overview = { at: number; ms: number; brains: Awaited<ReturnType<MemoryStore['overview']>> }
  let overview: Overview | null = null
  let scanning: Promise<Overview> | null = null
  // แผนที่ความจำคำนวณหนัก (PCA + เพื่อนบ้าน) แดชบอร์ดหลายจอขอซ้ำบ่อย จึงเก็บผลไว้ครึ่งนาที
  const GRAPH_TTL = 30_000
  const graphs = new Map<string, { at: number; graph: Promise<Awaited<ReturnType<MemoryStore['graph']>>> }>()
  const loadGraph = (brain: string, limit: number) => {
    const k = `${brain}|${limit}`, hit = graphs.get(k)
    if (hit && Date.now() - hit.at < GRAPH_TTL) return hit.graph
    const graph = store.graph(brain, { limit })
    graph.catch(() => graphs.delete(k))
    graphs.set(k, { at: Date.now(), graph })
    return graph
  }
  const changed = () => { overview = null; graphs.clear() }
  const loadOverview = (): Promise<Overview> => {
    if (overview && Date.now() - overview.at < OVERVIEW_TTL) return Promise.resolve(overview)
    scanning ??= (async () => {
      const t0 = performance.now()
      const brains = await store.overview()
      const fresh: Overview = { at: Date.now(), ms: Math.round(performance.now() - t0), brains }
      overview = fresh
      return fresh
    })().finally(() => { scanning = null })
    return scanning
  }

  app.use('/v1/*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s*/i, '').trim() ?? ''
    if (keys.has(token)) {
      const bound = keys.get(token)
      c.set('scope', bound ? new Set([bound]) : null)
      c.set('wscope', bound ? new Set([bound]) : null)
      return next()
    }
    // ผู้ใช้: ล็อกอินด้วย cookie (หน้าเว็บ) หรือ API key ของผู้ใช้เอง (pnu_...) · สิทธิ์เท่ากันทั้งสองทาง
    const asUser = async (u: User) => {
      // viewer อ่านและค้นได้ แต่เขียน นำเข้า หรือลบไม่ได้
      if (u.role === 'viewer' && c.req.method !== 'GET' && c.req.path !== '/v1/search') return c.json({ error: 'read-only user' }, 403)
      // อ่านได้: สมองของตัวเอง + ที่เจ้าของแชร์ให้ + ที่ admin อนุญาต · เขียนได้: เฉพาะสมองของตัวเอง
      if (u.role === 'admin') { c.set('scope', null); c.set('wscope', null) }
      else {
        const { own, shared } = await store.brains.accessFor(u.username)
        c.set('scope', u.brains.includes('*') ? null : new Set([...own, ...shared, ...u.brains]))
        c.set('wscope', new Set(u.role === 'member' ? own : []))
      }
      c.set('user', u)
      return next()
    }
    if (token.startsWith('pnu_')) {
      const u = await users.userForKey(token)
      if (u) { c.set('viaKey', true); return asUser(u) }
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (!token) {
      const s = await sessionOf(c)
      if (s) {
        if (c.req.method !== 'GET' && !sameOrigin(c)) return c.json({ error: 'cross-site request' }, 403)
        return asUser(s.user)
      }
    }
    // แดชบอร์ดสาธารณะ: ไม่มี key ก็อ่านสถิติและเหตุการณ์ได้ เฉพาะสอง endpoint นี้ และเฉพาะ GET
    // ส่ง key มาแต่ผิด = ปฏิเสธเสมอ ไม่ปล่อยผ่านเป็นผู้ชม เพื่อให้ผู้เรียกรู้ว่า key ใช้ไม่ได้
    if (!token && c.req.method === 'GET' && PUBLIC_READ.has(c.req.path) && publicAllowed(c)) {
      c.set('scope', null)
      c.set('wscope', new Set())
      c.set('viewer', true)
      return next()
    }
    return c.json({ error: 'unauthorized' }, 401)
  })

  // key ที่ผูก brain จะอ่าน/เขียนได้เฉพาะ brain นั้น ไม่ว่าคำขอจะส่งอะไรมา
  // รับชื่อฟิลด์ container ด้วยเพื่อไม่ให้ผู้เรียกรุ่นแรกพัง
  const brainOf = (scope: Set<string> | null, ...requested: unknown[]): string | null => {
    const name = requested.find((r) => typeof r === 'string' && r)
    if (typeof name !== 'string' || !BRAIN_NAME.test(name)) return null
    if (scope !== null && !scope.has(name)) return null
    return name
  }
  const denied = { error: 'brain not allowed' }

  // ตรวจรูปแบบของหนึ่งรายการ คืน error เป็นข้อความ หรือ input ที่พร้อมบันทึก
  const parseMemory = (brain: string, b: any, keepTime = false): string | RememberInput => {
    if (typeof b?.text !== 'string' || !b.text.trim()) return 'text is required'
    if (b.text.length > 2000) return 'text too long (max 2000): send one fact per memory'
    if (b.kind !== undefined && !KINDS.has(b.kind)) return 'invalid kind'
    for (const f of ['subject', 'attribute', 'source', 'ref']) {
      if (b[f] !== undefined && (typeof b[f] !== 'string' || b[f].length > 191)) return `invalid ${f}`
    }
    // กฎสำคัญ: ห้ามเก็บความลับ (ดู src/secrets.ts)
    for (const f of ['text', 'subject', 'attribute', 'source', 'ref']) {
      const hit = typeof b[f] === 'string' ? findSecret(b[f]) : null
      if (hit) return `${SECRET_REFUSED} (${hit.rule} in ${f})`
    }
    let validUntil: number | undefined
    if (b.validUntil !== undefined && b.validUntil !== 0) {
      validUntil = typeof b.validUntil === 'number' ? b.validUntil : Date.parse(b.validUntil)
      if (!Number.isFinite(validUntil)) return 'invalid validUntil'
    }
    let now: number | undefined
    if (keepTime && b.createdAt !== undefined) {
      now = typeof b.createdAt === 'number' ? b.createdAt : Date.parse(b.createdAt)
      if (!Number.isFinite(now)) return 'invalid createdAt'
    }
    return { container: brain, text: b.text, subject: b.subject, attribute: b.attribute, kind: b.kind, validUntil, source: b.source, ref: b.ref, now }
  }

  const parseMany = (brain: string, list: unknown, max: number, keepTime = false): string | RememberInput[] => {
    if (!Array.isArray(list) || list.length === 0) return 'memories must be a non-empty array'
    if (list.length > max) return `too many memories (max ${max} per request)`
    const inputs: RememberInput[] = []
    for (let i = 0; i < list.length; i++) {
      const input = parseMemory(brain, list[i], keepTime)
      if (typeof input === 'string') return `memories[${i}]: ${input}`
      inputs.push(input)
    }
    return inputs
  }

  app.post('/v1/memories', async (c) => {
    const b = await c.req.json().catch(() => null)
    const brain = brainOf(c.get('wscope'), b?.brain, b?.container)
    if (!brain) return c.json(denied, 403)
    const input = parseMemory(brain, b)
    if (typeof input === 'string') return c.json({ error: input }, 400)
    const r = await store.remember(input)
    changed()
    emit({ type: 'in', brain, n: 1, text: snip(input.text), group: groupOfInput(input), ...tally([r]) })
    return c.json({ memory: present(r.memory), action: r.action }, r.action === 'merged' ? 200 : 201)
  })

  // บันทึกหลายรายการในคำขอเดียว: { brain, memories: [{ text, ... }] } เร็วกว่ายิงทีละรายการ
  app.post('/v1/memories/batch', async (c) => {
    const b = await c.req.json().catch(() => null)
    const brain = brainOf(c.get('wscope'), b?.brain, b?.container)
    if (!brain) return c.json(denied, 403)
    const inputs = parseMany(brain, b.memories, 200)
    if (typeof inputs === 'string') return c.json({ error: inputs }, 400)
    const results = await store.rememberMany(inputs)
    changed()
    emit({ type: 'in', brain, n: inputs.length, text: snip(inputs[0]!.text), group: groupOfInput(inputs[0]!), ...tally(results) })
    return c.json({ results: results.map((r) => ({ memory: present(r.memory), action: r.action })) }, 201)
  })

  app.post('/v1/search', async (c) => {
    const b = await c.req.json().catch(() => null)
    const brain = brainOf(c.get('scope'), b?.brain, b?.container)
    if (!brain) return c.json(denied, 403)
    if (typeof b.q !== 'string' || !b.q.trim()) return c.json({ error: 'q is required' }, 400)
    if (b.q.length > 1000) return c.json({ error: 'q too long (max 1000)' }, 400)
    const limit = Math.max(1, Math.min(20, Number(b.limit) || 5))
    // minScore ให้ผู้เรียกปรับความเข้มของการไม่ตอบได้ ถ้าเนื้อหาต่างจากที่เกณฑ์ตั้งต้นถูกปรับมา
    const tuning = typeof b.minScore === 'number' && b.minScore >= 0 && b.minScore <= 1 ? { minScore: b.minScore } : undefined
    const t0 = performance.now()
    // rerank: false = ข้าม reranker สำหรับคำขอนี้ (เมื่อผู้เรียกต้องการความเร็วมากกว่าความแม่น)
    const r = await store.search(brain, b.q, { limit, tuning, rerank: b.rerank === false ? false : undefined })
    const ms = Math.round(performance.now() - t0)
    recordSearch(brain, ms, r.abstained)
    emit({ type: 'out', brain, n: r.hits.length, text: snip(b.q), hits: r.hits.length, abstained: r.abstained, reason: r.reason, ms })
    return c.json({ ...r, hits: r.hits.map(({ container, ...h }) => ({ ...h, brain: container })) })
  })

  app.get('/v1/graph', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const limit = Math.max(1, Math.min(3000, Number(c.req.query('limit')) || 1500))
    const g = await loadGraph(brain, limit)
    // ผู้ชมที่ไม่มี key ได้เฉพาะตำแหน่ง หมวด และชนิด ไม่ได้ข้อความ subject หรือชื่อไฟล์ต้นทาง
    if (c.get('viewer')) {
      return c.json({
        nodes: g.nodes.map((n) => ({ id: n.id, kind: n.kind, count: n.count, createdAt: n.createdAt, x: n.x, y: n.y, group: groupOf(n.source, n.subject, n.kind) })),
        edges: g.edges,
      })
    }
    return c.json({ ...g, nodes: g.nodes.map((n) => ({ ...n, group: groupOf(n.source, n.subject, n.kind) })) })
  })

  // ── ทุกความจำเป็นจุด (สำหรับภาพสมองบนแดชบอร์ด) ───────────────────
  // คำนวณจาก embedding ทั้งชุดจึงหนัก: เก็บผลไว้ 10 นาที และไม่ทิ้งทุกครั้งที่มีการเขียน (จุดใหม่จะขึ้นในรอบถัดไป)
  // ส่งเป็นอาร์เรย์แยกตามช่องเพื่อให้ขนาดเล็ก ไม่มีข้อความความจำ ใครอ่านได้เท่ากับ /v1/graph แบบผู้ชม
  const POINTS_TTL = 10 * 60_000
  const pointsCache = new Map<string, { at: number; data: Promise<object> }>()
  const buildPoints = async (brain: string) => {
    const t0 = performance.now()
    const p = await store.points(brain)
    const groupIndex = new Map<string, number>()
    const g = p.metas.map((m) => {
      const name = groupOf(m.source, m.subject, m.kind)
      if (!groupIndex.has(name)) groupIndex.set(name, groupIndex.size)
      return groupIndex.get(name)!
    })
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4
    return {
      brain, computedAt: Date.now(), ms: Math.round(performance.now() - t0), total: p.metas.length,
      groups: [...groupIndex.keys()], ids: p.metas.map((m) => m.id), x: p.xs.map(r4), y: p.ys.map(r4), g,
      t: p.metas.map((m) => m.createdAt), c: p.metas.map((m) => m.count), edges: p.edges.map(([a, b]) => [a, b]),
    }
  }
  app.get('/v1/points', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const hit = pointsCache.get(brain)
    if (hit && Date.now() - hit.at <= POINTS_TTL) return c.json(await hit.data)
    // หมดอายุแล้ว: ส่งชุดเดิมไปก่อน แล้วคำนวณใหม่เบื้องหลัง ผู้ใช้ไม่ต้องรอ
    const fresh = { at: Date.now(), data: buildPoints(brain) }
    fresh.data.then(() => pointsCache.set(brain, fresh), () => { if (pointsCache.get(brain) === fresh) pointsCache.delete(brain) })
    if (hit) { hit.at = Date.now(); return c.json(await hit.data) }
    pointsCache.set(brain, fresh)
    return c.json(await fresh.data)
  })

  // เปิดเซิร์ฟเวอร์แล้วคำนวณจุดของทุก brain ล่วงหน้าทีละใบ ผู้เปิดแดชบอร์ดคนแรกจึงไม่ต้องรอ
  if (opts.warmPoints) {
    setTimeout(async () => {
      try {
        for (const b of await store.overview()) {
          if (pointsCache.has(b.brain)) continue
          const entry = { at: Date.now(), data: buildPoints(b.brain) }
          pointsCache.set(b.brain, entry)
          await entry.data.catch(() => pointsCache.delete(b.brain))
        }
      } catch (err) { console.error('[panya] warm points', err) }
    }, 5000)
  }

  // ความจำหนึ่งรายการ (ต้องมี key) ใช้แสดงข้อความเมื่อชี้จุดบนภาพสมอง
  app.get('/v1/memories/:id', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const m = await store.getOne(brain, c.req.param('id'))
    return m ? c.json({ memory: present(m) }) : c.json({ error: 'not found' }, 404)
  })

  app.get('/v1/profile', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const p = await store.profile(brain)
    return c.json({ preferences: p.preferences.map(present), keyed: p.keyed.map(present), recent: p.recent.map(present) })
  })

  app.get('/v1/stats', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'))
    if (!brain) return c.json(denied, 403)
    return c.json({ brain, memories: await store.count(brain) })
  })

  // สถิติของทุก brain ที่ key นี้เข้าถึงได้ · key ที่ผูก brain เห็นเฉพาะ brain ของตัวเอง และไม่เห็นตัวเลขของเซิร์ฟเวอร์
  app.get('/v1/overview', async (c) => {
    const scope = c.get('scope')
    const o = await loadOverview()
    const brains = scope === null ? o.brains : o.brains.filter((b) => scope.has(b.brain))
    const user = c.get('user')
    const me = user ? { username: user.username, role: user.role } : undefined
    if (scope !== null) return c.json({ now: o.at, brains, me })
    return c.json({
      now: o.at,
      brains,
      me,
      // viewer = เปิดดูโดยไม่มี key (โหมดแดชบอร์ดสาธารณะ) อ่านได้อย่างเดียว
      viewer: c.get('viewer') === true,
      searches: { ...lastHour(usage), brains: Object.fromEntries([...usageByBrain].map(([b, u]) => [b, lastHour(u)])) },
      server: { startedAt, scanMs: o.ms, rssMb: Math.round(process.memoryUsage().rss / 1048576) },
    })
  })

  // ── อ่านทั้งชุดตาม subject ────────────────────────────────────────
  // ใช้กับเอกสารที่ถูกตัดเป็นหลายความจำใต้ subject เดียว (เช่น skill หรือไฟล์ความจำ) เพื่อประกอบกลับตามลำดับ
  app.get('/v1/memories', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const subject = c.req.query('subject')
    if (!subject || subject.length > 191) return c.json({ error: 'subject is required (max 191)' }, 400)
    return c.json({ brain, subject, memories: (await store.bySubject(brain, subject)).map(present) })
  })

  // รายชื่อ subject ที่ขึ้นต้นด้วย prefix พร้อมจำนวนชิ้นและคำอธิบาย
  app.get('/v1/subjects', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const prefix = c.req.query('prefix') ?? ''
    if (prefix.length > 191) return c.json({ error: 'prefix too long (max 191)' }, 400)
    return c.json({ brain, prefix, subjects: await store.subjects(brain, prefix) })
  })

  // เหตุการณ์สดหลังลำดับ after · ไม่ส่ง after = 40 รายการล่าสุด · key ที่ผูก brain เห็นเฉพาะของ brain ตัวเอง
  app.get('/v1/events', (c) => {
    const scope = c.get('scope')
    const after = c.req.query('after')
    let list = scope === null ? events : events.filter((e) => scope.has(e.brain))
    list = after === undefined ? list.slice(-40) : list.filter((e) => e.seq > Number(after)).slice(-200)
    return c.json({ seq, now: Date.now(), events: list })
  })

  // ── นำข้อมูลออก/เข้า ─────────────────────────────────────────────
  // ข้อมูลเป็นของเจ้าของ brain: เอาออกได้ทั้งหมดในรูปแบบที่นำกลับเข้าได้ทันที
  app.get('/v1/export', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'))
    if (!brain) return c.json(denied, 403)
    const history = c.req.query('history') === '1'
    const memories = (await store.exportAll(brain, { history })).map((m) => ({
      text: m.text, subject: m.subject, attribute: m.attribute, kind: m.kind, source: m.source, ref: m.ref,
      createdAt: m.createdAt, validUntil: m.validUntil, count: m.count, active: m.active,
    }))
    c.header('content-disposition', `attachment; filename="panya-${brain}.json"`)
    return c.json({ format: 'panya-export', version: 1, brain, exportedAt: new Date().toISOString(), entities: await store.entities.list(brain), memories })
  })

  // { brain, memories: [...], entities?: [...], replace?: true }
  // ตรวจทุกรายการก่อน ถ้ามีรายการผิดรูปแบบจะไม่บันทึกอะไรเลย · replace = ล้าง brain ก่อนนำเข้า
  app.post('/v1/import', async (c) => {
    const b = await c.req.json().catch(() => null)
    const brain = brainOf(c.get('wscope'), b?.brain)
    if (!brain) return c.json(denied, 403)
    // รุ่นที่ถูกแทนแล้วไม่นำเข้า: ถ้านำเข้าจะกลับมาเป็นค่าปัจจุบันและทับค่าที่ถูกต้อง
    const live = Array.isArray(b.memories) ? b.memories.filter((m: any) => m?.active !== false) : b.memories
    const inputs = parseMany(brain, live, IMPORT_MAX, true)
    if (typeof inputs === 'string') return c.json({ error: inputs }, 400)
    const entities = b.entities ?? []
    if (!Array.isArray(entities) || !entities.every(validEntity)) return c.json({ error: 'invalid entities' }, 400)
    changed()
    if (b.replace === true) await store.clear(brain)
    for (const e of entities) await store.entities.register(brain, e.type, e.cues ?? [], e.names ?? [])
    const counts = { created: 0, superseded: 0, merged: 0 }
    for (let i = 0; i < inputs.length; i += 200) {
      for (const r of await store.rememberMany(inputs.slice(i, i + 200))) counts[r.action]++
    }
    emit({ type: 'in', brain, n: inputs.length, text: snip(inputs[0]!.text), group: groupOfInput(inputs[0]!), ...counts })
    return c.json({ brain, imported: inputs.length, ...counts }, 201)
  })

  // ── ชื่อเฉพาะ ────────────────────────────────────────────────────
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() && x.length <= 191)
  const validEntity = (e: any) =>
    typeof e?.type === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.type) && strs(e.cues ?? []) && strs(e.names ?? [])

  // { brain, type, cues: ["ลูกค้า"], names: ["ไทยฟู้ดส์"] }
  app.put('/v1/entities', async (c) => {
    const b = await c.req.json().catch(() => null)
    const brain = brainOf(c.get('wscope'), b?.brain, b?.container)
    if (!brain) return c.json(denied, 403)
    if (!validEntity(b)) return c.json({ error: 'invalid type, cues or names' }, 400)
    await store.entities.register(brain, b.type, b.cues ?? [], b.names ?? [])
    return c.json({ ok: true })
  })

  app.get('/v1/entities', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    return c.json({ types: await store.entities.list(brain) })
  })

  // ── ลบ ───────────────────────────────────────────────────────────
  app.delete('/v1/memories/:id', async (c) => {
    const brain = brainOf(c.get('wscope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const ok = await store.forget(brain, c.req.param('id'))
    changed()
    if (ok) emit({ type: 'del', brain, n: 1, text: '', what: 'memory' })
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })

  // ลบทุกความจำที่มาจากแหล่งเดียวกัน ใช้ตอนแทนที่หรือถอนไฟล์ต้นทาง
  app.delete('/v1/sources', async (c) => {
    const brain = brainOf(c.get('wscope'), c.req.query('brain'))
    if (!brain) return c.json(denied, 403)
    const source = c.req.query('source')
    if (!source) return c.json({ error: 'source is required' }, 400)
    await store.forgetSource(brain, source)
    changed()
    emit({ type: 'del', brain, n: 0, text: snip(source), what: 'source' })
    return c.json({ ok: true })
  })

  // ล้างทั้ง brain กู้คืนไม่ได้ ต้องส่ง confirm=ชื่อ brain ซ้ำเพื่อกันยิงผิด
  app.delete('/v1/brain', async (c) => {
    const brain = brainOf(c.get('wscope'), c.req.query('brain'))
    if (!brain) return c.json(denied, 403)
    if (c.req.query('confirm') !== brain) return c.json({ error: 'confirm must equal the brain name' }, 400)
    await store.clear(brain)
    changed()
    emit({ type: 'del', brain, n: 0, text: '', what: 'brain' })
    return c.json({ ok: true })
  })

  // ── สมองของผู้ใช้ ───────────────────────────────────────────────
  // member สร้างสมองของตัวเองได้ เป็นเจ้าของ เขียน/ลบ/แชร์ได้ · คนที่ได้รับแชร์อ่านได้อย่างเดียว
  // สมองที่ไม่มีในทะเบียน (เดิม หรือสร้างด้วย API key) เป็นของ admin
  const ADMIN_OWNED = '(admin)'
  const canManage = (c: Context<Env>, owner: string) => {
    const u = c.get('user')
    return u ? u.role === 'admin' || u.username === owner : c.get('scope') === null && !c.get('viewer')
  }

  // สมองที่ผู้เรียกเห็นได้ พร้อมเจ้าของ สิทธิ์ของตัวเอง และขนาด
  app.get('/v1/brains', async (c) => {
    const scope = c.get('scope'), wscope = c.get('wscope'), u = c.get('user')
    const reg = await store.brains.list()
    const sizes = new Map((await loadOverview()).brains.map((b) => [b.brain, b.live]))
    const names = new Set([...sizes.keys(), ...reg.keys()])
    const brains = [...names].filter((n) => scope === null || scope.has(n)).sort().map((name) => {
      const info = reg.get(name)
      const owner = info?.owner ?? ADMIN_OWNED
      return {
        name, owner, description: info?.description ?? '', createdAt: info?.createdAt ?? 0, memories: sizes.get(name) ?? 0,
        access: wscope === null || wscope.has(name) ? 'owner' : 'read',
        // รายชื่อผู้อ่านแสดงเฉพาะคนที่จัดการสมองนั้นได้
        readers: canManage(c, owner) ? info?.readers ?? [] : undefined,
      }
    })
    return c.json({ me: u ? { username: u.username, role: u.role } : undefined, canCreate: !u || u.role !== 'viewer', brains })
  })

  // { name, description? } · ชื่อซ้ำกับสมองที่มีอยู่ (ทั้งในทะเบียนและในฐานข้อมูล) ไม่ได้
  app.post('/v1/brains', async (c) => {
    const u = c.get('user')
    if (u?.role === 'viewer' || c.get('viewer') || (!u && c.get('scope') !== null)) return c.json({ error: 'not allowed to create brains' }, 403)
    const b = await c.req.json().catch(() => null)
    const name = typeof b?.name === 'string' ? b.name.trim() : ''
    if (!BRAIN_NAME.test(name)) return c.json({ error: 'name must be 1-128 characters: letters, digits, . _ : -' }, 400)
    const description = typeof b?.description === 'string' ? b.description.trim().slice(0, 500) : ''
    if (findSecret(description)) return c.json({ error: SECRET_REFUSED }, 400)
    const exists = (await store.brains.get(name)) || (await loadOverview()).brains.some((x) => x.brain === name)
    if (exists) return c.json({ error: 'a brain with this name already exists' }, 409)
    // member มีได้ไม่เกิน 20 สมอง กันการสร้างทิ้งไว้เต็มฐานข้อมูล
    if (u && u.role !== 'admin' && (await store.brains.accessFor(u.username)).own.length >= 20) return c.json({ error: 'brain limit reached (20 per user)' }, 409)
    await store.brains.create(name, u?.username ?? ADMIN_OWNED, description)
    return c.json({ name, owner: u?.username ?? ADMIN_OWNED, description }, 201)
  })

  // { description?, readers?: [username] } · เฉพาะเจ้าของหรือ admin
  app.patch('/v1/brains/:name', async (c) => {
    const name = c.req.param('name')
    const info = await store.brains.get(name)
    if (!canManage(c, info?.owner ?? ADMIN_OWNED)) return c.json({ error: 'only the owner can change this brain' }, 403)
    const b = await c.req.json().catch(() => null)
    if (!b || typeof b !== 'object') return c.json({ error: 'body must be a JSON object' }, 400)
    const patch: { description?: string; readers?: string[] } = {}
    if (b.description !== undefined) {
      if (typeof b.description !== 'string' || findSecret(b.description)) return c.json({ error: 'invalid description' }, 400)
      patch.description = b.description.trim().slice(0, 500)
    }
    if (b.readers !== undefined) {
      if (!Array.isArray(b.readers) || b.readers.length > 200 || !b.readers.every((x: unknown) => typeof x === 'string' && USERNAME.test(x))) return c.json({ error: 'readers must be a list of usernames' }, 400)
      const known = new Set((await users.list()).map((x) => x.username))
      const unknown = b.readers.filter((x: string) => !known.has(x))
      if (unknown.length) return c.json({ error: `unknown users: ${unknown.join(', ')}` }, 400)
      patch.readers = b.readers.filter((x: string) => x !== info?.owner)
    }
    // สมองเดิมที่ยังไม่อยู่ในทะเบียน: ลงทะเบียนเป็นของ admin ก่อนแก้
    if (!info) await store.brains.create(name, ADMIN_OWNED, '')
    await store.brains.update(name, patch)
    return c.json({ brain: await store.brains.get(name) })
  })

  // ลบทั้งสมอง (ความจำ + ทะเบียน) กู้คืนไม่ได้ · ต้องส่ง confirm=ชื่อสมอง · เฉพาะเจ้าของหรือ admin
  app.delete('/v1/brains/:name', async (c) => {
    const name = c.req.param('name')
    if (!BRAIN_NAME.test(name)) return c.json({ error: 'invalid name' }, 400)
    const info = await store.brains.get(name)
    if (!canManage(c, info?.owner ?? ADMIN_OWNED)) return c.json({ error: 'only the owner can delete this brain' }, 403)
    if (c.req.query('confirm') !== name) return c.json({ error: 'confirm must equal the brain name' }, 400)
    await store.clear(name)
    await store.brains.remove(name)
    changed()
    emit({ type: 'del', brain: name, n: 0, text: '', what: 'brain' })
    return c.json({ ok: true })
  })

  // ── API key ของผู้ใช้ ─────────────────────────────────────────────
  // สร้าง/ยกเลิกได้เฉพาะตอนล็อกอินผ่านหน้าเว็บ (cookie) ไม่ให้ key หนึ่งสร้าง key อื่นต่อได้เอง
  const webUser = (c: Context<Env>) => (c.get('viaKey') ? undefined : c.get('user'))
  app.get('/v1/keys', async (c) => {
    const u = webUser(c)
    if (!u) return c.json({ error: 'sign in on the web page to manage API keys' }, 403)
    return c.json({ keys: await users.listKeys(u.username) })
  })
  // { name } → { key } แสดง key เต็มครั้งเดียว
  app.post('/v1/keys', async (c) => {
    const u = webUser(c)
    if (!u) return c.json({ error: 'sign in on the web page to manage API keys' }, 403)
    const b = await c.req.json().catch(() => null)
    const name = typeof b?.name === 'string' ? b.name.trim() : ''
    if (!name || name.length > 64) return c.json({ error: 'name is required (max 64), e.g. "laptop" or "claude-code"' }, 400)
    if ((await users.listKeys(u.username)).length >= 10) return c.json({ error: 'key limit reached (10 per user); revoke one first' }, 409)
    const { key, info } = await users.createKey(u.username, name)
    console.log(`[panya] api key ${info.id} created by ${u.username}`)
    return c.json({ key, ...info }, 201)
  })
  app.delete('/v1/keys/:id', async (c) => {
    const u = webUser(c)
    if (!u) return c.json({ error: 'sign in on the web page to manage API keys' }, 403)
    return (await users.revokeKey(u.username, c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })

  // รายชื่อผู้ใช้ (ชื่ออย่างเดียว) ให้เจ้าของสมองเลือกคนที่จะแชร์
  app.get('/v1/usernames', async (c) => {
    if (!c.get('user') && c.get('scope') !== null) return c.json({ error: 'not allowed' }, 403)
    return c.json({ usernames: (await users.list()).filter((x) => !x.disabled).map((x) => x.username) })
  })

  // ── จัดการผู้ใช้ ─────────────────────────────────────────────────
  // ได้เฉพาะผู้ใช้ role admin หรือ API key ที่ไม่ผูก brain
  const isAdmin = (c: Context<Env>) => {
    const u = c.get('user')
    return u ? u.role === 'admin' : c.get('scope') === null && !c.get('viewer')
  }
  const validBrains = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length <= 100 && v.every((x) => typeof x === 'string' && (x === '*' || BRAIN_NAME.test(x)))
  // ต้องเหลือ admin ที่ใช้งานได้อย่างน้อยหนึ่งคนเสมอ ไม่งั้นไม่มีใครจัดการผู้ใช้ได้
  const lastAdmin = async (username: string) =>
    !(await users.list()).some((u) => u.role === 'admin' && !u.disabled && u.username !== username)

  app.get('/v1/users', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'admin only' }, 403)
    return c.json({ users: await users.list() })
  })

  // { username, role, brains, password? } ไม่ใส่ password = สุ่มให้ และคืนรหัสนั้นครั้งเดียวในคำตอบ
  app.post('/v1/users', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'admin only' }, 403)
    const b = await c.req.json().catch(() => null)
    const username = typeof b?.username === 'string' ? b.username.trim().toLowerCase() : ''
    if (!USERNAME.test(username)) return c.json({ error: 'username must be 2-64 characters: a-z 0-9 . _ -' }, 400)
    if (!ROLES.has(b?.role)) return c.json({ error: 'role must be admin, member or viewer' }, 400)
    const brains = b?.brains ?? []
    if (!validBrains(brains)) return c.json({ error: 'brains must be a list of brain names or "*"' }, 400)
    const generated = b?.password === undefined
    const password: string = generated ? randomPassword() : b.password
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 256) return c.json({ error: `password must be ${MIN_PASSWORD}-256 characters` }, 400)
    if (await users.get(username)) return c.json({ error: 'username already exists' }, 409)
    const user = await users.create(username, password, b.role as Role, brains)
    return c.json({ user, ...(generated ? { password } : {}) }, 201)
  })

  // { role?, brains?, disabled?, password? | resetPassword: true }
  app.patch('/v1/users/:name', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'admin only' }, 403)
    const name = c.req.param('name')
    const target = await users.get(name)
    if (!target) return c.json({ error: 'not found' }, 404)
    const b = await c.req.json().catch(() => null)
    if (!b || typeof b !== 'object') return c.json({ error: 'body must be a JSON object' }, 400)
    const patch: Parameters<typeof users.update>[1] = {}
    if (b.role !== undefined) { if (!ROLES.has(b.role)) return c.json({ error: 'invalid role' }, 400); patch.role = b.role }
    if (b.brains !== undefined) { if (!validBrains(b.brains)) return c.json({ error: 'invalid brains' }, 400); patch.brains = b.brains }
    if (b.disabled !== undefined) { if (typeof b.disabled !== 'boolean') return c.json({ error: 'invalid disabled' }, 400); patch.disabled = b.disabled }
    let generated: string | undefined
    if (b.resetPassword === true) patch.password = generated = randomPassword()
    else if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < MIN_PASSWORD || b.password.length > 256) return c.json({ error: `password must be ${MIN_PASSWORD}-256 characters` }, 400)
      patch.password = b.password
    }
    const demoted = (patch.role !== undefined && patch.role !== 'admin') || patch.disabled === true
    if (target.role === 'admin' && demoted && (await lastAdmin(name))) return c.json({ error: 'cannot demote or disable the last admin' }, 409)
    await users.update(name, patch)
    return c.json({ user: await users.get(name), ...(generated ? { password: generated } : {}) })
  })

  app.delete('/v1/users/:name', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'admin only' }, 403)
    const name = c.req.param('name')
    const target = await users.get(name)
    if (!target) return c.json({ error: 'not found' }, 404)
    if (target.role === 'admin' && (await lastAdmin(name))) return c.json({ error: 'cannot delete the last admin' }, 409)
    await users.remove(name)
    await store.brains.forgetUser(name)
    return c.json({ ok: true })
  })

  app.onError((err, c) => {
    console.error('[panya]', err)
    // การเชื่อมต่อ seekdb หลุดแล้วไม่ต่อใหม่เอง (เช่นหลัง Docker หรือเครื่องหลับ) ทุกคำขอจะพังจนกว่าจะรีสตาร์ต
    // จึงปิด process หลังตอบคำขอนี้ ให้ตัวสั่งเริ่ม (scripts/start-panya.ps1 หรือ Docker restart policy) เปิดใหม่
    if (opts.exitOnLostDb && isLostConnection(err)) {
      console.error('[panya] lost the seekdb connection, exiting so the launcher restarts the server')
      setTimeout(() => process.exit(1), 200)
    }
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}
