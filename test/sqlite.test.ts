// เทสต์ที่เก็บแบบไฟล์ (PANYA_STORE=sqlite) และการตั้งค่าครั้งแรกของแอปในเครื่อง: ไม่ต้องมี seekdb
// ชุดเทสต์อื่นรันกับ sqlite ได้ทั้งชุดด้วย PANYA_STORE=sqlite PANYA_DATA_DIR=<โฟลเดอร์ชั่วคราว> bun test
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config'
import { localEmbedder } from '../src/embed'
import { MemoryStore } from '../src/memory'
import { createApp, SESSION_COOKIE } from '../src/server'
import { SqliteClient } from '../src/sqlite'

const dir = mkdtempSync(join(tmpdir(), 'panya-sqlite-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('SqliteCollection', () => {
  const client = new SqliteClient(dir, 'unit')
  const col = client.collection('m')
  afterAll(() => client.close())

  beforeAll(async () => {
    await col.add({
      ids: ['a', 'b', 'c', 'd'],
      documents: ['กาแฟ ร้าน เปิด เช้า', 'ประชุม ทีม จันทร์', 'กาแฟ กาแฟ ราคา', 'ลูกค้า c-1042'],
      embeddings: [[1, 0, 0], [0, 1, 0], [0.9, 0.1, 0], [0, 0, 1]],
      metadatas: [
        { container: 'x', active: 1, validUntil: 9e15, kind: 'fact', subject: '' },
        { container: 'x', active: 1, validUntil: 9e15, kind: 'event', subject: 'meeting' },
        { container: 'x', active: 0, validUntil: 9e15, kind: 'fact', invalidAt: 50 },
        { container: 'y', active: 1, validUntil: 9e15, kind: 'fact' },
      ],
    })
  })

  test('where: $and $or $in $ne $gt และค่าที่ไม่มีในบางแถว', async () => {
    const ids = async (where: any) => (await col.get({ where })).ids.sort()
    expect(await ids({ container: 'x' })).toEqual(['a', 'b', 'c'])
    expect(await ids({ $and: [{ container: 'x' }, { active: 1 }] })).toEqual(['a', 'b'])
    expect(await ids({ $or: [{ kind: 'event' }, { container: 'y' }] })).toEqual(['b', 'd'])
    expect(await ids({ kind: { $in: ['event'] } })).toEqual(['b'])
    // ไม่มี subject = ไม่ผ่าน $ne เหมือน seekdb
    expect(await ids({ subject: { $ne: '' } })).toEqual(['b'])
    expect(await ids({ invalidAt: { $gt: 10 } })).toEqual(['c'])
  })

  test('query: เรียงตามระยะ cosine และกรองด้วย where', async () => {
    const r = await col.query({ queryEmbeddings: [1, 0, 0], nResults: 2, where: { container: 'x' } })
    expect(r.ids[0]).toEqual(['a', 'c'])
    expect(r.distances[0]![0]).toBeCloseTo(0, 5)
  })

  test('hybridSearch: คำใดคำหนึ่งตรง เรียงตาม BM25 · get $contains ต้องมีครบทุกคำ', async () => {
    const r = await col.hybridSearch({ query: { whereDocument: { $contains: 'กาแฟ ราคา' }, where: { container: 'x' } }, nResults: 5 })
    expect(r.ids[0]).toEqual(['c', 'a'])
    expect((await col.get({ whereDocument: { $contains: 'กาแฟ เช้า' } })).ids).toEqual(['a'])
    expect((await col.get({ whereDocument: { $contains: 'c-1042' } })).ids).toEqual(['d'])
  })

  test('update, delete, limit/offset และ embeddings', async () => {
    await col.update({ ids: 'b', metadatas: { container: 'x', active: 0, validUntil: 9e15, kind: 'event' } })
    expect((await col.get({ where: { $and: [{ container: 'x' }, { active: 1 }] } })).ids).toEqual(['a'])
    expect((await col.get({ limit: 2, offset: 1 })).ids).toEqual(['b', 'c'])
    expect((await col.get({ ids: ['d'], include: ['embeddings'] })).embeddings).toEqual([[0, 0, 1]])
    await col.delete({ where: { container: 'y' } })
    expect((await col.query({ queryEmbeddings: [0, 0, 1], nResults: 5 })).ids[0]).not.toContain('d')
  })

  test('execute: SQL แบบ MySQL ของ registry', async () => {
    await client.execute('CREATE TABLE IF NOT EXISTS t (k VARCHAR(10) NOT NULL PRIMARY KEY, v TINYINT)')
    await client.execute('INSERT IGNORE INTO t (k, v) VALUES (?, ?)', ['a', true])
    await client.execute('INSERT IGNORE INTO t (k, v) VALUES (?, ?)', ['a', 2])
    await client.execute('REPLACE INTO t (k, v) VALUES (?, ?)', ['b', undefined])
    expect(await client.execute('SELECT k, v FROM t ORDER BY k')).toEqual([{ k: 'a', v: 1 }, { k: 'b', v: null }])
  })
})

describe('ตั้งค่าครั้งแรก (PANYA_SETUP=local)', () => {
  let store: MemoryStore
  let server: ReturnType<typeof Bun.serve>
  const saved = { ...config.store }, savedSetup = config.setup.local
  const url = (p: string) => `http://127.0.0.1:${server.port}${p}`
  const post = (p: string, body: unknown, origin?: string) =>
    fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })

  beforeAll(async () => {
    Object.assign(config.store, { kind: 'sqlite', dataDir: dir })
    config.setup.local = true
    store = await MemoryStore.open(localEmbedder, { database: 'setup_test', collection: 'memories' })
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: createApp(store, [], { publicDashboard: 'off' }).fetch })
  }, 60_000)
  afterAll(async () => {
    server?.stop(true)
    await store?.close()
    Object.assign(config.store, saved)
    config.setup.local = savedSetup
  })

  test('เปิดเฉพาะตอนยังไม่มีผู้ใช้ สร้าง admin ได้ครั้งเดียว แล้วปิดเอง', async () => {
    expect(await (await fetch(url('/auth/setup'))).json()).toEqual({ needed: true })
    expect((await post('/auth/setup', { username: 'Bad Name', password: 'long-enough-pass' })).status).toBe(400)
    expect((await post('/auth/setup', { username: 'owner', password: 'short' })).status).toBe(400)
    expect((await post('/auth/setup', { username: 'owner', password: 'long-enough-pass' }, 'https://evil.example')).status).toBe(403)
    const ok = await post('/auth/setup', { username: 'owner', password: 'long-enough-pass' })
    expect(ok.status).toBe(201)
    expect(ok.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`)
    expect((await store.users.get('owner'))?.role).toBe('admin')
    expect(await (await fetch(url('/auth/setup'))).json()).toEqual({ needed: false })
    expect((await post('/auth/setup', { username: 'second', password: 'long-enough-pass' })).status).toBe(403)
  })
})
