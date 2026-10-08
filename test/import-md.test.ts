import { describe, expect, test } from 'bun:test'
import { chunk, kindOf, parseMemoryFile, redact } from '../src/import-md'

describe('นำเข้าไฟล์ความจำ', () => {
  test('อ่าน frontmatter และเนื้อหา', () => {
    const f = parseMemoryFile('---\nname: a-b\ndescription: "คำอธิบาย"\nmetadata:\n  type: feedback\n---\n\nเนื้อหา\n', 'x')
    expect(f).toEqual({ name: 'a-b', description: 'คำอธิบาย', type: 'feedback', body: 'เนื้อหา' })
    expect(kindOf(f.type)).toBe('preference')
  })

  test('ไฟล์ที่ไม่มี frontmatter ใช้ชื่อไฟล์แทน', () => {
    expect(parseMemoryFile('ข้อความล้วน', 'fallback')).toEqual({ name: 'fallback', description: '', type: '', body: 'ข้อความล้วน' })
  })

  test('ตัดตามย่อหน้า รวมก้อนสั้น และแบ่งก้อนยาว', () => {
    expect(chunk('ก\n\n' + 'ข'.repeat(60) + '\n\n' + 'ค'.repeat(60))).toEqual(['ก\n' + 'ข'.repeat(60), 'ค'.repeat(60)])
    const long = Array.from({ length: 30 }, (_, i) => `บรรทัดที่ ${i} ` + 'x'.repeat(40)).join('\n')
    const parts = chunk(long, 300)
    expect(parts.length).toBeGreaterThan(3)
    expect(parts.every((p) => p.length <= 300)).toBe(true)
    expect(parts.join('\n')).toBe(long)
  })

  test('ปิดโทเคนและ key แต่ไม่แตะข้อความปกติ', () => {
    const r = redact('ใช้ sk-FAKEFAKEFAKEFAKEFAKE1234 กับ mw_sk_FAKEtoken123 และ ghp_abcdefghijklmnopqrstuvwx ที่ท่า D-04 เวลา 08:00')
    expect(r.count).toBe(3)
    expect(r.text).toBe('ใช้ [redacted] กับ [redacted] และ [redacted] ที่ท่า D-04 เวลา 08:00')
  })
})
