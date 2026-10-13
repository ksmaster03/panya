// เทสต์การจัดอันดับซ้ำ: ใช้ reranker จำลองที่ให้คะแนนตามคำที่กำหนด ไม่โหลดโมเดลจริง · ต้องมี seekdb รันอยู่
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { localEmbedder } from '../src/embed'
import { MemoryStore } from '../src/memory'
import type { Reranker } from '../src/rerank'
import { createApp } from '../src/server'

const C = 'test_rerank'
const LATE = 'ผู้ขนส่ง สยามโลจิสติกส์ มาสายเกิน 45 นาที ที่ท่า D-04'
const GATE = 'ผู้ขนส่ง สยามโลจิสติกส์ ถูกปฏิเสธที่ประตูเพราะเอกสารไม่ครบ'
const Q = 'ผู้ขนส่ง สยามโลจิสติกส์ มาสาย'

// ให้คะแนนสูงกับข้อความที่มีคำใน favour และจดไว้ว่าถูกถามด้วยอะไรบ้าง
let favour = ''
const seen: { query: string; docs: string[] }[] = []
const fake: Reranker = {
  async score(query, docs) {
    seen.push({ query, docs })
    return docs.map((d) => (favour && d.includes(favour) ? 0.95 : 0.02))
  },
}

let store: MemoryStore
beforeAll(async () => {
  store = await MemoryStore.open(localEmbedder, { collection: 'memories_test', reranker: fake })
  await store.clear(C)
  await store.remember({ container: C, text: LATE })
  await store.remember({ container: C, text: GATE })
}, 120_000)

afterAll(async () => {
  await store.clear(C)
  await store.close()
})

describe('rerank', () => {
  test('ไม่ใช้ reranker: อันดับตามคะแนนเดิม และไม่มีคะแนน rerank ติดมา', async () => {
    seen.length = 0
    const r = await store.search(C, Q, { rerank: false })
    expect(r.hits[0]?.text).toBe(LATE)
    expect(r.hits[0]?.rerank).toBeUndefined()
    expect(r.reranked).toBeUndefined()
    expect(seen).toHaveLength(0)
  })

  test('reranker เปลี่ยนอันดับได้ และข้อความยังตรงต้นฉบับ', async () => {
    favour = 'ประตู'
    seen.length = 0
    const r = await store.search(C, Q)
    expect(r.reranked).toBe(true)
    expect(r.hits[0]?.text).toBe(GATE)
    expect(r.hits[0]?.rerank).toBe(0.95)
    // reranker ได้รับคำถามเดิมและข้อความความจำตามที่เก็บไว้ตรงตัว
    expect(seen[0]?.query).toBe(Q)
    expect(seen[0]?.docs.sort()).toEqual([LATE, GATE].sort())
  })

  test('reranker บอกว่าไม่มีรายการไหนเกี่ยว: ไม่ตอบ', async () => {
    favour = ''
    const r = await store.search(C, Q, { tuning: { rerankWeight: 1 } })
    expect(r).toEqual({ hits: [], abstained: true, reason: 'no_match', reranked: true })
  })

  test('ส่งให้ reranker เฉพาะอันดับต้นตามจำนวนที่กำหนด', async () => {
    favour = 'ประตู'
    seen.length = 0
    const r = await store.search(C, Q, { rerankTop: 1 })
    expect(seen[0]?.docs).toEqual([LATE])
    expect(r.hits.map((h) => h.text)).not.toContain(GATE)
  })

  test('API: ส่ง rerank: false เพื่อข้าม reranker ต่อคำขอ', async () => {
    favour = 'ประตู'
    const app = createApp(store, ['k'])
    const ask = async (body: object) =>
      (await app.request('/v1/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify({ brain: C, q: Q, ...body }) })).json() as Promise<any>
    expect((await ask({})).hits[0].text).toBe(GATE)
    expect((await ask({})).reranked).toBe(true)
    expect((await ask({ rerank: false })).hits[0].text).toBe(LATE)
  })
})
