// ผู้คุมสมอง: ติดป้ายหมวดปัญญา 3 ให้ความจำที่ผู้ส่งไม่ได้ระบุหมวด
//   suta    สุตมยปัญญา  ปัญญาจากการฟังและการเรียนรู้ (อ่าน ฟัง มีคนบอก ข้อมูลจากแหล่งภายนอก)
//   cinta   จินตมยปัญญา  ปัญญาจากการคิดพิจารณา (วิเคราะห์ ข้อสรุป การตัดสินใจ แผน)
//   bhavana ภาวนามยปัญญา ปัญญาจากการลงมือปฏิบัติและฝึกฝน (บทเรียน ประสบการณ์ สิ่งที่ลองแล้ว)
// ผู้คุมสมองแค่ติดป้าย ไม่เขียนหรือแก้ข้อความของความจำ เหมือน reranker
import { config } from './config'
import type { Embedder } from './embed'

export type Panya = 'suta' | 'cinta' | 'bhavana'
export const PANYA: readonly Panya[] = ['suta', 'cinta', 'bhavana']
export const isPanya = (v: unknown): v is Panya => typeof v === 'string' && (PANYA as readonly string[]).includes(v)

export interface Verdict {
  panya: Panya
  /** 0-1 ความมั่นใจของป้ายนี้ */
  confidence: number
  /** proto = เทียบเวกเตอร์กับตัวอย่างประจำหมวด · llm = โมเดลภาษาในเครื่อง (Ollama) */
  by: 'proto' | 'llm'
}

export interface Governor {
  readonly name: string
  /** vectors = passage embedding ของข้อความเดียวกัน (ถ้ามี จะไม่คำนวณซ้ำ) */
  classify(texts: string[], vectors?: number[][]): Promise<Verdict[]>
}

// ตัวอย่างประจำหมวด: เขียนให้กว้างและไม่ซ้ำกับชุดทดสอบ (eval/panya3.json) เพื่อไม่ให้ผลวัดดีเกินจริง
const ANCHORS: Record<Panya, string[]> = {
  suta: [
    'เอกสารระบุว่า', 'ตามคู่มือของผู้ผลิต', 'มีคนแจ้งมาว่า', 'อ่านเจอในบทความว่า', 'ข้อมูลจากเว็บไซต์ทางการ',
    'ลูกค้าบอกว่า', 'กฎระเบียบกำหนดไว้ว่า', 'ข้อมูลอ้างอิง สเปกและตัวเลขของสินค้า',
    'The documentation states that', 'According to the official source', 'I read in an article that', 'The specification lists',
  ],
  cinta: [
    'วิเคราะห์แล้วสรุปว่า', 'เราตัดสินใจเลือกทางนี้เพราะ', 'แผนต่อไปคือ', 'ควรทำแบบนี้ด้วยเหตุผลว่า', 'เปรียบเทียบข้อดีข้อเสียแล้ว',
    'สมมติฐานคือ', 'ถ้าเป็นแบบนี้ น่าจะเกิดผลแบบนั้น', 'แนวทางที่เลือก',
    'We decided to', 'My conclusion is', 'The trade-off is', 'The plan is to', 'This is probably caused by',
  ],
  bhavana: [
    'ลองทำจริงแล้วพบว่า', 'บทเรียนจากครั้งที่แล้ว', 'เคยพลาดมาแล้ว ครั้งนี้เลยทำแบบใหม่', 'ฝึกจนชำนาญ', 'ทำไปหลายรอบจึงรู้ว่า',
    'จากประสบการณ์ที่ทำมา', 'ลงมือแก้เองแล้วได้ผล', 'ทำต่อเนื่องมาหลายเดือนแล้วเห็นผล',
    'Lesson learned', 'When I tried it, it failed because', 'From experience', 'What worked in practice', 'After doing it many times',
  ],
}

// คำบ่งชี้: ค่าเริ่มต้นปรับจากครึ่ง tune ของ eval/panya3.json (bun eval/govern.ts)
const CUES: Record<Panya, RegExp> = {
  suta: /(เอกสาร|คู่มือ|ระบุว่า|ประกาศ|แจ้งว่า|บอกว่า|เล่าว่า|อ่านจาก|ตามที่|ข่าว|บทความ|ระเบียบ|มาตรฐาน|กำหนดให้|วิทยากร|ใบเสนอราคา|\b(docs?|documentation|according to|release notes|changelog|reference|the paper|vendor|says?|lists?|mention)\b)/i,
  cinta: /(สรุป|ตัดสินใจ|วิเคราะห์|ควร|เหตุผล|แผน|สมมติฐาน|เปรียบเทียบ|เลือก|กลยุทธ์|ประเมิน|พิจารณา|ออกแบบ|คิดว่า|น่าจะ|แนวทาง|\b(decided|decide|conclu\w+|reasoning|trade-?off|should|plan|probably|priority|strategy|if .* we)\b)/i,
  bhavana: /(ลอง|บทเรียน|พลาด|เคย|ฝึก|ซ้อม|ทำจริง|ลงมือ|ประสบการณ์|พบว่า|ได้ผล|หลังใช้|ครั้งก่อน|ครั้งแรก|รอบที่แล้ว|ตั้งแต่นั้น|จนรู้|\b(lesson|tried|experience|in practice|what worked|drill|once|now we always)\b)/i,
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0)
function centroid(vs: number[][]): number[] {
  const c = new Array(vs[0]!.length).fill(0)
  for (const v of vs) for (let i = 0; i < v.length; i++) c[i] += v[i]!
  const n = Math.hypot(...c) || 1
  return c.map((x) => x / n)
}

/** คะแนนดิบต่อหมวด (ใช้ใน eval เพื่อลองน้ำหนักโดยไม่ต้องคำนวณเวกเตอร์ซ้ำ) */
export interface ProtoScores { sim: Record<Panya, number>; cue: Record<Panya, number> }

export class PrototypeGovernor implements Governor {
  readonly name = 'proto'
  private centroids: Promise<Record<Panya, number[]>> | null = null
  constructor(private embedder: Embedder, private cueWeight = config.governor.cueWeight, private sutaPrior = config.governor.sutaPrior) {}

  private load() {
    this.centroids ??= (async () => {
      const out = {} as Record<Panya, number[]>
      for (const p of PANYA) out[p] = centroid(await this.embedder.passage(ANCHORS[p]))
      return out
    })()
    return this.centroids
  }

  async scores(texts: string[], vectors?: number[][]): Promise<ProtoScores[]> {
    const c = await this.load()
    const vecs = vectors ?? (await this.embedder.passage(texts))
    return texts.map((t, i) => {
      const sim = {} as Record<Panya, number>, cue = {} as Record<Panya, number>
      for (const p of PANYA) { sim[p] = dot(vecs[i]!, c[p]); cue[p] = CUES[p].test(t) ? 1 : 0 }
      return { sim, cue }
    })
  }

  static decide(s: ProtoScores, cueWeight: number, sutaPrior = config.governor.sutaPrior): Verdict {
    // ข้อความที่ไม่มีร่องรอยของการคิดหรือการลงมือทำ มักเป็นข้อมูลที่รับมา (สุตมย) จึงเอนไปทางนั้นเล็กน้อย
    const plain = !s.cue.cinta && !s.cue.bhavana ? sutaPrior : 0
    // ความคล้ายของ e5 อยู่ในช่วงแคบ (ราว 0.75-0.9) จึงวัดความมั่นใจจากช่องว่างระหว่างอันดับ 1 กับ 2
    const ranked = PANYA.map((p) => ({ p, v: s.sim[p] + cueWeight * s.cue[p] + (p === 'suta' ? plain : 0) })).sort((a, b) => b.v - a.v)
    const gap = ranked[0]!.v - ranked[1]!.v
    return { panya: ranked[0]!.p, confidence: Math.round(Math.min(1, 0.34 + gap * 8) * 100) / 100, by: 'proto' }
  }

  async classify(texts: string[], vectors?: number[][]): Promise<Verdict[]> {
    if (!texts.length) return []
    return (await this.scores(texts, vectors)).map((s) => PrototypeGovernor.decide(s, this.cueWeight, this.sutaPrior))
  }
}

const SYSTEM = `Classify where the knowledge in one memory from a team knowledge base came from (the Buddhist "three kinds of wisdom"):
suta = received from outside: read, heard, told, documented, a spec, a rule, a fact someone reported
cinta = from thinking it through: analysis, conclusion, decision and its reason, plan, hypothesis, comparison
bhavana = from doing: lesson learned, first-hand experience, what worked or failed when actually tried, a practised skill
The memory may be Thai or English. Judge where the knowledge came from, not the topic. Answer with exactly one word.`

// โมเดลตอบคำเดียวโดยไม่บังคับรูปแบบ JSON: วัดแล้วเร็วกว่า และการบังคับ enum ทำให้โมเดลบางตัวตอบหมวดแรกทุกข้อ
// ไม่มีคะแนนความมั่นใจจากโมเดล จึงให้ค่าคงที่ไว้สูงกว่าเกณฑ์ที่หน้าเว็บถือว่า "ระบบเดา"
const LLM_CONFIDENCE = 0.8

/** โมเดลภาษาในเครื่องผ่าน Ollama: ช้ากว่า (ราว 1-3 วินาทีต่อรายการบน CPU) ล้มเมื่อไรถอยไปใช้ fallback */
export class OllamaGovernor implements Governor {
  readonly name: string
  constructor(private fallback: Governor, private url = config.governor.ollamaUrl, private model = config.governor.model, private timeoutMs = config.governor.timeoutMs) {
    this.name = `llm:${model}`
  }

  private async one(text: string): Promise<Verdict> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 16 },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text.slice(0, 2000) }],
      }),
    })
    if (!res.ok) throw new Error(`ollama ${res.status}`)
    const body = (await res.json()) as { message?: { content?: string } }
    // โมเดลแบบคิดก่อนตอบอาจแนบ <think>...</think> มาด้วย ตัดทิ้งก่อนอ่านคำตอบ
    const answer = (body.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').toLowerCase()
    const label = answer.match(/\b(suta|cinta|bhavana)\b/)?.[1]
    if (!isPanya(label)) throw new Error('ollama returned no label')
    return { panya: label, confidence: LLM_CONFIDENCE, by: 'llm' }
  }

  async classify(texts: string[], vectors?: number[][]): Promise<Verdict[]> {
    const out: Verdict[] = []
    // ทีละรายการ: Ollama บน CPU รันพร้อมกันไม่เร็วขึ้น และลำดับผลต้องตรงกับลำดับข้อความ
    for (let i = 0; i < texts.length; i++) {
      try { out.push(await this.one(texts[i]!)) } catch { out.push((await this.fallback.classify([texts[i]!], vectors && [vectors[i]!]))[0]!) }
    }
    return out
  }
}

/** ผู้คุมสมองตาม config: off = ไม่ติดป้ายให้ · proto (ค่าเริ่มต้น) · ollama */
export function makeGovernor(embedder: Embedder, mode = config.governor.mode): Governor | null {
  if (mode === 'off') return null
  const proto = new PrototypeGovernor(embedder)
  return mode === 'ollama' ? new OllamaGovernor(proto) : proto
}
