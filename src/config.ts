const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v))

export const config = {
  port: num(process.env.PANYA_PORT, 6800),
  // รูปแบบ: "key" (ใช้ได้ทุก container) หรือ "key@container" (ผูกกับ container เดียว) คั่นด้วย ,
  apiKeys: (process.env.PANYA_API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // ที่เก็บความจำ: seekdb = เซิร์ฟเวอร์ seekdb (Docker/คลาวด์ ค่าตั้งต้น) · sqlite = ไฟล์ในเครื่อง ไม่ต้องมี Docker (แอป Windows)
  store: {
    kind: (process.env.PANYA_STORE === 'sqlite' ? 'sqlite' : 'seekdb') as 'seekdb' | 'sqlite',
    // โฟลเดอร์ของไฟล์ฐานข้อมูลแบบ sqlite (หนึ่งไฟล์ต่อ database)
    dataDir: process.env.PANYA_DATA_DIR ?? './data',
  },
  // ซิงก์ทางเดียวไปเซิร์ฟเวอร์ panya อีกตัว (src/sync.ts): ต้องตั้งครบทั้ง url, key (เขียน brain ปลายทางได้) และ brains
  sync: {
    url: process.env.PANYA_SYNC_URL ?? '',
    key: process.env.PANYA_SYNC_KEY ?? '',
    brains: (process.env.PANYA_SYNC_BRAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    intervalSec: Math.max(30, num(process.env.PANYA_SYNC_INTERVAL, 300)),
    // ค่าตั้งต้นไม่ลบที่ปลายทางถ้าในเครื่องหายไปเกินครึ่งในรอบเดียว (กันฐานข้อมูลในเครื่องเสียแล้วลบคลาวด์ทิ้งหมด)
    allowMassDelete: process.env.PANYA_SYNC_ALLOW_MASS_DELETE === '1',
  },
  // local = เริ่มได้แม้ยังไม่มีผู้ใช้ แล้วสร้าง admin คนแรกจากหน้า /login บนเครื่องนี้ (แอป Windows)
  setup: { local: process.env.PANYA_SETUP === 'local' },
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
  // แดชบอร์ดแบบดูอย่างเดียวโดยไม่ต้องใช้ key: เปิดเฉพาะ GET /v1/overview และ /v1/events
  // off = ต้องมี key (ค่าตั้งต้น) · lan = ไม่ต้องมี key เมื่อผู้เรียกมาจากเครื่องนี้หรือเครือข่ายภายใน · all = ใครก็ได้
  // lan ดูจาก IP ของการเชื่อมต่อจริง ถ้าวางหลัง reverse proxy ทุกคำขอจะดูเหมือนมาจากภายใน
  // อยู่หลัง reverse proxy (Caddy/Cloudflare): เชื่อ CF-Connecting-IP / X-Forwarded-For / X-Forwarded-Proto · เปิดเฉพาะเมื่อ proxy อยู่หน้าเสมอ
  trustProxy: process.env.PANYA_TRUST_PROXY === '1',
  // cookie session แบบ Secure: auto = เมื่อคำขอมาทาง https · 1 = เสมอ · 0 = ไม่ (ทดสอบบน http เท่านั้น)
  cookieSecure: (process.env.PANYA_COOKIE_SECURE === '1' ? true : process.env.PANYA_COOKIE_SECURE === '0' ? false : 'auto') as boolean | 'auto',
  // ผู้ใช้ admin คนแรก: สร้างตอนเริ่มเซิร์ฟเวอร์ถ้ายังไม่มีผู้ใช้เลย (ไม่แก้รหัสของผู้ใช้ที่มีอยู่แล้ว)
  bootstrapAdmin: { username: process.env.PANYA_ADMIN_USER ?? '', password: process.env.PANYA_ADMIN_PASSWORD ?? '' },
  publicDashboard: (['lan', 'all'].includes(process.env.PANYA_PUBLIC_DASHBOARD ?? '') ? process.env.PANYA_PUBLIC_DASHBOARD : 'off') as 'off' | 'lan' | 'all',
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
  // ผู้คุมสมอง (src/governor.ts): ติดป้ายหมวดปัญญา 3 ให้ความจำที่ไม่ได้ระบุหมวด ไม่แก้ข้อความ
  // proto = เทียบเวกเตอร์ที่มีอยู่แล้ว ไม่เพิ่มเวลา (ค่าเริ่มต้น) · ollama = โมเดลภาษาในเครื่อง ช้ากว่า · off = ไม่ติดป้าย
  // ตอนบันทึกใช้ proto เสมอ เพื่อไม่ให้การเขียนต้องรอ LLM · โหมด ollama ใช้กับงานติดป้ายย้อนหลัง (bun run govern)
  governor: {
    mode: (['off', 'ollama'].includes(process.env.PANYA_GOVERNOR ?? '') ? process.env.PANYA_GOVERNOR : 'proto') as 'off' | 'proto' | 'ollama',
    ollamaUrl: process.env.PANYA_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    model: process.env.PANYA_GOVERNOR_MODEL ?? 'qwen3:4b-instruct',
    timeoutMs: num(process.env.PANYA_GOVERNOR_TIMEOUT_MS, 60_000),
    // น้ำหนักของคำบ่งชี้เทียบกับความคล้ายของเวกเตอร์ · ปรับจาก bun eval/govern.ts
    cueWeight: num(process.env.PANYA_GOVERNOR_CUE_WEIGHT, 0.01),
    // แต้มต่อของหมวดสุตมยเมื่อข้อความไม่มีคำบ่งชี้ของอีกสองหมวด
    sutaPrior: num(process.env.PANYA_GOVERNOR_SUTA_PRIOR, 0.002),
  },
  // นำเข้าไฟล์ (POST /v1/files): เอกสารอ่านใน JS ได้เสมอ · เสียง/วิดีโอและภาพใช้โปรแกรมในเครื่อง
  // asr/ocr: auto = ใช้เมื่อเครื่องนี้มีโปรแกรม (ค่าเริ่มต้น) · off = ปิด
  files: {
    maxMb: num(process.env.PANYA_UPLOAD_MAX_MB, 200),
    asr: (process.env.PANYA_ASR === 'off' ? 'off' : 'auto') as 'auto' | 'off',
    python: process.env.PANYA_PYTHON ?? 'python',
    // เลือกจากการลองถอดเสียงพูดไทย: large-v3-turbo ถูกเกือบทุกคำ เร็วพอบน CPU · small ผิดเยอะและช้ากว่า
    asrModel: process.env.PANYA_ASR_MODEL ?? 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    // ว่าง = ให้โมเดลตรวจภาษาเอง · th = บังคับไทย
    asrLang: process.env.PANYA_ASR_LANG ?? '',
    ocr: (process.env.PANYA_OCR === 'off' ? 'off' : 'auto') as 'auto' | 'off',
    tesseract: process.env.PANYA_TESSERACT ?? 'tesseract',
    ocrLang: process.env.PANYA_OCR_LANG ?? 'tha+eng',
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
    // วิธีเรียงผลที่ผ่านเกณฑ์: weighted = คะแนนความหมาย+คำ · rrf = Reciprocal Rank Fusion ของสองฝั่ง
    // (เกณฑ์ "รู้/ไม่รู้" ใช้คะแนน weighted เสมอ) · เลือกค่าเริ่มต้นจากผล bun run eval
    fusion: (process.env.PANYA_FUSION === 'rrf' ? 'rrf' : 'weighted') as 'weighted' | 'rrf',
    // ความจำแบบเหตุการณ์ (kind=event) น้ำหนักลดครึ่งทุกกี่วัน · 0 = ไม่ลด
    eventHalfLifeDays: num(process.env.PANYA_EVENT_HALFLIFE_DAYS, 90),
  },
}

export type SearchTuning = typeof config.search
