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
  },
  embed: {
    model: process.env.PANYA_EMBED_MODEL ?? 'Xenova/multilingual-e5-small',
    dimension: num(process.env.PANYA_EMBED_DIM, 384),
  },
  search: {
    // ค่าเหล่านี้ปรับจากชุดทดสอบ (bun run eval) อย่าเดา
    minScore: num(process.env.PANYA_MIN_SCORE, 0.3),
    simFloor: num(process.env.PANYA_SIM_FLOOR, 0.82),
    simCeil: num(process.env.PANYA_SIM_CEIL, 0.9),
    lexWeight: num(process.env.PANYA_LEX_WEIGHT, 0.4),
    candidates: num(process.env.PANYA_CANDIDATES, 20),
    dedupeSim: num(process.env.PANYA_DEDUPE_SIM, 0.985),
  },
}

export type SearchTuning = typeof config.search
