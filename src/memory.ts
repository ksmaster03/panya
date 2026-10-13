import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig, type Collection, type Where } from 'seekdb'
import { config, type SearchTuning } from './config'
import type { Embedder } from './embed'
import type { Reranker } from './rerank'
import { EntityRegistry, norm } from './entities'
import { coverage, extractCodes, tokenize } from './tokenize'

export type Kind = 'fact' | 'preference' | 'event'

export interface RememberInput {
  container: string
  text: string
  /** เรื่องที่พูดถึง เช่น "dock:D-02" หรือ "carrier:สยามโลจิสติกส์" */
  subject?: string
  /** หัวข้อของเรื่องนั้น เช่น "status" ถ้ามี subject+attribute ซ้ำ รุ่นใหม่จะแทนรุ่นเก่า */
  attribute?: string
  kind?: Kind
  /** หมดอายุเมื่อไร (epoch ms) ไม่ใส่ = ไม่หมดอายุ */
  validUntil?: number
  source?: string
  /** รหัสอ้างอิงของผู้เรียกเอง เช่น id ของแถวในระบบต้นทาง คืนกลับมาพร้อมผลค้น */
  ref?: string
  now?: number
}

export interface Memory {
  id: string
  container: string
  text: string
  subject: string
  attribute: string
  kind: Kind
  createdAt: number
  lastSeenAt: number
  validUntil: number
  active: boolean
  supersededBy: string
  count: number
  source: string
  ref: string
}

export interface SearchHit extends Memory {
  score: number
  sim: number
  coverage: number
  /** คะแนนจาก reranker (0-1) มีเมื่อการค้นครั้งนี้ถูกจัดอันดับซ้ำ */
  rerank?: number
}

export interface SearchResult {
  hits: SearchHit[]
  /** true = ผลชุดนี้ผ่าน reranker แล้ว */
  reranked?: boolean
  /** true = ไม่มีความจำที่เกี่ยวพอ ผู้เรียกควรถือว่า "ไม่รู้" */
  abstained: boolean
  /** เหตุที่ไม่ตอบ: unknown_entity = คำค้นถามถึงรายที่ไม่มีในทะเบียนและไม่เคยปรากฏในความจำ */
  reason?: 'no_match' | 'unknown_entity'
}

export interface GraphNode {
  id: string
  text: string
  kind: Kind
  subject: string
  source: string
  createdAt: number
  count: number
  x: number
  y: number
}
export interface Graph {
  nodes: GraphNode[]
  /** [ดัชนีโหนด, ดัชนีโหนด, ความคล้าย] */
  edges: [number, number, number][]
}

/** สถิติของ brain หนึ่ง สำหรับหน้าแดชบอร์ด */
export interface BrainStats {
  brain: string
  /** ความจำที่ยังใช้ได้ */
  live: number
  /** รุ่นเก่าที่ถูกค่าใหม่แทนแล้ว */
  superseded: number
  expired: number
  /** ยังใช้ได้ แต่จะหมดอายุภายใน 7 วัน */
  expiringSoon: number
  kinds: Record<Kind, number>
  /** มี subject + attribute */
  keyed: number
  sources: number
  /** จำนวนครั้งที่ข้อความซ้ำถูกรวมเข้ารายการเดิม */
  merges: number
  /** จำนวนตัวอักษรรวมของความจำที่ยังใช้ได้ */
  chars: number
  firstAt: number
  lastAt: number
  /** จำนวนที่เขียนเข้ามา นับถอยหลังจากตอนนี้ ช่องสุดท้าย = ช่วงล่าสุด */
  minute: number[]
  hour: number[]
  day: number[]
}

export type RememberResult ={ memory: Memory; action: 'created' | 'superseded' | 'merged' }

type Meta = Record<string, string | number>
const NEVER = 9_000_000_000_000_000

function toMemory(id: string, m: Meta): Memory {
  return {
    id,
    container: String(m.container),
    text: String(m.text),
    subject: String(m.subject ?? ''),
    attribute: String(m.attribute ?? ''),
    kind: (m.kind as Kind) ?? 'fact',
    createdAt: Number(m.createdAt),
    lastSeenAt: Number(m.lastSeenAt ?? m.createdAt),
    validUntil: Number(m.validUntil) >= NEVER ? 0 : Number(m.validUntil),
    active: Number(m.active) === 1,
    supersededBy: String(m.supersededBy ?? ''),
    count: Number(m.count ?? 1),
    source: String(m.source ?? ''),
    ref: String(m.ref ?? ''),
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

export class MemoryStore {
  private constructor(
    private client: SeekdbClient,
    private col: Collection,
    private embedder: Embedder,
    readonly entities: EntityRegistry,
    private readers: { client: SeekdbClient; col: Collection }[],
    private reranker: Reranker | null,
  ) {}

  private next = 0
  /** connection สำหรับอ่าน วนใช้ทีละตัว เพื่อให้คำสั่งที่ยิงพร้อมกันไม่ต้องเข้าคิวบน connection เดียว */
  private reader(): Collection {
    if (!this.readers.length) return this.col
    this.next = (this.next + 1) % this.readers.length
    return this.readers[this.next]!.col
  }

  static async open(
    embedder: Embedder,
    opts: Partial<typeof config.seekdb> & { connectTimeoutMs?: number; reranker?: Reranker | null } = {},
  ): Promise<MemoryStore> {
    const c = { ...config.seekdb, ...opts }
    // seekdb ใช้เวลาบูตราวครึ่งนาที ถ้าเปิดพร้อมกันด้วย compose ต้องรอ ไม่ใช่ล้ม
    const deadline = Date.now() + (opts.connectTimeoutMs ?? 120_000)
    for (;;) {
      const admin = new SeekdbClient({ host: c.host, port: c.port, user: c.user, password: c.password, database: 'test' })
      try {
        await admin.execute(`CREATE DATABASE IF NOT EXISTS \`${c.database.replace(/`/g, '')}\``)
        await admin.close()
        break
      } catch (err) {
        await admin.close().catch(() => {})
        if (Date.now() > deadline) throw err
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    const client = new SeekdbClient({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database })
    const col = await client.getOrCreateCollection({
      name: c.collection,
      // ต้องระบุ null ตรงนี้ด้วย ไม่งั้นตอนเปิด collection ที่มีอยู่แล้ว SDK จะไปหา embedding function ดีฟอลต์แล้วพัง
      embeddingFunction: null,
      schema: new Schema({
        // เอกสารถูกตัดคำมาแล้ว คั่นด้วยช่องว่าง จึงใช้ analyzer แบบ space
        fulltextIndex: new FulltextIndexConfig('space', { min_token_size: 1 }),
        vectorIndex: new VectorIndexConfig({
          hnsw: { dimension: config.embed.dimension, distance: 'cosine' },
          embeddingFunction: null,
        }),
      }),
    })
    const readers: { client: SeekdbClient; col: Collection }[] = []
    for (let i = 0; i < c.readPool; i++) {
      const rc = new SeekdbClient({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database })
      readers.push({ client: rc, col: await rc.getCollection({ name: c.collection, embeddingFunction: null }) })
    }
    return new MemoryStore(client, col, embedder, await EntityRegistry.open(client), readers, opts.reranker ?? null)
  }

  async close() {
    await Promise.all(this.readers.map((r) => r.client.close()))
    await this.client.close()
  }

  private liveWhere(container: string, now: number): Where {
    return { $and: [{ container }, { active: 1 }, { validUntil: { $gt: now } }] }
  }

  /**
   * บันทึกหลายรายการ: คำนวณ embedding รวมเป็นชุดเดียว (ส่วนที่ช้าที่สุด) แล้วเขียนตามลำดับ
   * ลำดับสำคัญ เพราะรายการหลังอาจทับหรือซ้ำกับรายการก่อนในชุดเดียวกัน
   */
  async rememberMany(inputs: RememberInput[]): Promise<RememberResult[]> {
    for (const i of inputs) {
      if (!i.text?.trim()) throw new Error('text is empty')
      if (!i.container) throw new Error('container is required')
    }
    const vectors: number[][] = []
    for (let i = 0; i < inputs.length; i += 32) {
      vectors.push(...(await this.embedder.passage(inputs.slice(i, i + 32).map((x) => x.text.trim()))))
    }
    const out: RememberResult[] = []
    for (let i = 0; i < inputs.length; i++) out.push(await this.remember(inputs[i]!, vectors[i]))
    return out
  }

  async remember(input: RememberInput, precomputed?: number[]): Promise<RememberResult> {
    const text = input.text.trim()
    if (!text) throw new Error('text is empty')
    if (!input.container) throw new Error('container is required')
    const now = input.now ?? Date.now()
    const subject = input.subject?.trim() ?? ''
    const attribute = input.attribute?.trim() ?? ''
    const embedding: number[][] = [precomputed ?? (await this.embedder.passage([text]))[0]!]
    const id = crypto.randomUUID()
    let action: 'created' | 'superseded' | 'merged' = 'created'

    if (subject && attribute) {
      // คีย์ซ้ำ: รุ่นเก่าถูกปิด แต่ยังเก็บไว้เป็นประวัติ
      const old = await this.col.get({
        where: { $and: [{ container: input.container }, { active: 1 }, { subject }, { attribute }] },
        include: ['metadatas'],
      })
      for (let i = 0; i < old.ids.length; i++) {
        const m = { ...(old.metadatas?.[i] as Meta), active: 0, supersededBy: id }
        await this.col.update({ ids: old.ids[i]!, metadatas: m })
        action = 'superseded'
      }
    } else {
      // ไม่มีคีย์: ถ้าข้อความแทบเหมือนของเดิม ให้นับเพิ่มแทนการเก็บซ้ำ
      const near = await this.col.query({
        queryEmbeddings: embedding!,
        nResults: 1,
        where: this.liveWhere(input.container, now),
        include: ['metadatas', 'distances'],
      })
      const nid = near.ids[0]?.[0]
      const dist = near.distances?.[0]?.[0]
      const nm = near.metadatas?.[0]?.[0] as Meta | undefined
      if (nid && nm && dist != null && 1 - dist >= config.search.dedupeSim && !nm.subject) {
        const merged = { ...nm, count: Number(nm.count ?? 1) + 1, lastSeenAt: now }
        await this.col.update({ ids: nid, metadatas: merged })
        return { memory: toMemory(nid, merged), action: 'merged' }
      }
    }

    const meta: Meta = {
      container: input.container,
      text,
      subject,
      attribute,
      kind: input.kind ?? 'fact',
      createdAt: now,
      lastSeenAt: now,
      validUntil: input.validUntil && input.validUntil > 0 ? input.validUntil : NEVER,
      active: 1,
      supersededBy: '',
      count: 1,
      source: input.source ?? '',
      ref: input.ref ?? '',
      codes: extractCodes(text).join(' '),
    }
    await this.col.add({ ids: id, documents: tokenize(text).join(' '), embeddings: embedding!, metadatas: meta })
    // subject แบบ "carrier:สยามโลจิสติกส์" ลงทะเบียนชื่อให้เอง (ข้ามถ้าเป็นรหัส เพราะรหัสมีกฎของมันอยู่แล้ว)
    const colon = subject.indexOf(':')
    if (colon > 0 && !extractCodes(subject.slice(colon + 1)).length) {
      await this.entities.addName(input.container, subject.slice(0, colon), subject.slice(colon + 1))
    }
    return { memory: toMemory(id, meta), action }
  }

  async search(
    container: string,
    q: string,
    opts: { limit?: number; now?: number; tuning?: Partial<SearchTuning>; rerank?: boolean; rerankTop?: number } = {},
  ): Promise<SearchResult> {
    const t = { ...config.search, ...opts.tuning }
    const now = opts.now ?? Date.now()
    const limit = opts.limit ?? 5
    const where = this.liveWhere(container, now)
    const qTokens = tokenize(q)

    // ชื่อเฉพาะ: หาว่าคำค้นพูดถึงรายที่รู้จัก หรือรายที่ไม่เคยเห็น
    const types = await this.entities.list(container)
    const qNorm = norm(q)
    const known = types.flatMap((t) => t.names).map(norm).filter((n) => qNorm.includes(n))
    // สามงานนี้ไม่ขึ้นต่อกัน ยิงพร้อมกันบนคนละ connection
    const unknownP = known.length
      ? Promise.resolve(false)
      : this.asksAboutUnknownEntity(q, types.flatMap((t) => t.cues), where)
    const lexP = qTokens.length
      ? this.reader().hybridSearch({
          query: { whereDocument: { $contains: [...new Set(qTokens)].join(' ') }, where, nResults: t.candidates },
          nResults: t.candidates,
          include: ['documents', 'metadatas'],
        })
      : Promise.resolve(null)
    const denseP = this.embedder.query(q).then(async (qVec) => ({
      qVec,
      dense: await this.reader().query({ queryEmbeddings: qVec, nResults: t.candidates, where, include: ['documents', 'metadatas', 'distances'] }),
    }))
    // กัน unhandled rejection ถ้าออกก่อนเพราะ unknown_entity
    lexP.catch(() => {})
    denseP.catch(() => {})

    if (await unknownP) return { hits: [], abstained: true, reason: 'unknown_entity' }
    const [{ qVec, dense }, lex] = await Promise.all([denseP, lexP])

    const cand = new Map<string, { meta: Meta; doc: string; sim: number }>()
    dense.ids[0]?.forEach((id, i) => {
      const d = dense.distances?.[0]?.[i]
      cand.set(id, { meta: dense.metadatas?.[0]?.[i] as Meta, doc: dense.documents?.[0]?.[i] ?? '', sim: d == null ? 0 : 1 - d })
    })
    // ผู้สมัครที่มาจากฝั่งคำอย่างเดียว (ส่วนน้อย) ค่อยไปขอเวกเตอร์มาคิดความคล้าย
    const lexOnly: string[] = []
    lex?.ids[0]?.forEach((id, i) => {
      if (cand.has(id)) return
      lexOnly.push(id)
      cand.set(id, { meta: lex.metadatas?.[0]?.[i] as Meta, doc: lex.documents?.[0]?.[i] ?? '', sim: 0 })
    })
    if (lexOnly.length) {
      const got = await this.reader().get({ ids: lexOnly, include: ['embeddings'] })
      got.ids.forEach((id, i) => {
        const v = got.embeddings?.[i]
        const c = cand.get(id)
        if (v && c) c.sim = v.reduce((s, x, k) => s + x * qVec[k]!, 0)
      })
    }

    // รหัสคือตัวระบุ: ถ้าคำค้นเจาะจงรหัส (D-11, BK-2026-0001) ความจำที่ไม่มีรหัสนั้นไม่ใช่คำตอบ
    const qCodes = extractCodes(q)
    const hits: SearchHit[] = []
    for (const [id, c] of cand) {
      if (qCodes.length) {
        const docCodes = new Set(String(c.meta.codes ?? '').split(' '))
        if (!qCodes.some((code) => docCodes.has(code))) continue
      }
      // คำค้นเจาะจงรายที่รู้จัก: ความจำที่ไม่ได้พูดถึงรายนั้นไม่ใช่คำตอบ
      if (known.length) {
        const textNorm = norm(String(c.meta.text))
        if (!known.some((n) => textNorm.includes(n))) continue
      }
      const cov = coverage(qTokens, c.doc.split(' '))
      const simNorm = clamp01((c.sim - t.simFloor) / (t.simCeil - t.simFloor))
      // ความหมาย + คำที่ตรงกัน: ต้องมีอย่างใดอย่างหนึ่งชัดเจน หรือทั้งสองพอประมาณ จึงผ่านเกณฑ์
      const score = (1 - t.lexWeight) * simNorm + t.lexWeight * cov
      hits.push({ ...toMemory(id, c.meta), score, sim: c.sim, coverage: cov })
    }
    hits.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)

    // จัดอันดับซ้ำ: อ่านคำถามคู่กับข้อความจริงของผู้สมัครอันดับต้น แล้วผสมกับคะแนนเดิม
    // ผู้สมัครที่ไม่ได้ส่งให้ reranker ถือว่าไม่ผ่าน และเกณฑ์ตัดใช้ rerankMinScore แทน minScore
    if (this.reranker && opts.rerank !== false) {
      const top = hits.slice(0, opts.rerankTop ?? config.rerank.top)
      const rr = await this.reranker.score(q, top.map((h) => h.text))
      const mixed = top.map((h, i) => ({ ...h, rerank: rr[i]!, score: (1 - t.rerankWeight) * h.score + t.rerankWeight * rr[i]! }))
      mixed.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      const kept = mixed.filter((h) => h.score >= t.rerankMinScore).slice(0, limit)
      return kept.length ? { hits: kept, abstained: false, reranked: true } : { hits: [], abstained: true, reason: 'no_match', reranked: true }
    }

    const kept = hits.filter((h) => h.score >= t.minScore).slice(0, limit)
    return kept.length ? { hits: kept, abstained: false } : { hits: [], abstained: true, reason: 'no_match' }
  }

  /**
   * หลังคำนำหน้าอย่าง "ลูกค้า" ถ้าคำที่ตามมาไม่เคยปรากฏในความจำของ container นี้เลย
   * แปลว่ากำลังถามถึงรายที่เราไม่มีข้อมูล ให้ตอบว่าไม่รู้ ดีกว่าคืนข้อมูลของรายอื่น
   */
  private async asksAboutUnknownEntity(q: string, cues: string[], where: Where): Promise<boolean> {
    for (const cue of cues) {
      const at = q.indexOf(cue)
      if (at < 0) continue
      const next = tokenize(q.slice(at + cue.length)).slice(0, 3)
      if (!next.length) continue
      const found = await Promise.all(
        next.map((token) => this.reader().get({ where, whereDocument: { $contains: token }, limit: 1, include: [] })),
      )
      const novel = found.filter((r) => r.ids.length === 0).length
      if (novel >= Math.min(2, next.length)) return true
    }
    return false
  }

  /** ความจำที่ยังใช้ได้ของ container: ความชอบ/ข้อเท็จจริงที่มีคีย์ + รายการล่าสุด */
  async profile(container: string, opts: { limit?: number; now?: number } = {}) {
    const now = opts.now ?? Date.now()
    const r = await this.reader().get({ where: this.liveWhere(container, now), include: ['metadatas'], limit: 1000 })
    const all = r.ids.map((id, i) => toMemory(id, r.metadatas?.[i] as Meta))
    all.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    return {
      preferences: all.filter((m) => m.kind === 'preference'),
      keyed: all.filter((m) => m.kind !== 'preference' && m.subject),
      recent: all.filter((m) => m.kind !== 'preference' && !m.subject).slice(0, opts.limit ?? 10),
    }
  }

  /**
   * ข้อมูลสำหรับวาดแผนที่ความจำ: ตำแหน่ง 2 มิติจาก PCA ของ embedding + เส้นเชื่อมเพื่อนบ้านที่ใกล้ที่สุด
   * ความจำที่ความหมายใกล้กันจะอยู่ใกล้กันบนแผนที่
   */
  async graph(container: string, opts: { limit?: number; neighbors?: number; now?: number } = {}): Promise<Graph> {
    const now = opts.now ?? Date.now()
    const limit = Math.min(opts.limit ?? 1500, 3000)
    const k = opts.neighbors ?? 2
    const r = await this.reader().get({ where: this.liveWhere(container, now), include: ['metadatas', 'embeddings'], limit })
    const n = r.ids.length
    const vecs = r.embeddings?.map((v) => v ?? []) ?? []
    const dim = vecs[0]?.length ?? 0
    const nodes: GraphNode[] = r.ids.map((id, i) => {
      const m = toMemory(id, r.metadatas?.[i] as Meta)
      return { id, text: m.text, kind: m.kind, subject: m.subject, source: m.source, createdAt: m.createdAt, count: m.count, x: 0, y: 0 }
    })
    if (n < 2 || !dim) return { nodes, edges: [] }

    // PCA 2 แกนด้วย power iteration บนข้อมูลที่ลบค่าเฉลี่ยแล้ว
    const mean = new Float64Array(dim)
    for (const v of vecs) for (let d = 0; d < dim; d++) mean[d]! += v[d]! / n
    const project = (axis: Float64Array) => vecs.map((v) => { let s = 0; for (let d = 0; d < dim; d++) s += (v[d]! - mean[d]!) * axis[d]!; return s })
    const component = (deflate?: Float64Array) => {
      let axis = Float64Array.from({ length: dim }, (_, d) => Math.sin(d * 12.9898 + (deflate ? 1 : 0)) )
      for (let it = 0; it < 40; it++) {
        const scores = project(axis)
        const next = new Float64Array(dim)
        vecs.forEach((v, i) => { for (let d = 0; d < dim; d++) next[d]! += (v[d]! - mean[d]!) * scores[i]! })
        if (deflate) { let dot = 0; for (let d = 0; d < dim; d++) dot += next[d]! * deflate[d]!; for (let d = 0; d < dim; d++) next[d]! -= dot * deflate[d]! }
        let len = 0; for (let d = 0; d < dim; d++) len += next[d]! * next[d]!
        len = Math.sqrt(len) || 1
        for (let d = 0; d < dim; d++) next[d]! /= len
        axis = next
      }
      return axis
    }
    const a1 = component()
    const a2 = component(a1)
    const xs = project(a1)
    const ys = project(a2)
    nodes.forEach((node, i) => { node.x = xs[i]!; node.y = ys[i]! })

    // เพื่อนบ้านที่ใกล้ที่สุด k ตัว (เวกเตอร์ normalize แล้ว dot = cosine)
    const edges: [number, number, number][] = []
    const seen = new Set<string>()
    for (let i = 0; i < n; i++) {
      const best: [number, number][] = []
      const vi = vecs[i]!
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const vj = vecs[j]!
        let s = 0
        for (let d = 0; d < dim; d++) s += vi[d]! * vj[d]!
        if (best.length < k) { best.push([j, s]); best.sort((p, q) => q[1] - p[1]) }
        else if (s > best[k - 1]![1]) { best[k - 1] = [j, s]; best.sort((p, q) => q[1] - p[1]) }
      }
      for (const [j, sim] of best) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push([i, j, Math.round(sim * 1000) / 1000])
      }
    }
    return { nodes, edges }
  }

  /**
   * ความจำที่ยังใช้ได้ทั้งหมดของ subject เดียว เรียงตาม attribute: description ก่อน แล้ว p1, p2, ... ตามเลข
   * ใช้ประกอบเอกสารที่ถูกตัดเป็นชิ้นกลับเป็นไฟล์เดิม
   */
  async bySubject(container: string, subject: string, now = Date.now()): Promise<Memory[]> {
    const where: Where = { $and: [{ container }, { active: 1 }, { subject }, { validUntil: { $gt: now } }] }
    const out: Memory[] = []
    for (let offset = 0; ; offset += 1000) {
      const r = await this.reader().get({ where, include: ['metadatas'], limit: 1000, offset })
      r.ids.forEach((id, i) => out.push(toMemory(id, r.metadatas?.[i] as Meta)))
      if (r.ids.length < 1000) break
    }
    const rank = (a: string) => (a === 'description' ? -1 : /^p\d+$/.test(a) ? Number(a.slice(1)) : Number.MAX_SAFE_INTEGER)
    return out.sort((a, b) => rank(a.attribute) - rank(b.attribute) || a.attribute.localeCompare(b.attribute))
  }

  /** รายชื่อ subject ที่ขึ้นต้นด้วย prefix พร้อมจำนวนชิ้น และข้อความของ attribute "description" ถ้ามี */
  async subjects(container: string, prefix = '', now = Date.now()) {
    const by = new Map<string, { subject: string; count: number; description: string; source: string; updatedAt: number }>()
    for (let offset = 0; ; offset += 1000) {
      const r = await this.reader().get({ where: this.liveWhere(container, now), include: ['metadatas'], limit: 1000, offset })
      r.ids.forEach((id, i) => {
        const m = toMemory(id, r.metadatas?.[i] as Meta)
        if (!m.subject || !m.subject.startsWith(prefix)) return
        const e = by.get(m.subject) ?? { subject: m.subject, count: 0, description: '', source: m.source, updatedAt: 0 }
        e.count++
        e.updatedAt = Math.max(e.updatedAt, m.createdAt)
        if (m.attribute === 'description') e.description = m.text
        by.set(m.subject, e)
      })
      if (r.ids.length < 1000) break
    }
    return [...by.values()].sort((a, b) => a.subject.localeCompare(b.subject))
  }

  /** ประวัติของคีย์หนึ่ง รวมรุ่นที่ถูกแทนแล้ว ใหม่สุดก่อน */
  async history(container: string, subject: string, attribute: string): Promise<Memory[]> {
    const r = await this.col.get({ where: { $and: [{ container }, { subject }, { attribute }] }, include: ['metadatas'] })
    return r.ids.map((id, i) => toMemory(id, r.metadatas?.[i] as Meta)).sort((a, b) => b.createdAt - a.createdAt)
  }

  async forget(container: string, id: string): Promise<boolean> {
    const r = await this.col.get({ ids: id, include: ['metadatas'] })
    const m = r.metadatas?.[0] as Meta | undefined
    if (!r.ids.length || !m || m.container !== container) return false
    await this.col.delete({ ids: id })
    return true
  }

  /** ความจำทั้งหมดของ brain สำหรับส่งออก เรียงจากเก่าไปใหม่ · history = รวมรุ่นที่ถูกแทนและที่หมดอายุแล้ว */
  async exportAll(container: string, opts: { history?: boolean; now?: number } = {}): Promise<Memory[]> {
    const where: Where = opts.history ? { container } : this.liveWhere(container, opts.now ?? Date.now())
    const out: Memory[] = []
    for (let offset = 0; ; offset += 1000) {
      const r = await this.reader().get({ where, include: ['metadatas'], limit: 1000, offset })
      r.ids.forEach((id, i) => out.push(toMemory(id, r.metadatas?.[i] as Meta)))
      if (r.ids.length < 1000) break
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** จำนวนความจำที่ยังใช้ได้ */
  async count(container: string, now = Date.now()): Promise<number> {
    let n = 0
    for (let offset = 0; ; offset += 1000) {
      const r = await this.reader().get({ where: this.liveWhere(container, now), include: [], limit: 1000, offset })
      n += r.ids.length
      if (r.ids.length < 1000) break
    }
    return n
  }

  /**
   * สถิติของทุก brain ในรอบเดียว: อ่าน metadata ทั้ง collection แล้วนับในหน่วยความจำ
   * การเขียนถูกนับจาก createdAt ของทุกรุ่น รวมรุ่นที่ถูกแทนแล้ว
   */
  async overview(now = Date.now()): Promise<BrainStats[]> {
    const by = new Map<string, { s: BrainStats; sources: Set<string> }>()
    const bump = (buckets: number[], age: number, size: number) => {
      const i = Math.floor(age / size)
      if (i >= 0 && i < buckets.length) buckets[buckets.length - 1 - i]!++
    }
    for (let offset = 0; ; offset += 1000) {
      const r = await this.reader().get({ include: ['metadatas'], limit: 1000, offset })
      r.ids.forEach((id, i) => {
        const m = toMemory(id, r.metadatas?.[i] as Meta)
        let e = by.get(m.container)
        if (!e) {
          const s: BrainStats = {
            brain: m.container, live: 0, superseded: 0, expired: 0, expiringSoon: 0, kinds: { fact: 0, preference: 0, event: 0 },
            keyed: 0, sources: 0, merges: 0, chars: 0, firstAt: m.createdAt, lastAt: m.createdAt,
            minute: new Array(60).fill(0), hour: new Array(24).fill(0), day: new Array(30).fill(0),
          }
          by.set(m.container, (e = { s, sources: new Set() }))
        }
        const s = e.s
        s.firstAt = Math.min(s.firstAt, m.createdAt)
        s.lastAt = Math.max(s.lastAt, m.createdAt)
        const age = now - m.createdAt
        bump(s.minute, age, 60_000); bump(s.hour, age, 3_600_000); bump(s.day, age, 86_400_000)
        if (!m.active) { s.superseded++; return }
        if (m.validUntil && m.validUntil <= now) { s.expired++; return }
        s.live++
        if (m.validUntil && m.validUntil - now < 7 * 86_400_000) s.expiringSoon++
        if (m.kind in s.kinds) s.kinds[m.kind]++
        if (m.subject && m.attribute) s.keyed++
        if (m.source) e.sources.add(m.source)
        s.merges += Math.max(0, m.count - 1)
        s.chars += m.text.length
      })
      if (r.ids.length < 1000) break
    }
    return [...by.values()].map(({ s, sources }) => ({ ...s, sources: sources.size })).sort((a, b) => b.live - a.live)
  }

  /** ลบความจำทั้งหมดที่มาจากแหล่งเดียวกัน (รวมรุ่นเก่า) ใช้ก่อนนำเข้าไฟล์เดิมซ้ำ */
  async forgetSource(container: string, source: string) {
    await this.col.delete({ where: { $and: [{ container }, { source }] } })
  }

  /** ลบทีละชุดตาม id: คำสั่งลบทั้ง brain ในครั้งเดียวหมดเวลาที่ฐานข้อมูลเมื่อมีหลายพันรายการ */
  async clear(container: string) {
    await this.entities.clear(container)
    for (;;) {
      const r = await this.col.get({ where: { container }, include: [], limit: 500 })
      if (!r.ids.length) break
      await this.col.delete({ ids: [...r.ids] })
    }
  }
}
