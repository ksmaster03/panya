import { describe, expect, test } from 'bun:test'
import { coverage, extractCodes, tokenize } from '../src/tokenize'

describe('tokenize', () => {
  test('เก็บรหัสเป็นโทเคนเดียว', () => {
    const t = tokenize('ท่า D-04 รถทะเบียน 70-1234 งาน BK-2026-0012')
    expect(t).toContain('d04')
    expect(t).toContain('701234')
    expect(t).toContain('bk20260012')
  })

  test('เอกสารกับคำค้นได้รหัสเดียวกันแม้พิมพ์ต่างตัวพิมพ์', () => {
    expect(extractCodes('ท่า d-04')).toEqual(extractCodes('ท่า D-04'))
  })

  test('ตัดคำไทยและทิ้งคำเชื่อม', () => {
    const t = tokenize('ผู้ขนส่งมาสายที่ท่า')
    expect(t).toContain('สาย')
    expect(t).toContain('ท่า')
    expect(t).not.toContain('ที่')
  })

  test('คำค้นที่มีแต่คำเชื่อมได้โทเคนว่าง', () => {
    expect(tokenize('ใครอยู่ที่ไหน')).toEqual([])
  })

  test('coverage นับสัดส่วนคำของคำค้นที่เจอ', () => {
    expect(coverage(['a', 'b'], ['a', 'x'])).toBe(0.5)
    expect(coverage([], ['a'])).toBe(0)
    expect(coverage(['a', 'a'], ['a'])).toBe(1)
  })
})
