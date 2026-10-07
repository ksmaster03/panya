// ตัดคำสำหรับ full-text: ไทยใช้ Intl.Segmenter ส่วนรหัส (D-04, 70-1234, BK-2026-0012) เก็บเป็นโทเคนเดียว
// เอกสารและคำค้นต้องผ่านฟังก์ชันเดียวกันเสมอ ไม่งั้นค้นไม่เจอ

const segmenter = new Intl.Segmenter('th', { granularity: 'word' })

// รหัส = ตัวอักษรละติน/ตัวเลขที่คั่นด้วย - / . และมีตัวเลขอย่างน้อยหนึ่งตัว
const CODE_RE = /[A-Za-z0-9]+(?:[-/.][A-Za-z0-9]+)+|[A-Za-z]+\d+[A-Za-z0-9]*|\d+[A-Za-z]+[A-Za-z0-9]*/g

// คำไทยที่เจอแทบทุกประโยค ถ้าเก็บไว้จะทำให้คำถามนอกเรื่องดูเหมือนตรง
const STOPWORDS = new Set([
  'ที่', 'และ', 'หรือ', 'ของ', 'ใน', 'เป็น', 'ได้', 'ให้', 'มี', 'ไม่', 'จะ', 'ว่า', 'กับ', 'แล้ว', 'ก็', 'นี้', 'นั้น',
  'ไป', 'มา', 'อยู่', 'คือ', 'จาก', 'โดย', 'ถึง', 'ต้อง', 'เพราะ', 'แต่', 'ยัง', 'ด้วย', 'อีก', 'ทุก', 'การ', 'ความ',
  'ไหน', 'ที่ไหน', 'ราย', 'รายไหน', 'ไหม', 'ใคร', 'อะไร', 'อย่างไร', 'ยังไง', 'เท่าไร', 'เท่าไหร่', 'เมื่อไร', 'เมื่อไหร่', 'ทำไม', 'กี่', 'เมื่อ', 'ซึ่ง', 'ผู้', 'คน', 'ตัว', 'บ้าง', 'นะ', 'ครับ', 'ค่ะ',
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'at', 'on', 'for', 'and', 'or', 'which', 'what', 'who', 'does', 'do',
])

export function codeToken(raw: string): string {
  return raw.toLowerCase().replace(/[-/.]/g, '')
}

/** โทเคนทั้งหมดของข้อความ (ซ้ำได้ เรียงตามลำดับที่เจอ) */
export function tokenize(text: string): string[] {
  const s = text.normalize('NFC')
  const out: string[] = []
  let last = 0
  const pushPlain = (chunk: string) => {
    for (const part of segmenter.segment(chunk)) {
      if (!part.isWordLike) continue
      const w = part.segment.toLowerCase()
      if (STOPWORDS.has(w)) continue
      out.push(w)
    }
  }
  for (const m of s.matchAll(CODE_RE)) {
    if (!/\d/.test(m[0])) continue
    pushPlain(s.slice(last, m.index))
    out.push(codeToken(m[0]))
    last = m.index + m[0].length
  }
  pushPlain(s.slice(last))
  return out
}

/** รหัสที่อยู่ในข้อความ ใช้เป็นสัญญาณจับคู่ตรงตัว */
export function extractCodes(text: string): string[] {
  const codes = new Set<string>()
  for (const m of text.normalize('NFC').matchAll(CODE_RE)) if (/\d/.test(m[0])) codes.add(codeToken(m[0]))
  return [...codes]
}

/** สัดส่วนโทเคนของคำค้น (ไม่นับซ้ำ) ที่พบในเอกสาร */
export function coverage(queryTokens: string[], docTokens: string[]): number {
  const q = new Set(queryTokens)
  if (q.size === 0) return 0
  const d = new Set(docTokens)
  let hit = 0
  for (const t of q) if (d.has(t)) hit++
  return hit / q.size
}
