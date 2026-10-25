// MCP server (Model Context Protocol, Streamable HTTP แบบตอบ JSON) ที่ POST /mcp
// ให้ Claude Code, Claude Desktop และเครื่องมืออื่นใช้ panya เป็นหน่วยความจำได้ตรง ๆ
// ทุก tool เรียก route /v1 เดิมภายในด้วย Authorization ของผู้เรียก จึงได้การตรวจสิทธิ์ ขอบเขต key และตัวกรองความลับชุดเดียวกัน
import type { Hono } from 'hono'

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const VERSION = '1.0.0'

type Json = Record<string, any>
type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any; text: string }>

const str = (description: string) => ({ type: 'string', description })
const TOOLS = [
  {
    name: 'list_brains',
    description: 'List the panya brains (memory namespaces) this key can use, with owner, size and access (owner = writable, read = read-only). Call this first if you do not know which brain to use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'context',
    description: 'Get the starting context of a brain in one call: current values of every keyed fact (subject + attribute), preferences, and recent memories. Use at the start of a task.',
    inputSchema: {
      type: 'object', required: ['brain'], additionalProperties: false,
      properties: { brain: str('Brain name'), days: { type: 'integer', minimum: 1, maximum: 3650, description: 'How far back "recent" goes (default 30)' }, recent: { type: 'integer', minimum: 0, maximum: 200, description: 'Max recent memories (default 20)' } },
    },
  },
  {
    name: 'recall',
    description: 'Search a brain. Returns stored text verbatim with scores. If panya answers that it does not know, there is no relevant memory: say so, do not guess.',
    inputSchema: {
      type: 'object', required: ['brain', 'query'], additionalProperties: false,
      properties: {
        brain: str('Brain name'), query: str('Question or keywords (Thai or English)'),
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 5)' },
        as_of: str('Optional ISO date/time: search as the brain was at that moment'),
        include_superseded: { type: 'boolean', description: 'Also return older values that were replaced' },
      },
    },
  },
  {
    name: 'remember',
    description: 'Store one fact in a brain you own, word for word. One fact per call, at most 2000 characters. Give subject + attribute when the fact has a current value that may change later (the new value replaces the old one). NEVER store passwords, API keys, tokens or other secrets: panya refuses them.',
    inputSchema: {
      type: 'object', required: ['brain', 'text'], additionalProperties: false,
      properties: {
        brain: str('Brain name (must be one you own)'), text: str('The fact, verbatim'),
        subject: str('Optional key subject, e.g. "customer:ACME"'), attribute: str('Optional key attribute, e.g. "delivery-day"'),
        kind: { type: 'string', enum: ['fact', 'preference', 'event'], description: 'fact (default), preference, or event (events fade in ranking over time)' },
        valid_until: str('Optional ISO date/time after which the fact expires'),
        source: str('Optional source (file, URL, ticket)'),
      },
    },
  },
  {
    name: 'history',
    description: 'All versions of one keyed fact (subject + attribute), newest first, including replaced values.',
    inputSchema: { type: 'object', required: ['brain', 'subject', 'attribute'], additionalProperties: false, properties: { brain: str('Brain name'), subject: str('Subject'), attribute: str('Attribute') } },
  },
  {
    name: 'forget',
    description: 'Delete one memory by id from a brain you own. Ids come from recall results.',
    inputSchema: { type: 'object', required: ['brain', 'id'], additionalProperties: false, properties: { brain: str('Brain name'), id: str('Memory id') } },
  },
]

const day = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : '')
const keyOf = (m: Json) => (m.subject && m.attribute ? `[${m.subject} · ${m.attribute}] ` : '')

async function runTool(name: string, a: Json, call: Call): Promise<{ text: string; isError?: boolean }> {
  const need = (...keys: string[]) => {
    const missing = keys.filter((k) => typeof a[k] !== 'string' || !a[k].trim())
    if (missing.length) throw new Error(`missing argument: ${missing.join(', ')}`)
  }
  const fail = (r: { status: number; data: any; text: string }) => ({ text: `panya error ${r.status}: ${r.data?.error ?? r.text}`, isError: true })
  const q = encodeURIComponent

  if (name === 'list_brains') {
    const r = await call('GET', '/v1/brains'); if (r.status !== 200) return fail(r)
    const list = r.data.brains as Json[]
    if (!list.length) return { text: 'No brains yet. Create one on the web page (My brains) first.' }
    return { text: list.map((b) => `- ${b.name} · ${b.memories} memories · ${b.access === 'owner' ? 'writable' : 'read-only'} · owner ${b.owner}${b.description ? ` · ${b.description}` : ''}`).join('\n') }
  }
  if (name === 'context') {
    need('brain')
    const params = new URLSearchParams({ brain: a.brain, format: 'text' })
    if (a.days) params.set('days', String(a.days)); if (a.recent !== undefined) params.set('recent', String(a.recent))
    const r = await call('GET', `/v1/context?${params}`); return r.status === 200 ? { text: r.text } : fail(r)
  }
  if (name === 'recall') {
    need('brain', 'query')
    const body: Json = { brain: a.brain, q: a.query, limit: a.limit ?? 5 }
    if (a.as_of) body.asOf = a.as_of
    if (a.include_superseded) body.includeSuperseded = true
    const r = await call('POST', '/v1/search', body); if (r.status !== 200) return fail(r)
    if (r.data.abstained) {
      return { text: r.data.reason === 'unknown_entity'
        ? 'panya does not know: the question names something that never appears in this brain. Say you do not know; do not guess.'
        : 'panya does not know: no memory is relevant enough. Say you do not know; do not guess.' }
    }
    return { text: (r.data.hits as Json[]).map((h, i) => `${i + 1}. ${keyOf(h)}${h.text}\n   score ${Number(h.score).toFixed(2)} · ${h.kind} · ${day(h.createdAt)}${h.active === false ? ' · REPLACED' : ''}${h.source ? ` · source ${h.source}` : ''} · id ${h.id}`).join('\n') }
  }
  if (name === 'remember') {
    need('brain', 'text')
    const body: Json = { brain: a.brain, text: a.text }
    for (const [from, to] of [['subject', 'subject'], ['attribute', 'attribute'], ['kind', 'kind'], ['source', 'source'], ['valid_until', 'validUntil']]) if (a[from!] !== undefined) body[to!] = a[from!]
    const r = await call('POST', '/v1/memories', body); if (r.status !== 201 && r.status !== 200) return fail(r) // 200 = รวมกับของเดิม
    const said = { created: 'Stored.', superseded: 'Stored; it replaced the previous value of this key.', merged: 'Already known; merged with the existing memory.' }[r.data.action as string] ?? 'Stored.'
    return { text: `${said} id ${r.data.memory.id}` }
  }
  if (name === 'history') {
    need('brain', 'subject', 'attribute')
    const r = await call('GET', `/v1/history?brain=${q(a.brain)}&subject=${q(a.subject)}&attribute=${q(a.attribute)}`); if (r.status !== 200) return fail(r)
    const v = r.data.versions as Json[]
    return { text: v.length ? v.map((m) => `- ${day(m.createdAt)}${m.active ? ' (current)' : ` (replaced ${day(m.invalidAt)})`}: ${m.text}`).join('\n') : 'No versions for this key.' }
  }
  if (name === 'forget') {
    need('brain', 'id')
    const r = await call('DELETE', `/v1/memories/${q(a.id)}?brain=${q(a.brain)}`); return r.status === 200 ? { text: 'Deleted.' } : fail(r)
  }
  return { text: `unknown tool: ${name}`, isError: true }
}

export function mountMcp(app: Hono<any>) {
  app.get('/mcp', (c) => c.json({ error: 'use POST with JSON-RPC (MCP Streamable HTTP); server-sent streams are not offered' }, 405, { allow: 'POST' }))
  app.delete('/mcp', (c) => c.body(null, 405, { allow: 'POST' }))

  app.post('/mcp', async (c) => {
    const auth = c.req.header('authorization') ?? ''
    if (!/^Bearer\s+\S+/i.test(auth)) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Authorization: Bearer <panya API key> is required' } }, 401, { 'www-authenticate': 'Bearer realm="panya"' })
    const msg = await c.req.json().catch(() => undefined)
    if (msg === undefined) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400)

    const origin = new URL(c.req.url).origin
    const call: Call = async (method, path, body) => {
      const res = await app.request(origin + path, { method, headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await res.text()
      let data: any = null
      try { data = JSON.parse(text) } catch {}
      return { status: res.status, data, text }
    }
    // ยืนยัน key ก่อนทำอะไร: key ผิดต้องได้ 401 ไม่ใช่ผลของ tool
    const probe = await call('GET', '/v1/brains')
    if (probe.status === 401) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid API key' } }, 401, { 'www-authenticate': 'Bearer realm="panya"' })

    const handle = async (m: Json): Promise<Json | null> => {
      const isNote = m?.id === undefined || m?.id === null
      if (m?.jsonrpc !== '2.0' || typeof m.method !== 'string') return isNote ? null : { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'invalid request' } }
      const ok = (result: Json) => (isNote ? null : { jsonrpc: '2.0', id: m.id, result })
      const err = (code: number, message: string) => (isNote ? null : { jsonrpc: '2.0', id: m.id, error: { code, message } })
      switch (m.method) {
        case 'initialize': {
          const want = m.params?.protocolVersion
          return ok({
            protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'panya', title: 'panya second brain', version: VERSION },
            instructions: 'panya stores memories verbatim and abstains when nothing is relevant. Use list_brains, then context at the start of a task, recall before answering from memory, and remember for durable facts. Never store secrets.',
          })
        }
        case 'ping': return ok({})
        case 'tools/list': return ok({ tools: TOOLS })
        case 'tools/call': {
          const name = m.params?.name, args = m.params?.arguments ?? {}
          if (!TOOLS.some((t) => t.name === name)) return err(-32602, `unknown tool: ${name}`)
          try {
            const r = await runTool(name, args, call)
            return ok({ content: [{ type: 'text', text: r.text }], isError: r.isError === true })
          } catch (e) {
            return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true })
          }
        }
        case 'resources/list': return ok({ resources: [] })
        case 'prompts/list': return ok({ prompts: [] })
        default:
          if (m.method.startsWith('notifications/')) return null
          return err(-32601, `method not found: ${m.method}`)
      }
    }

    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handle))).filter(Boolean)
      return out.length ? c.json(out) : c.body(null, 202)
    }
    const out = await handle(msg)
    return out ? c.json(out) : c.body(null, 202)
  })
}
