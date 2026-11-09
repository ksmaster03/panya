// ตัดเอกสารยาว (markdown หรือข้อความธรรมดา) เป็นท่อนสำหรับเก็บเป็นความจำ
// ต่างจาก chunk() ใน import-md.ts ที่ตัดตามย่อหน้าล้วน ๆ:
//   - ไม่ตัดข้ามหัวข้อ: ท่อนหนึ่งอยู่ใต้หัวข้อเดียวเสมอ
//   - หน่วยย่อยคือบรรทัดหรือประโยค จึงไม่ตัดกลางประโยค (ยกเว้นประโยคเดียวยาวเกินขนาดท่อน)
//   - headings: แนบเส้นทางหัวข้อ เช่น "สาขาบางนา › เวลาทำการ" นำหน้าทุกท่อน
//     ข้อความที่ซ้ำกันในหลายหัวข้อ (เวลาเปิดของแต่ละสาขา) จึงยังรู้ว่าเป็นของใคร
//   - overlap: ยกประโยคท้ายของท่อนก่อนมาต้นท่อนถัดไป คำตอบที่คร่อมรอยตัดจึงยังอยู่ครบในท่อนใดท่อนหนึ่ง
// ค่าเริ่มต้นเลือกจากผล bun eval/chunks.ts

export interface ChunkOptions {
  /** ความยาวสูงสุดของท่อน (ตัวอักษร) รวมหัวข้อที่แนบ */
  max?: number
  /** ความยาวสูงสุดของส่วนที่ยกมาจากท่อนก่อน · 0 = ไม่ซ้อน */
  overlap?: number
  /** แนบเส้นทางหัวข้อนำหน้าทุกท่อน */
  headings?: boolean
}

export interface DocChunk {
  /** ข้อความที่เก็บเป็นความจำ (มีหัวข้อนำหน้าถ้าเปิด headings) */
  text: string
  /** เส้นทางหัวข้อ คั่นด้วย " › " · '' = ก่อนหัวข้อแรก */
  heading: string
}

export const CHUNK_DEFAULTS: Required<ChunkOptions> = { max: 300, overlap: 120, headings: true }

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** แบ่งบรรทัดยาวเป็นประโยค: จุด/คำถาม/อัศเจรีย์ตามด้วยช่องว่าง หรือช่องว่างระหว่างอักษรไทย (ภาษาไทยเว้นวรรคเมื่อจบประโยค) */
function sentences(line: string, max: number): string[] {
  if (line.length <= max) return [line]
  const parts = line.split(/(?<=[.!?。])\s+|(?<=[฀-๿])\s+(?=[฀-๿])/).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    if (p.length <= max) out.push(p)
    else for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max))
  }
  return out
}

export function chunkDoc(doc: string, opts: ChunkOptions = {}): DocChunk[] {
  const { max, overlap, headings } = { ...CHUNK_DEFAULTS, ...opts }
  const lines = doc.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const out: DocChunk[] = []
  const stack: string[] = []
  let units: string[] = []

  const flushSection = () => {
    if (!units.length) return
    const heading = stack.filter(Boolean).join(' › ')
    const prefix = headings && heading ? heading + '\n' : ''
    // งบของเนื้อหาหลังหักหัวข้อ · หัวข้อยาวผิดปกติ ยังเหลือที่ให้เนื้อหาอย่างน้อยครึ่งท่อน
    const budget = Math.max(Math.floor(max / 2), max - prefix.length)
    const pieces = units.flatMap((u) => sentences(u, budget))
    let buf: string[] = []
    let len = 0
    // ท่อนที่ถูกยกมาเป็นส่วนซ้อนอย่างเดียว ไม่ต้องปิดเป็นท่อนใหม่
    let carried = 0
    const emit = () => {
      if (buf.length > carried) out.push({ text: prefix + buf.join('\n'), heading })
      // ยกประโยคท้ายที่ยาวรวมไม่เกิน overlap ไปต้นท่อนถัดไป
      const keep: string[] = []
      let k = 0
      for (let i = buf.length - 1; i >= 0 && overlap > 0; i--) {
        if (k + buf[i]!.length + 1 > overlap) break
        keep.unshift(buf[i]!)
        k += buf[i]!.length + 1
      }
      buf = keep; len = k; carried = keep.length
    }
    for (const p of pieces) {
      if (buf.length && len + p.length + 1 > budget) emit()
      // ส่วนซ้อนใหญ่จนประโยคถัดไปไม่พอที่ ทิ้งส่วนซ้อน
      if (buf.length && len + p.length + 1 > budget) { buf = []; len = 0; carried = 0 }
      buf.push(p)
      len += p.length + 1
    }
    emit()
    units = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    const h = line.match(HEADING)
    if (h) {
      flushSection()
      const level = h[1]!.length
      stack.length = level - 1
      stack[level - 1] = h[2]!
      continue
    }
    if (line) units.push(line)
  }
  flushSection()
  return out
}
