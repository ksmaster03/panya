const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v))

export const config = {
  port: num(process.env.PANYA_PORT, 6800),
  // รูปแบบ: "key" (ใช้ได้ทุก container) หรือ "key@container" (ผูกกับ container เดียว) คั่นด้วย ,
  apiKeys: (process.env.PANYA_API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  seekdb: {
    host: process.env.SEEKDB_HOST ?? '127.0.0.1',
    port: num(process.env.SEEKDB_PORT, 2881),
    user: process.env.SEEKDB_USER ?? 'root',
    password: process.env.SEEKDB_PASSWORD ?? '',
    database: process.env.SEEKDB_DATABASE ?? 'panya',
    collection: process.env.SEEKDB_COLLECTION ?? 'memories',
    // จำนวน connection สำหรับอ่าน: SDK ใช้ connection เดียวต่อ client คำสั่งจึงเข้าคิวกัน
    readPool: num(process.env.SEEKDB_READ_POOL, 4),
  },
  embed: {
    model: process.env.PANYA_EMBED_MODEL ?? 'Xenova/multilingual-e5-small',
    dimension: num(process.env.PANYA_EMBED_DIM, 384),
  },
  // จัดอันดับซ้ำด้วย cross-encoder ตัวเล็ก: ให้คะแนนความเกี่ยวข้องของคู่ (คำถาม, ความจำ) ไม่เขียนหรือแก้ข้อความ
  // ปิดเป็นค่าตั้งต้น เพราะเพิ่มเวลาค้นหลักร้อยมิลลิวินาทีบน CPU · เปิดด้วย PANYA_RERANK=1
  rerank: {
    enabled: process.env.PANYA_RERANK === '1',
    model: process.env.PANYA_RERANK_MODEL ?? 'onnx-community/bge-reranker-v2-m3-ONNX',
    // จำนวนผู้สมัครอันดับต้น (ตามคะแนนเดิม) ที่ส่งให้จัดอันดับซ้ำ เวลาที่ใช้เพิ่มตามจำนวนนี้
    top: num(process.env.PANYA_RERANK_TOP, 10),
  },
  search: {
    // ค่าเหล่านี้ปรับจากชุดทดสอบ (bun run eval) อย่าเดา
    // ใช้เมื่อเปิด reranker: คะแนนสุดท้าย = (1 - rerankWeight) * คะแนนเดิม + rerankWeight * คะแนน reranker
    rerankWeight: num(process.env.PANYA_RERANK_WEIGHT, 0.7),
    rerankMinScore: num(process.env.PANYA_RERANK_MIN_SCORE, 0.2),
    minScore: num(process.env.PANYA_MIN_SCORE, 0.3),
    simFloor: num(process.env.PANYA_SIM_FLOOR, 0.82),
    simCeil: num(process.env.PANYA_SIM_CEIL, 0.9),
    lexWeight: num(process.env.PANYA_LEX_WEIGHT, 0.4),
    candidates: num(process.env.PANYA_CANDIDATES, 20),
    dedupeSim: num(process.env.PANYA_DEDUPE_SIM, 0.985),
  },
}

export type SearchTuning = typeof config.search
