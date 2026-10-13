import { Hono } from 'hono'
import { config } from './config'
import type { Memory, MemoryStore, RememberInput } from './memory'

type Env = { Variables: { scope: string | null } }

const KINDS = new Set(['fact', 'preference', 'event'])
const BRAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const IMPORT_MAX = 5000

/** สิ่งที่ผู้เรียกเห็น: ใช้คำว่า brain แทน container ที่เป็นชื่อภายใน */
const present = ({ container, ...m }: Memory) => ({ ...m, brain: container })

export function createApp(store: MemoryStore, apiKeys: string[] = config.apiKeys) {
  // "key" ใช้ได้ทุก brain · "key@brain" ใช้ได้กับ brain เดียว
  const keys = new Map<string, string | null>()
  for (const k of apiKeys) {
    const at = k.indexOf('@')
    keys.set(at < 0 ? k : k.slice(0, at), at < 0 ? null : k.slice(at + 1))
  }

  const app = new Hono<Env>()
  app.get('/health', (c) => c.json({ ok: true }))

  // หน้าแผนที่ความจำ: ตัวหน้าไม่มีข้อมูล ข้อมูลมาจาก /v1/graph ซึ่งต้องมี key
  app.get('/brain', async (c) => c.html(await Bun.file(new URL('./brain.html', import.meta.url)).text()))
  // หน้าแดชบอร์ดรวมทุก brain: ข้อมูลมาจาก /v1/overview ซึ่งต้องมี key เช่นกัน
  app.get('/dashboard', async (c) => c.html(await Bun.file(new URL('./dashboard.html', import.meta.url)).text()))

  // ไฟล์เสียงประกอบของหน้าแดชบอร์ด: เฉพาะไฟล์ใน src/assets และเฉพาะชื่อที่เป็นตัวพิมพ์เล็ก ตัวเลข ขีดกลาง
  // รองรับ Range เพื่อให้เบราว์เซอร์เลื่อนตำแหน่งเพลงและเล่นวนได้
  const AUDIO = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' } as const
  app.get('/assets/:file', async (c) => {
    const m = c.req.param('file').match(/^[a-z0-9-]+\.(mp3|ogg|wav)$/)
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
  const startedAt = Date.now()
  const ring = Array.from({ length: 60 }, () => ({ minute: -1, searches: 0, abstained: 0 }))
  const usage = { searches: 0, abstained: 0, searchMs: 0 }
  const recordSearch = (ms: number, abstained: boolean) => {
    const minute = Math.floor(Date.now() / 60_000)
    const slot = ring[minute % 60]!
    if (slot.minute !== minute) { slot.minute = minute; slot.searches = 0; slot.abstained = 0 }
    slot.searches++; usage.searches++; usage.searchMs += ms
    if (abstained) { slot.abstained++; usage.abstained++ }
  }

  // ── เหตุการณ์สด ───────────────────────────────────────────────────
  // ความจำที่เข้า (เขียน) ออก (ค้น) และถูกลบ ผ่านเซิร์ฟเวอร์นี้ เก็บ 300 รายการล่าสุดไว้ให้หน้าแดชบอร์ดดึงไปแสดง
  type LiveEvent = {
    seq: number; at: number; type: 'in' | 'out' | 'del'; brain: string; n: number; text: string
    created?: number; superseded?: number; merged?: number
    hits?: number; abstained?: boolean; reason?: string; ms?: number; what?: 'memory' | 'source' | 'brain'
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
  const changed = () => { overview = null }
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
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!keys.has(token)) return c.json({ error: 'unauthorized' }, 401)
    c.set('scope', keys.get(token) ?? null)
    await next()
  })

  // key ที่ผูก brain จะอ่าน/เขียนได้เฉพาะ brain นั้น ไม่ว่าคำขอจะส่งอะไรมา
  // รับชื่อฟิลด์ container ด้วยเพื่อไม่ให้ผู้เรียกรุ่นแรกพัง
  const brainOf = (scope: string | null, ...requested: unknown[]): string | null => {
    const name = requested.find((r) => typeof r === 'string' && r)
    if (typeof name !== 'string' || !BRAIN_NAME.test(name)) return null
    if (scope !== null && scope !== name) return null
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
    const brain = brainOf(c.get('scope'), b?.brain, b?.container)
    if (!brain) return c.json(denied, 403)
    const input = parseMemory(brain, b)
    if (typeof input === 'string') return c.json({ error: input }, 400)
    const r = await store.remember(input)
    changed()
    emit({ type: 'in', brain, n: 1, text: snip(input.text), ...tally([r]) })
    return c.json({ memory: present(r.memory), action: r.action }, r.action === 'merged' ? 200 : 201)
  })

  // บันทึกหลายรายการในคำขอเดียว: { brain, memories: [{ text, ... }] } เร็วกว่ายิงทีละรายการ
  app.post('/v1/memories/batch', async (c) => {
    const b = await c.req.json().catch(() => null)
    const brain = brainOf(c.get('scope'), b?.brain, b?.container)
    if (!brain) return c.json(denied, 403)
    const inputs = parseMany(brain, b.memories, 200)
    if (typeof inputs === 'string') return c.json({ error: inputs }, 400)
    const results = await store.rememberMany(inputs)
    changed()
    emit({ type: 'in', brain, n: inputs.length, text: snip(inputs[0]!.text), ...tally(results) })
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
    recordSearch(ms, r.abstained)
    emit({ type: 'out', brain, n: r.hits.length, text: snip(b.q), hits: r.hits.length, abstained: r.abstained, reason: r.reason, ms })
    return c.json({ ...r, hits: r.hits.map(({ container, ...h }) => ({ ...h, brain: container })) })
  })

  app.get('/v1/graph', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const limit = Math.max(1, Math.min(3000, Number(c.req.query('limit')) || 1500))
    return c.json(await store.graph(brain, { limit }))
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
    const brains = scope === null ? o.brains : o.brains.filter((b) => b.brain === scope)
    if (scope !== null) return c.json({ now: o.at, brains })
    const minute = Math.floor(Date.now() / 60_000)
    const last60 = Array.from({ length: 60 }, (_, i) => {
      const m = minute - 59 + i
      const slot = ring[m % 60]!
      return slot.minute === m ? slot : { searches: 0, abstained: 0 }
    })
    return c.json({
      now: o.at,
      brains,
      searches: {
        total: usage.searches, abstained: usage.abstained, avgMs: usage.searches ? Math.round(usage.searchMs / usage.searches) : 0,
        minute: last60.map((s) => s.searches), abstainedMinute: last60.map((s) => s.abstained),
      },
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
    let list = scope === null ? events : events.filter((e) => e.brain === scope)
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
    const brain = brainOf(c.get('scope'), b?.brain)
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
    emit({ type: 'in', brain, n: inputs.length, text: snip(inputs[0]!.text), ...counts })
    return c.json({ brain, imported: inputs.length, ...counts }, 201)
  })

  // ── ชื่อเฉพาะ ────────────────────────────────────────────────────
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() && x.length <= 191)
  const validEntity = (e: any) =>
    typeof e?.type === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.type) && strs(e.cues ?? []) && strs(e.names ?? [])

  // { brain, type, cues: ["ลูกค้า"], names: ["ไทยฟู้ดส์"] }
  app.put('/v1/entities', async (c) => {
    const b = await c.req.json().catch(() => null)
    const brain = brainOf(c.get('scope'), b?.brain, b?.container)
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
    const brain = brainOf(c.get('scope'), c.req.query('brain'), c.req.query('container'))
    if (!brain) return c.json(denied, 403)
    const ok = await store.forget(brain, c.req.param('id'))
    changed()
    if (ok) emit({ type: 'del', brain, n: 1, text: '', what: 'memory' })
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })

  // ลบทุกความจำที่มาจากแหล่งเดียวกัน ใช้ตอนแทนที่หรือถอนไฟล์ต้นทาง
  app.delete('/v1/sources', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'))
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
    const brain = brainOf(c.get('scope'), c.req.query('brain'))
    if (!brain) return c.json(denied, 403)
    if (c.req.query('confirm') !== brain) return c.json({ error: 'confirm must equal the brain name' }, 400)
    await store.clear(brain)
    changed()
    emit({ type: 'del', brain, n: 0, text: '', what: 'brain' })
    return c.json({ ok: true })
  })

  app.onError((err, c) => {
    console.error('[panya]', err)
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}
