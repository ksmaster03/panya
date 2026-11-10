// ส่งความจำจากเซิร์ฟเวอร์นี้ไปเซิร์ฟเวอร์ panya อีกตัว (เช่น เครื่องในบ้าน → คลาวด์) ทางเดียว เฉพาะ brain ที่เลือก
// แต่ละรอบ: ขอลายนิ้วมือของทุกแถวจากปลายทาง เทียบกับในเครื่อง แล้วส่งเฉพาะแถวที่ใหม่หรือเปลี่ยน และลบแถวที่ในเครื่องไม่มีแล้ว
// ส่งทั้งแถว (id เดิม, metadata, embedding) ปลายทางไม่ต้องคำนวณ embedding ใหม่ และส่งซ้ำกี่รอบก็ไม่เกิดรายการซ้ำ
import { config } from './config'
import type { MemoryStore } from './memory'

export interface BrainSync { brain: string; at: number; local: number; remote: number; sent: number; deleted: number; refused: number; skippedDeletes?: number; error?: string }
export const syncStatus: { enabled: boolean; url: string; brains: string[]; running: boolean; lastRun: number; results: BrainSync[] } = {
  enabled: false, url: '', brains: [], running: false, lastRun: 0, results: [],
}

const BATCH = 200
/** แถวที่ปลายทางปฏิเสธเพราะดูเหมือนมีความลับ (brain → id → ลายนิ้วมือ): ไม่ส่งซ้ำจนกว่าแถวนั้นจะถูกแก้ */
const refusedRows = new Map<string, Map<string, string>>()

async function call(path: string, body?: unknown): Promise<any> {
  const r = await fetch(config.sync.url.replace(/\/$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${config.sync.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status} ${j.error ?? ''}`.trim())
  return j
}

/** ซิงก์ brain เดียวหนึ่งรอบ */
export async function syncBrain(store: MemoryStore, brain: string): Promise<BrainSync> {
  const res: BrainSync = { brain, at: Date.now(), local: 0, remote: 0, sent: 0, deleted: 0, refused: 0 }
  const remote = await call(`/v1/sync/state?brain=${encodeURIComponent(brain)}`)
  if (remote.model !== config.embed.model) throw new Error(`the server uses ${remote.model}, this one ${config.embed.model}: embeddings are not compatible`)
  const theirs: Record<string, string> = remote.state ?? {}
  const ours = await store.syncState(brain)
  res.local = Object.keys(ours).length
  res.remote = Object.keys(theirs).length
  const skip = refusedRows.get(brain) ?? new Map<string, string>()
  refusedRows.set(brain, skip)
  const send = Object.keys(ours).filter((id) => ours[id] !== theirs[id] && skip.get(id) !== ours[id])
  res.refused = Object.keys(ours).filter((id) => skip.get(id) === ours[id]).length
  let del = Object.keys(theirs).filter((id) => !(id in ours))
  // กันพลาด: ในเครื่องอ่านได้ว่างหรือหายไปเกินครึ่ง อาจเป็นเพราะฐานข้อมูลมีปัญหา ไม่ใช่ผู้ใช้ลบจริง จึงไม่ลบที่ปลายทาง
  if (del.length > 100 && del.length > res.remote / 2 && !config.sync.allowMassDelete) {
    res.skippedDeletes = del.length
    del = []
  }
  // ส่งเฉพาะประเภทที่ผ่านกฎของ PUT /v1/entities · ชื่อที่ลงทะเบียนเองจาก subject ปลายทางสร้างใหม่เองตอนรับแถว (putRaw)
  const entities = (await store.entities.list(brain))
    .filter((t) => /^[a-z][a-z0-9_]{0,63}$/.test(t.type))
    .map((t) => ({ type: t.type, cues: t.cues.filter((x) => x.trim() && x.length <= 191), names: t.names.filter((x) => x.trim() && x.length <= 191) }))
  let first = true
  for (let i = 0; i < send.length || first; i += BATCH) {
    const rows = await store.rawByIds(brain, send.slice(i, i + BATCH))
    const r = await call('/v1/sync/push', { brain, model: config.embed.model, upsert: rows, entities: first ? entities : [] })
    for (const id of r.refused ?? []) skip.set(id, ours[id]!)
    res.sent += rows.length - (r.refused?.length ?? 0)
    res.refused += r.refused?.length ?? 0
    first = false
    if (!send.length) break
  }
  for (let i = 0; i < del.length; i += 5000) {
    await call('/v1/sync/push', { brain, model: config.embed.model, delete: del.slice(i, i + 5000) })
    res.deleted += Math.min(5000, del.length - i)
  }
  return res
}

/** ซิงก์ทุก brain ที่ตั้งไว้หนึ่งรอบ (ไม่ซ้อนกันถ้ารอบก่อนยังไม่จบ) */
export async function syncOnce(store: MemoryStore) {
  if (syncStatus.running) return syncStatus.results
  syncStatus.running = true
  const results: BrainSync[] = []
  try {
    for (const brain of config.sync.brains) {
      try {
        const r = await syncBrain(store, brain)
        results.push(r)
        if (r.sent || r.deleted || r.skippedDeletes) console.log(`[panya] sync ${brain} → ${config.sync.url}: sent ${r.sent}, deleted ${r.deleted}${r.refused ? `, ${r.refused} refused as secrets (not sent)` : ''}${r.skippedDeletes ? `, skipped ${r.skippedDeletes} deletes (set PANYA_SYNC_ALLOW_MASS_DELETE=1 if intended)` : ''}`)
      } catch (e) {
        results.push({ brain, at: Date.now(), local: 0, remote: 0, sent: 0, deleted: 0, refused: 0, error: (e as Error).message })
        console.warn(`[panya] sync ${brain} failed: ${(e as Error).message}`)
      }
    }
  } finally {
    syncStatus.running = false
    syncStatus.lastRun = Date.now()
    syncStatus.results = results
  }
  return results
}

/** เริ่มซิงก์ตามรอบ ถ้าตั้ง PANYA_SYNC_URL, PANYA_SYNC_KEY และ PANYA_SYNC_BRAINS ไว้ */
export function startSync(store: MemoryStore) {
  const s = config.sync
  if (!s.url || !s.key || !s.brains.length) return false
  Object.assign(syncStatus, { enabled: true, url: s.url, brains: s.brains })
  const tick = () => syncOnce(store).catch(() => {}).finally(() => setTimeout(tick, s.intervalSec * 1000))
  setTimeout(tick, 5000)
  return true
}
