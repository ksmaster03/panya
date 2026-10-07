import { Hono } from 'hono'
import { config } from './config'
import type { MemoryStore } from './memory'

type Env = { Variables: { scope: string | null } }

const KINDS = new Set(['fact', 'preference', 'event'])

export function createApp(store: MemoryStore, apiKeys: string[] = config.apiKeys) {
  const keys = new Map<string, string | null>()
  for (const k of apiKeys) {
    const at = k.indexOf('@')
    keys.set(at < 0 ? k : k.slice(0, at), at < 0 ? null : k.slice(at + 1))
  }

  const app = new Hono<Env>()
  app.get('/health', (c) => c.json({ ok: true }))

  app.use('/v1/*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!keys.has(token)) return c.json({ error: 'unauthorized' }, 401)
    c.set('scope', keys.get(token) ?? null)
    await next()
  })

  // key ที่ผูก container จะอ่าน/เขียนได้เฉพาะ container นั้น ไม่ว่าคำขอจะส่งอะไรมา
  const containerOf = (scope: string | null, requested: unknown): string | null => {
    if (typeof requested !== 'string' || !requested) return null
    if (scope !== null && scope !== requested) return null
    return requested
  }

  app.post('/v1/memories', async (c) => {
    const b = await c.req.json().catch(() => null)
    const container = containerOf(c.get('scope'), b?.container)
    if (!container) return c.json({ error: 'container not allowed' }, 403)
    if (typeof b.text !== 'string' || !b.text.trim()) return c.json({ error: 'text is required' }, 400)
    if (b.text.length > 2000) return c.json({ error: 'text too long (max 2000): send one fact per memory' }, 400)
    if (b.kind !== undefined && !KINDS.has(b.kind)) return c.json({ error: 'invalid kind' }, 400)
    let validUntil: number | undefined
    if (b.validUntil !== undefined) {
      validUntil = typeof b.validUntil === 'number' ? b.validUntil : Date.parse(b.validUntil)
      if (!Number.isFinite(validUntil)) return c.json({ error: 'invalid validUntil' }, 400)
    }
    const r = await store.remember({
      container, text: b.text, subject: b.subject, attribute: b.attribute, kind: b.kind, validUntil, source: b.source,
    })
    return c.json(r, r.action === 'merged' ? 200 : 201)
  })

  app.post('/v1/search', async (c) => {
    const b = await c.req.json().catch(() => null)
    const container = containerOf(c.get('scope'), b?.container)
    if (!container) return c.json({ error: 'container not allowed' }, 403)
    if (typeof b.q !== 'string' || !b.q.trim()) return c.json({ error: 'q is required' }, 400)
    const limit = Math.max(1, Math.min(20, Number(b.limit) || 5))
    return c.json(await store.search(container, b.q, { limit }))
  })

  app.get('/v1/profile', async (c) => {
    const container = containerOf(c.get('scope'), c.req.query('container'))
    if (!container) return c.json({ error: 'container not allowed' }, 403)
    return c.json(await store.profile(container))
  })

  // ลงทะเบียนชื่อเฉพาะของ container: { container, type, cues: ["ลูกค้า"], names: ["ไทยฟู้ดส์"] }
  app.put('/v1/entities', async (c) => {
    const b = await c.req.json().catch(() => null)
    const container = containerOf(c.get('scope'), b?.container)
    if (!container) return c.json({ error: 'container not allowed' }, 403)
    const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() && x.length <= 191)
    if (typeof b.type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(b.type)) return c.json({ error: 'invalid type' }, 400)
    if (!strs(b.cues ?? []) || !strs(b.names ?? [])) return c.json({ error: 'cues and names must be string arrays' }, 400)
    await store.entities.register(container, b.type, b.cues ?? [], b.names ?? [])
    return c.json({ ok: true })
  })

  app.get('/v1/entities', async (c) => {
    const container = containerOf(c.get('scope'), c.req.query('container'))
    if (!container) return c.json({ error: 'container not allowed' }, 403)
    return c.json({ types: await store.entities.list(container) })
  })

  app.delete('/v1/memories/:id', async (c) => {
    const container = containerOf(c.get('scope'), c.req.query('container'))
    if (!container) return c.json({ error: 'container not allowed' }, 403)
    const ok = await store.forget(container, c.req.param('id'))
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })

  app.onError((err, c) => {
    console.error('[panya]', err)
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}
