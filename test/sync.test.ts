// เทสต์ซิงก์ทางเดียว (src/sync.ts): ต้นทางและปลายทางเป็นที่เก็บคนละชุด ปลายทางรันเป็นเซิร์ฟเวอร์จริงบนพอร์ตสุ่ม
// ใช้ที่เก็บตาม PANYA_STORE: seekdb (ต้องรันอยู่ ใช้ฐาน panya_test) หรือ sqlite (ไฟล์ในโฟลเดอร์ชั่วคราว)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config'
import { localEmbedder } from '../src/embed'
import { MemoryStore } from '../src/memory'
import { createApp } from '../src/server'
import { syncBrain } from '../src/sync'

const dir = mkdtempSync(join(tmpdir(), 'panya-sync-'))
const BRAIN = 'synced'
let src: MemoryStore, dst: MemoryStore
let server: ReturnType<typeof Bun.serve>
const saved = { store: { ...config.store }, sync: { ...config.sync } }

beforeAll(async () => {
  if (config.store.kind === 'sqlite') config.store.dataDir = dir
  // คนละฐานข้อมูล: ตาราง entity ไม่ใช้ร่วมกัน จึงเห็นว่าชื่อเฉพาะถูกส่งไปจริง
  src = await MemoryStore.open(localEmbedder, { database: 'panya_test', collection: 'memories_sync_src' })
  dst = await MemoryStore.open(localEmbedder, { database: 'panya_test_sync', collection: 'memories_sync_dst' })
  await src.entities.clear(BRAIN); await dst.entities.clear(BRAIN)
  await src.clear(BRAIN); await dst.clear(BRAIN)
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: createApp(dst, ['sync-key', `other-key@elsewhere`], { publicDashboard: 'off' }).fetch })
  Object.assign(config.sync, { url: `http://127.0.0.1:${server.port}`, key: 'sync-key' })
}, 60_000)

afterAll(async () => {
  server?.stop(true)
  await src?.close(); await dst?.close()
  Object.assign(config.store, saved.store); Object.assign(config.sync, saved.sync)
  try { rmSync(dir, { recursive: true, force: true }) } catch {} // Windows อาจยังล็อกไฟล์ WAL อยู่ครู่หนึ่ง
})

const ids = async (s: MemoryStore) => Object.keys(await s.syncState(BRAIN)).sort()

describe('sync local → server', () => {
  test('รอบแรกคัดลอกทุกแถวด้วย id เดิม ค้นที่ปลายทางเจอ และรอบถัดไปไม่ส่งซ้ำ', async () => {
    await src.entities.register(BRAIN, 'customer', ['ลูกค้า'], ['สยามโลจิสติกส์'])
    await src.remember({ container: BRAIN, text: 'ร้านกาแฟหน้าออฟฟิศปิดวันอาทิตย์' })
    await src.remember({ container: BRAIN, text: 'ห้อง B2 ว่าง', subject: 'room:B2', attribute: 'status' })
    await src.remember({ container: BRAIN, text: 'ห้อง B2 ปิดซ่อมถึงวันศุกร์', subject: 'room:B2', attribute: 'status' })
    const r = await syncBrain(src, BRAIN)
    expect(r).toMatchObject({ local: 3, remote: 0, sent: 3, deleted: 0 })
    expect(await ids(dst)).toEqual(await ids(src))
    expect(await dst.syncState(BRAIN)).toEqual(await src.syncState(BRAIN))
    const hit = await dst.search(BRAIN, 'ห้อง B2 ตอนนี้เป็นอย่างไร')
    expect(hit.hits[0]?.text).toBe('ห้อง B2 ปิดซ่อมถึงวันศุกร์')
    expect((await dst.entities.list(BRAIN)).find((t) => t.type === 'customer')?.names).toContain('สยามโลจิสติกส์')
    expect(await syncBrain(src, BRAIN)).toMatchObject({ sent: 0, deleted: 0 })
  }, 60_000)

  test('แถวที่เปลี่ยนส่งใหม่เฉพาะแถวนั้น แถวที่ลบในเครื่องถูกลบที่ปลายทาง', async () => {
    const merged = await src.remember({ container: BRAIN, text: 'ร้านกาแฟหน้าออฟฟิศปิดวันอาทิตย์' })
    expect(merged.action).toBe('merged')
    const extra = await src.remember({ container: BRAIN, text: 'ประชุมทีมทุกวันจันทร์ 10 โมง' })
    await src.forget(BRAIN, extra.memory.id)
    const gone = Object.keys(await dst.syncState(BRAIN)).find((id) => id !== merged.memory.id)!
    await src.forget(BRAIN, gone)
    const r = await syncBrain(src, BRAIN)
    expect(r.deleted).toBe(1)
    expect(r.sent).toBe(1)
    expect(await dst.syncState(BRAIN)).toEqual(await src.syncState(BRAIN))
  }, 60_000)

  test('ในเครื่องหายเกินครึ่งในรอบเดียว: ไม่ลบที่ปลายทาง', async () => {
    await src.rememberMany(Array.from({ length: 120 }, (_, i) => ({ container: BRAIN, text: `บันทึกทดสอบหมายเลข ${i} เรื่องที่ ${i * 7}`, subject: `note:${i}`, attribute: 'body' })))
    expect((await syncBrain(src, BRAIN)).sent).toBe(120)
    await src.clear(BRAIN)
    const r = await syncBrain(src, BRAIN)
    expect(r.deleted).toBe(0)
    expect(r.skippedDeletes).toBeGreaterThan(100)
    expect((await ids(dst)).length).toBeGreaterThan(100)
  }, 120_000)

  test('ปลายทางปฏิเสธ: โมเดลต่างกัน ความลับ key ของ brain อื่น', async () => {
    const push = (body: unknown, key = 'sync-key') => fetch(`${config.sync.url}/v1/sync/push`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const row = { id: 'x1', doc: 'x', embedding: Array(config.embed.dimension).fill(0.01), meta: { text: 'ปกติ', createdAt: 1, validUntil: 9e15, active: 1 } }
    expect((await push({ brain: BRAIN, model: 'other/model', upsert: [row] })).status).toBe(409)
    const secret = { ...row, meta: { ...row.meta, text: 'password: Hunter2-Very-Secret-99' } }
    const sr = await push({ brain: BRAIN, model: config.embed.model, upsert: [secret, { ...row, id: 'x2' }] })
    expect(await sr.json()).toMatchObject({ upserted: 1, refused: ['x1'] })
    await dst.deleteIds(BRAIN, ['x2'])
    expect((await push({ brain: BRAIN, model: config.embed.model, upsert: [{ ...row, embedding: [1, 2] }] })).status).toBe(400)
    expect((await push({ brain: BRAIN, model: config.embed.model, upsert: [row] }, 'other-key')).status).toBe(403)
    expect((await fetch(`${config.sync.url}/v1/sync/status`, { headers: { authorization: 'Bearer other-key' } })).status).toBe(403)
    expect(await dst.rawByIds(BRAIN, ['x1'])).toEqual([])
  })
})
