// แปลงไฟล์ความจำแบบ markdown (มี frontmatter) เป็นรายการความจำสั้น ๆ
// ใช้กับโฟลเดอร์ความจำของ Claude Code แต่ไม่ผูกกับมัน: ไฟล์ .md ที่มี frontmatter แบบเดียวกันใช้ได้หมด

export interface ParsedFile {
  name: string
  description: string
  type: string
  body: string
}

export function parseMemoryFile(raw: string, fallbackName: string): ParsedFile {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { name: fallbackName, description: '', type: '', body: text.trim() }
  const front = m[1]!
  const field = (key: string) => {
    const hit = front.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))
    return hit ? hit[1]!.trim().replace(/^["']|["']$/g, '') : ''
  }
  return { name: field('name') || fallbackName, description: field('description'), type: field('type'), body: m[2]!.trim() }
}

/** ตัดเนื้อหาเป็นก้อนตามย่อหน้า ก้อนที่ยาวเกินถูกแบ่งตามบรรทัด ก้อนที่สั้นมากถูกรวมกับก้อนถัดไป */
export function chunk(body: string, max = 700, min = 40): string[] {
  const out: string[] = []
  const push = (s: string) => {
    const t = s.trim()
    if (!t) return
    const last = out[out.length - 1]
    if (last !== undefined && last.length < min && last.length + t.length + 1 <= max) out[out.length - 1] = last + '\n' + t
    else out.push(t)
  }
  for (const para of body.split(/\n\s*\n/)) {
    if (para.length <= max) { push(para); continue }
    let buf = ''
    for (const line of para.split('\n')) {
      if (buf && buf.length + line.length + 1 > max) { push(buf); buf = '' }
      if (line.length > max) {
        for (let i = 0; i < line.length; i += max) push(line.slice(i, i + max))
      } else buf = buf ? buf + '\n' + line : line
    }
    push(buf)
  }
  return out
}

// ความจำมักมีโทเคนและ key ติดมา: ปิดไว้ก่อนเก็บ เพราะหน้าแสดงผลจะโชว์ข้อความตรง ๆ
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b[a-z]{2,6}_(?:sk|pk|key|secret|token)_[A-Za-z0-9_-]{6,}(?:…|\.\.\.)?/gi,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bsm_[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[0-9a-f]{32,}\b/gi,
  /\b[A-Za-z0-9+/_-]{48,}={0,2}/g,
]

export function redact(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, () => { count++; return '[redacted]' })
  return { text: out, count }
}

export const kindOf = (type: string): 'fact' | 'preference' => (type === 'feedback' || type === 'user' ? 'preference' : 'fact')
