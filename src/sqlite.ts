import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ที่เก็บแบบไฟล์เดียวด้วย SQLite ที่มากับ Bun: ใช้แทน seekdb บนเครื่องที่ไม่มี Docker (แอป Windows)
 * ทำเฉพาะส่วนของ Collection และ execute() ที่ panya เรียกจริง ผลลัพธ์รูปเดียวกับ seekdb
 * เวกเตอร์ค้นแบบไล่ทุกรายการ (brute force) ในหน่วยความจำ พอสำหรับหลักหมื่นรายการต่อ brain
 * คำค้นใช้ตารางคำที่ตัดไว้แล้ว (เหมือน analyzer แบบ space) ให้คะแนนแบบ BM25
 */

type Meta = Record<string, unknown>
type Cond = Record<string, unknown>
type Ids = string | string[]
const arr = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

const ident = (name: string) => {
  if (!/^\w+$/.test(name)) throw new Error(`bad name: ${name}`)
  return name
}

/** ฟิลด์ที่ใช้กรองแทบทุกคำสั่ง เก็บเป็นคอลัมน์จริงด้วย (ค่าใน meta ยังเป็นต้นฉบับ) ไม่ต้องแกะ JSON ทุกแถว */
const COLUMNS: Record<string, string> = { container: 'container', active: 'active', validUntil: 'valid_until' }
const colValues = (m: Meta) => [String(m.container ?? ''), m.active == null ? null : Number(m.active), m.validUntil == null ? null : Number(m.validUntil)]

const OPS: Record<string, string> = { $eq: '=', $ne: '!=', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }

/** แปลง where แบบ seekdb ({ $and, $or, key: value | { $op: value } }) เป็น SQL บนคอลัมน์ meta (JSON) */
function whereSql(w: Cond | undefined, params: unknown[]): string {
  if (!w || !Object.keys(w).length) return '1'
  const parts: string[] = []
  for (const [k, v] of Object.entries(w)) {
    if (k === '$and' || k === '$or') {
      const subs = (v as Cond[]).map((x) => `(${whereSql(x, params)})`)
      parts.push(subs.length ? subs.join(k === '$and' ? ' AND ' : ' OR ') : k === '$and' ? '1' : '0')
      continue
    }
    const field = COLUMNS[k] ?? `json_extract(meta, '$.${ident(k)}')`
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [op, x] of Object.entries(v as Cond)) {
        if (op === '$in' || op === '$nin') {
          const xs = x as unknown[]
          if (!xs.length) { parts.push(op === '$in' ? '0' : '1'); continue }
          params.push(...xs)
          parts.push(`${field} ${op === '$in' ? 'IN' : 'NOT IN'} (${xs.map(() => '?').join(', ')})`)
        } else if (OPS[op]) {
          params.push(x)
          parts.push(`${field} ${OPS[op]} ?`)
        } else throw new Error(`unsupported operator ${op}`)
      }
    } else {
      params.push(v)
      parts.push(`${field} = ?`)
    }
  }
  return parts.join(' AND ') || '1'
}

const toBlob = (v: number[]) => new Uint8Array(Float32Array.from(v).buffer)
/** เวกเตอร์ในแคชเก็บแบบปรับความยาวเป็น 1 แล้ว: ตอนค้นเหลือแค่ผลคูณจุด */
const unit = (v: ArrayLike<number>) => {
  const out = Float32Array.from(v)
  let n = 0
  for (let i = 0; i < out.length; i++) n += out[i]! * out[i]!
  n = Math.sqrt(n) || 1
  for (let i = 0; i < out.length; i++) out[i]! /= n
  return out
}
const fromBlob = (b: Uint8Array) => new Float32Array(b.slice().buffer)
/** นับคำในเอกสารที่ตัดคำแล้ว (คั่นด้วยช่องว่าง) */
function termFreq(doc: string) {
  const tf = new Map<string, number>()
  let len = 0
  for (const t of doc.toLowerCase().split(/\s+/)) if (t) { tf.set(t, (tf.get(t) ?? 0) + 1); len++ }
  return { tf, len }
}

/** k อันดับที่ผลคูณจุดสูงสุด เก็บเฉพาะ k ตัวระหว่างไล่ (ไม่เรียงทั้งชุด) · แยกเป็นฟังก์ชันเล็กให้ JIT คอมไพล์วงวนได้เต็มที่ */
function nearest(cand: number[], vecs: Map<number, Float32Array>, q: Float32Array, k: number) {
  const topRid: number[] = [], topSim: number[] = []
  const dim = q.length
  for (let c = 0; c < cand.length; c++) {
    const rid = cand[c]!
    const v = vecs.get(rid)
    if (!v) continue
    let dot = 0
    for (let d = 0; d < dim; d++) dot += v[d]! * q[d]!
    if (topSim.length === k && dot <= topSim[k - 1]!) continue
    let j = topSim.length < k ? topSim.length : k - 1
    while (j > 0 && topSim[j - 1]! < dot) { topSim[j] = topSim[j - 1]!; topRid[j] = topRid[j - 1]!; j-- }
    topSim[j] = dot; topRid[j] = rid
  }
  return { topRid, topSim }
}

export class SqliteCollection {
  /** เวกเตอร์ที่อ่านแล้ว ต่อ rowid: ค้นซ้ำไม่ต้องอ่าน blob ใหม่ (เขียนผ่านโปรเซสนี้โปรเซสเดียว) */
  private vecs = new Map<number, Float32Array>()
  private tok: string

  constructor(private db: Database, readonly name: string) {
    this.tok = `${name}__tok`
    db.run(`CREATE TABLE IF NOT EXISTS ${name} (rid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, container TEXT NOT NULL, active INTEGER, valid_until REAL, doc TEXT NOT NULL, meta TEXT NOT NULL, emb BLOB, len INTEGER NOT NULL DEFAULT 0)`)
    // ตารางที่สร้างก่อนมีคอลัมน์ active/valid_until: เพิ่มแล้วเติมค่าจาก meta
    const have = new Set((db.query(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name))
    if (!have.has('active')) {
      db.run(`ALTER TABLE ${name} ADD COLUMN active INTEGER`)
      db.run(`ALTER TABLE ${name} ADD COLUMN valid_until REAL`)
      db.run(`UPDATE ${name} SET active = json_extract(meta, '$.active'), valid_until = json_extract(meta, '$.validUntil')`)
    }
    // ครอบคลุมเงื่อนไข "ยังใช้ได้" ทั้งหมด: หา rid ได้จากดัชนีอย่างเดียว ไม่ต้องอ่านแถวที่มี blob ของเวกเตอร์
    db.run(`CREATE INDEX IF NOT EXISTS ${name}_live ON ${name} (container, active, valid_until)`)
    db.run(`CREATE TABLE IF NOT EXISTS ${this.tok} (rid INTEGER NOT NULL, tok TEXT NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY (tok, rid)) WITHOUT ROWID`)
    db.run(`CREATE INDEX IF NOT EXISTS ${this.tok}_rid ON ${this.tok} (rid)`)
  }

  private rows(where: Cond | undefined, ids: Ids | undefined, cols: string, tail = '', extra: unknown[] = []) {
    const params: unknown[] = []
    let sql = `SELECT ${cols} FROM ${this.name} WHERE (${whereSql(where, params)})`
    if (ids !== undefined) {
      const xs = arr(ids)
      if (!xs.length) return []
      sql += ` AND id IN (${xs.map(() => '?').join(', ')})`
      params.push(...xs)
    }
    return this.db.query(sql + tail).all(...(params as any[]), ...(extra as any[])) as any[]
  }

  private vector(rid: number, blob?: Uint8Array | null): Float32Array | undefined {
    let v = this.vecs.get(rid)
    if (!v && blob) this.vecs.set(rid, (v = unit(fromBlob(blob))))
    return v
  }

  async add(a: { ids: Ids; documents?: string | string[]; embeddings?: number[] | number[][]; metadatas?: Meta | Meta[] }) {
    const ids = arr(a.ids)
    const docs = a.documents === undefined ? [] : arr(a.documents)
    const metas = a.metadatas === undefined ? [] : Array.isArray(a.metadatas) ? a.metadatas : [a.metadatas]
    const embs = a.embeddings === undefined ? [] : typeof a.embeddings[0] === 'number' ? [a.embeddings as number[]] : (a.embeddings as number[][])
    const ins = this.db.query(`INSERT INTO ${this.name} (id, container, active, valid_until, doc, meta, emb, len) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    const insTok = this.db.query(`INSERT INTO ${this.tok} (rid, tok, tf) VALUES (?, ?, ?)`)
    this.db.transaction(() => {
      ids.forEach((id, i) => {
        const meta = metas[i] ?? {}
        const doc = docs[i] ?? ''
        const { tf, len } = termFreq(doc)
        const r = ins.run(id, ...(colValues(meta) as any[]), doc, JSON.stringify(meta), embs[i] ? toBlob(embs[i]!) : null, len)
        const rid = Number(r.lastInsertRowid)
        for (const [t, n] of tf) insTok.run(rid, t, n)
        if (embs[i]) this.vecs.set(rid, unit(embs[i]!))
      })
    })()
  }

  async update(a: { ids: Ids; metadatas: Meta | Meta[] }) {
    const ids = arr(a.ids)
    const metas = Array.isArray(a.metadatas) ? a.metadatas : [a.metadatas]
    const up = this.db.query(`UPDATE ${this.name} SET meta = ?, container = ?, active = ?, valid_until = ? WHERE id = ?`)
    this.db.transaction(() => ids.forEach((id, i) => up.run(JSON.stringify(metas[i]), ...(colValues(metas[i]!) as any[]), id)))()
  }

  async delete(a: { ids?: Ids; where?: Cond }) {
    const rids = this.rows(a.where, a.ids, 'rid').map((r) => r.rid as number)
    if (!rids.length) return
    const delRow = this.db.query(`DELETE FROM ${this.name} WHERE rid = ?`)
    const delTok = this.db.query(`DELETE FROM ${this.tok} WHERE rid = ?`)
    this.db.transaction(() => rids.forEach((rid) => { delRow.run(rid); delTok.run(rid); this.vecs.delete(rid) }))()
  }

  async get(a: { ids?: Ids; where?: Cond; whereDocument?: { $contains?: string }; include?: string[]; limit?: number; offset?: number } = {}) {
    const withEmb = a.include?.includes('embeddings')
    const params: unknown[] = []
    let docSql = ''
    // $contains: ทุกคำต้องอยู่ในเอกสาร
    const toks = [...new Set((a.whereDocument?.$contains ?? '').toLowerCase().split(/\s+/).filter(Boolean))]
    for (const t of toks) { docSql += ` AND rid IN (SELECT rid FROM ${this.tok} WHERE tok = ?)`; params.push(t) }
    const tail = `${docSql} ORDER BY rid${a.limit !== undefined ? ' LIMIT ?' : ''}${a.offset ? (a.limit !== undefined ? ' OFFSET ?' : ' LIMIT -1 OFFSET ?') : ''}`
    if (a.limit !== undefined) params.push(a.limit)
    if (a.offset) params.push(a.offset)
    const rows = this.rows(a.where, a.ids, `rid, id, doc, meta${withEmb ? ', emb' : ''}`, tail, params)
    return {
      ids: rows.map((r) => r.id as string),
      documents: rows.map((r) => r.doc as string),
      metadatas: rows.map((r) => JSON.parse(r.meta) as Meta),
      embeddings: withEmb ? rows.map((r) => Array.from(this.vector(r.rid, r.emb) ?? [])) : undefined,
    }
  }

  private pick(rids: number[]) {
    if (!rids.length) return new Map<number, any>()
    const rows = this.db.query(`SELECT rid, id, doc, meta FROM ${this.name} WHERE rid IN (${rids.map(() => '?').join(', ')})`).all(...rids) as any[]
    return new Map(rows.map((r) => [r.rid as number, r]))
  }

  /** ค้นเวกเตอร์ใกล้สุดตามระยะ cosine (1 - ความคล้าย) เหมือน hnsw distance: 'cosine' ของ seekdb */
  async query(a: { queryEmbeddings: number[] | number[][]; nResults?: number; where?: Cond; include?: string[] }) {
    const q = unit(typeof a.queryEmbeddings[0] === 'number' ? (a.queryEmbeddings as number[]) : (a.queryEmbeddings as number[][])[0]!)
    const k = a.nResults ?? 10
    const params: unknown[] = []
    const cand = (this.db.query(`SELECT rid FROM ${this.name} WHERE (${whereSql(a.where, params)})`).values(...(params as any[])) as number[][]).map((r) => r[0]!)
    const missing = cand.filter((rid) => !this.vecs.has(rid))
    for (let i = 0; i < missing.length; i += 500) {
      const part = missing.slice(i, i + 500)
      for (const r of this.db.query(`SELECT rid, emb FROM ${this.name} WHERE rid IN (${part.map(() => '?').join(', ')})`).all(...part) as any[]) this.vector(r.rid, r.emb)
    }
    const { topRid, topSim } = nearest(cand, this.vecs, q, k)
    const top = topRid.map((rid, i) => [rid, 1 - topSim[i]!] as [number, number])
    const rows = this.pick(top.map((t) => t[0]))
    const kept = top.filter((t) => rows.has(t[0]))
    return {
      ids: [kept.map((t) => rows.get(t[0]).id as string)],
      distances: [kept.map((t) => t[1])],
      documents: [kept.map((t) => rows.get(t[0]).doc as string)],
      metadatas: [kept.map((t) => JSON.parse(rows.get(t[0]).meta) as Meta)],
    }
  }

  /** ค้นด้วยคำ: เอกสารที่มีคำใดคำหนึ่ง เรียงตาม BM25 (panya ใช้เฉพาะส่วน fulltext ของ hybridSearch) */
  async hybridSearch(a: { query: { whereDocument?: { $contains?: string }; where?: Cond; nResults?: number }; nResults?: number; include?: string[] }) {
    const toks = [...new Set((a.query.whereDocument?.$contains ?? '').toLowerCase().split(/\s+/).filter(Boolean))]
    const k = a.nResults ?? a.query.nResults ?? 10
    if (!toks.length) return { ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] }
    const stats = this.db.query(`SELECT COUNT(*) AS n, AVG(len) AS avg FROM ${this.name}`).get() as { n: number; avg: number | null }
    const n = stats.n || 1, avg = stats.avg || 1
    const df = new Map<string, number>()
    const dfq = this.db.query(`SELECT COUNT(*) AS c FROM ${this.tok} WHERE tok = ?`)
    for (const t of toks) df.set(t, (dfq.get(t) as { c: number }).c)
    const params: unknown[] = [...toks]
    const sql = `SELECT t.rid, t.tok, t.tf, c.len FROM ${this.tok} t JOIN ${this.name} c ON c.rid = t.rid WHERE t.tok IN (${toks.map(() => '?').join(', ')}) AND (${whereSql(a.query.where, params)})`
    const score = new Map<number, number>()
    const k1 = 1.2, b = 0.75
    for (const r of this.db.query(sql).all(...(params as any[])) as any[]) {
      const d = df.get(r.tok) ?? 0
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5))
      const s = (idf * r.tf * (k1 + 1)) / (r.tf + k1 * (1 - b + (b * r.len) / avg))
      score.set(r.rid, (score.get(r.rid) ?? 0) + s)
    }
    const top = [...score].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, k)
    const rows = this.pick(top.map((t) => t[0]))
    return {
      ids: [top.map((t) => rows.get(t[0]).id as string)],
      documents: [top.map((t) => rows.get(t[0]).doc as string)],
      metadatas: [top.map((t) => JSON.parse(rows.get(t[0]).meta) as Meta)],
      distances: [top.map((t) => -t[1])],
    }
  }
}

/** ไฟล์ฐานข้อมูลหนึ่งไฟล์ต่อ database: ใช้แทน SeekdbClient ทั้งตารางของ registry และ collection */
export class SqliteClient {
  readonly db: Database
  private cols = new Map<string, SqliteCollection>()

  constructor(dir: string, database: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new Database(join(dir, `${ident(database)}.sqlite`), { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA synchronous = NORMAL')
    this.db.run('PRAGMA busy_timeout = 5000')
  }

  /** SQL ของ registry เขียนแบบ MySQL: แปลงเฉพาะส่วนที่ SQLite ไม่รู้จัก */
  async execute(sql: string, params: unknown[] = []): Promise<any[]> {
    const s = sql.replace(/^\s*INSERT IGNORE INTO/i, 'INSERT OR IGNORE INTO')
    const ps = params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p)) as any[]
    const stmt = this.db.query(s)
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(s)) return stmt.all(...ps) as any[]
    stmt.run(...ps)
    return []
  }

  collection(name: string) {
    let c = this.cols.get(name)
    if (!c) this.cols.set(name, (c = new SqliteCollection(this.db, ident(name))))
    return c
  }

  async close() {
    this.db.close()
  }
}
