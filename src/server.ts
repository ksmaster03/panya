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
    const r = await store.search(brain, b.q, { limit, tuning })
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
    if (b.replace === true) await store.clear(brain)
    for (const e of entities) await store.entities.register(brain, e.type, e.cues ?? [], e.names ?? [])
    const counts = { created: 0, superseded: 0, merged: 0 }
    for (let i = 0; i < inputs.length; i += 200) {
      for (const r of await store.rememberMany(inputs.slice(i, i + 200))) counts[r.action]++
    }
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
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })

  // ลบทุกความจำที่มาจากแหล่งเดียวกัน ใช้ตอนแทนที่หรือถอนไฟล์ต้นทาง
  app.delete('/v1/sources', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'))
    if (!brain) return c.json(denied, 403)
    const source = c.req.query('source')
    if (!source) return c.json({ error: 'source is required' }, 400)
    await store.forgetSource(brain, source)
    return c.json({ ok: true })
  })

  // ล้างทั้ง brain กู้คืนไม่ได้ ต้องส่ง confirm=ชื่อ brain ซ้ำเพื่อกันยิงผิด
  app.delete('/v1/brain', async (c) => {
    const brain = brainOf(c.get('scope'), c.req.query('brain'))
    if (!brain) return c.json(denied, 403)
    if (c.req.query('confirm') !== brain) return c.json({ error: 'confirm must equal the brain name' }, 400)
    await store.clear(brain)
    return c.json({ ok: true })
  })

  app.onError((err, c) => {
    console.error('[panya]', err)
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}
