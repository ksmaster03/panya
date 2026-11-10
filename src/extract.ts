// ดึงข้อความจากไฟล์เพื่อเก็บเป็นความจำ ไม่เขียนหรือสรุปข้อความเอง: ได้ข้อความตามที่อยู่ในไฟล์ (หรือที่พูดในเสียง/อยู่ในภาพ)
// ผลเป็นข้อความแบบ markdown คร่าว ๆ: หัวข้อขึ้นต้นด้วย # เพื่อให้ chunkDoc แนบเส้นทางหัวข้อ (หน้า สไลด์ ชีต) ให้ทุกท่อน
//   เอกสาร: pdf docx pptx xlsx odt odp ods epub rtf html และไฟล์ข้อความทุกแบบ (txt md csv json srt โค้ด ...) ทำใน JS ล้วน
//   เสียง/วิดีโอ: ถอดคำด้วย faster-whisper (Python, scripts/transcribe.py) ต้องติดตั้งในเครื่อง
//   ภาพ: อ่านตัวอักษรด้วย tesseract (OCR) ต้องติดตั้งในเครื่อง
import { strFromU8, unzipSync, type Unzipped } from 'fflate'
import { config } from './config'

export type FileKind = 'text' | 'document' | 'media' | 'image'

const DOCUMENT = new Set(['pdf', 'docx', 'docm', 'dotx', 'pptx', 'ppsx', 'pptm', 'xlsx', 'xlsm', 'odt', 'odp', 'ods', 'epub', 'rtf', 'html', 'htm', 'xhtml'])
const MEDIA = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'amr', 'aiff', 'aif', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'mpeg', 'mpg', 'mts', 'ts'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif'])
// ไฟล์ Office รุ่นเก่า (ไบนารี) อ่านไม่ได้: บอกให้บันทึกเป็นแบบใหม่
const LEGACY: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' }

export const extOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? '')

/** ชนิดของไฟล์จากนามสกุลและ mime · ไฟล์นามสกุลอื่นที่อ่านเป็นข้อความได้ถือเป็น text (ตรวจจากเนื้อไฟล์ทีหลัง) */
export function kindOf(name: string, mime = ''): FileKind | { unsupported: string } {
  const ext = extOf(name)
  if (LEGACY[ext]) return { unsupported: `.${ext} (old binary Office format) is not supported: save it as .${LEGACY[ext]} and upload again` }
  if (DOCUMENT.has(ext) || mime === 'application/pdf') return 'document'
  if (MEDIA.has(ext) || /^(audio|video)\//.test(mime)) return 'media'
  if (IMAGE.has(ext) || /^image\/(?!svg)/.test(mime)) return 'image'
  return 'text'
}

// ── ข้อความ ─────────────────────────────────────────────────────────

/** ถอดรหัสไบต์เป็นข้อความ: UTF-8/UTF-16 (มี BOM) ก่อน แล้ว TIS-620 (windows-874) สำหรับไฟล์ไทยรุ่นเก่า · ไม่ใช่ข้อความ = null */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    const s = new TextDecoder('windows-874').decode(bytes)
    // อักขระควบคุมเยอะ = ไฟล์ไบนารี ไม่ใช่ข้อความภาษาไทย
    const ctrl = (s.slice(0, 8192).match(/[\x00-\x08\x0e-\x1f]/g) ?? []).length
    return ctrl > 8 ? null : s
  }
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e.toLowerCase()] ?? m))

const tidy = (lines: string[]) =>
  lines.map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n').trim()

/** HTML เป็นข้อความ: h1-h6 เป็นหัวข้อ markdown, ตารางคั่นช่องด้วย | */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|hr)\b[^>]*>|<\/(p|div|li|tr|table|section|article|blockquote|pre|dd|dt|caption|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return tidy(decodeEntities(s).split('\n').map((l) => l.replace(/(\s*\|\s*)+$/, '')).filter((l) => l.trim()))
}

/** แยกแถว CSV ตาม RFC 4180 (มีเครื่องหมายคำพูดครอบ ขึ้นบรรทัดใหม่ในช่องได้) */
export function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch
    } else if (ch === '"' && !cell) q = true
    else if (ch === sep) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** ตารางเป็นบรรทัด "หัวคอลัมน์: ค่า · หัวคอลัมน์: ค่า" แถวละบรรทัด: ท่อนที่ถูกตัดยังรู้ว่าค่าไหนเป็นของคอลัมน์ไหน */
export function tableToLines(rows: string[][]): string[] {
  const clean = rows.map((r) => r.map((c) => c.replace(/\s+/g, ' ').trim())).filter((r) => r.some(Boolean))
  if (!clean.length) return []
  const [head, ...body] = clean
  if (!body.length) return [head!.filter(Boolean).join(' · ')]
  return body.map((r) => r.map((v, i) => (v ? (head![i] ? `${head![i]}: ${v}` : v) : '')).filter(Boolean).join(' · '))
}

const ts = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60
  return `${hh ? hh + ':' : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`
}

/** ซับไตเติล SRT/VTT: ตัดเลขลำดับและบรรทัดเวลา เหลือ "[นาที:วินาที] ข้อความ" */
export function subtitlesToText(text: string): string {
  const out: string[] = []
  let at = ''
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    const m = line.match(/^(\d+:)?(\d{1,2}):(\d{2})[.,]\d+\s*-->/)
    if (m) { at = `[${ts((m[1] ? parseInt(m[1]) * 3600 : 0) + parseInt(m[2]!) * 60 + parseInt(m[3]!))}] `; continue }
    if (!line || /^\d+$/.test(line) || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(line)) continue
    out.push(at + line.replace(/<[^>]+>/g, ''))
    at = ''
  }
  return out.join('\n')
}

function textFile(ext: string, text: string): string {
  if (ext === 'csv' || ext === 'tsv') {
    const first = text.split('\n', 1)[0] ?? ''
    const sep = ext === 'tsv' || first.includes('\t') ? '\t' : first.split(';').length > first.split(',').length ? ';' : ','
    return tableToLines(parseCsv(text, sep)).join('\n')
  }
  if (ext === 'srt' || ext === 'vtt') return subtitlesToText(text)
  if (ext === 'json') {
    try { return JSON.stringify(JSON.parse(text), null, 1) } catch { return text }
  }
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return htmlToText(text)
  return text
}

// ── เอกสารในไฟล์ zip (Office Open XML, OpenDocument, EPUB) ──────────

const xmlText = (xml: string) => decodeEntities(xml.replace(/<[^>]+>/g, ''))
// ค่า attribute ของแท็ก XML ไม่ขึ้นกับลำดับ (แต่ละโปรแกรมเรียง attribute ต่างกัน)
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
const read = (zip: Unzipped, path: string) => (zip[path] ? strFromU8(zip[path]!) : '')
const numbered = (zip: Unzipped, re: RegExp) =>
  Object.keys(zip).filter((p) => re.test(p)).sort((a, b) => Number(a.match(re)![1]) - Number(b.match(re)![1]))

function docx(zip: Unzipped): string {
  const body = read(zip, 'word/document.xml')
  if (!body) throw new Error('not a Word document (word/document.xml missing)')
  const runs = (xml: string) =>
    decodeEntities((xml.match(/<w:t\b[^>]*>[^<]*<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>/g) ?? [])
      .map((t) => (t.startsWith('<w:tab') ? '\t' : t.startsWith('<w:br') ? '\n' : t.replace(/<[^>]+>/g, ''))).join(''))
  // ตาราง: แถวละบรรทัด ช่องคั่นด้วย |
  const withTables = body.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (tr) =>
    `<w:p><w:r><w:t>${(tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => runs(tc).replace(/\s+/g, ' ').trim().replace(/[<&]/g, ' ')).join(' | ')}</w:t></w:r></w:p>`)
  const out: string[] = []
  for (const p of withTables.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
    const text = runs(p).trim()
    if (!text) continue
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? ''
    const level = style.match(/heading\s*(\d)/i)?.[1] ?? (/^title$/i.test(style) ? '1' : p.match(/<w:outlineLvl w:val="(\d)"/)?.[1] && String(Number(p.match(/<w:outlineLvl w:val="(\d)"/)![1]) + 1))
    out.push(level ? `${'#'.repeat(Math.min(6, Number(level)))} ${text.replace(/\n/g, ' ')}` : p.includes('<w:numPr>') ? `- ${text}` : text)
  }
  return out.join('\n')
}

function pptx(zip: Unzipped): string {
  const slides = numbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/)
  if (!slides.length) throw new Error('not a PowerPoint file (no slides)')
  const paras = (xml: string) => (xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []).map((p) => xmlText((p.match(/<a:t>[^<]*<\/a:t>/g) ?? []).join('')).trim()).filter(Boolean)
  return slides.map((path, i) => {
    const rels = read(zip, path.replace('slides/', 'slides/_rels/') + '.rels')
    const notesPath = rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1]
    // โน้ตผู้บรรยาย: ตัดเลขหน้าที่เป็นตัวเลขล้วนออก
    const notes = notesPath ? paras(read(zip, 'ppt/notesSlides/' + notesPath)).filter((t) => !/^\d+$/.test(t)) : []
    return [`# Slide ${i + 1}`, ...paras(read(zip, path)), ...(notes.length ? ['Notes: ' + notes.join(' ')] : [])].join('\n')
  }).join('\n\n')
}

function xlsx(zip: Unzipped): string {
  const wb = read(zip, 'xl/workbook.xml')
  if (!wb) throw new Error('not an Excel workbook (xl/workbook.xml missing)')
  const shared = (read(zip, 'xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) ?? [])
    .map((si) => xmlText((si.match(/<t\b[^>]*>[^<]*<\/t>/g) ?? []).join('')))
  const rels = Object.fromEntries((read(zip, 'xl/_rels/workbook.xml.rels').match(/<Relationship\b[^>]*>/g) ?? []).map((t) => [attr(t, 'Id'), attr(t, 'Target')]))
  const col = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  const out: string[] = []
  for (const sheet of wb.match(/<sheet\b[^>]*>/g) ?? []) {
    const target = String(rels[attr(sheet, 'r:id') ?? ''] ?? '').replace(/^\/?(xl\/)?/, '')
    const xml = read(zip, 'xl/' + target)
    const rows: string[][] = []
    for (const r of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const row: string[] = []
      for (const c of r.match(/<c\b[^>]*\/>|<c\b[\s\S]*?<\/c>/g) ?? []) {
        const ref = c.match(/\br="([A-Z]+)\d+"/)?.[1] ?? ''
        const t = c.match(/\bt="(\w+)"/)?.[1]
        const v = c.match(/<v>([^<]*)<\/v>/)?.[1] ?? ''
        const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? xmlText(c.match(/<is>[\s\S]*?<\/is>/)?.[0] ?? '') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : decodeEntities(v)
        row[ref ? col(ref) : row.length] = val
      }
      rows.push(Array.from(row, (x) => x ?? ''))
    }
    const lines = tableToLines(rows)
    if (lines.length) out.push(`# Sheet: ${decodeEntities(attr(sheet, 'name') ?? '')}`, ...lines, '')
  }
  return out.join('\n')
}

function odf(zip: Unzipped, ext: string): string {
  const xml = read(zip, 'content.xml')
  if (!xml) throw new Error('not an OpenDocument file (content.xml missing)')
  const body = xml.replace(/<text:(s|tab|line-break)\b[^>]*\/>/g, ' ')
  if (ext === 'ods') {
    const out: string[] = []
    for (const t of body.match(/<table:table\b[\s\S]*?<\/table:table>/g) ?? []) {
      const rows = (t.match(/<table:table-row\b[\s\S]*?<\/table:table-row>/g) ?? []).map((r) =>
        (r.match(/<table:table-cell\b[^>]*\/>|<table:table-cell\b[\s\S]*?<\/table:table-cell>/g) ?? []).map((c) => xmlText(c)))
      const lines = tableToLines(rows)
      if (lines.length) out.push(`# Sheet: ${decodeEntities(t.match(/table:name="([^"]*)"/)?.[1] ?? '')}`, ...lines, '')
    }
    return out.join('\n')
  }
  let slide = 0
  const out: string[] = []
  for (const m of body.matchAll(/<draw:page\b|<text:h\b[^>]*?(?:text:outline-level="(\d)")?[^>]*>([\s\S]*?)<\/text:h>|<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)) {
    if (m[0].startsWith('<draw:page')) { out.push(`# Slide ${++slide}`); continue }
    const text = xmlText(m[2] ?? m[3] ?? '').trim()
    if (!text) continue
    out.push(m[2] !== undefined ? `${'#'.repeat(Math.min(6, Number(m[1] ?? 1) + (slide ? 1 : 0)))} ${text}` : text)
  }
  return out.join('\n')
}

function epub(zip: Unzipped): string {
  const opfPath = read(zip, 'META-INF/container.xml').match(/full-path="([^"]+)"/)?.[1]
  const opf = opfPath ? read(zip, opfPath) : ''
  const dir = opfPath?.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const manifest = Object.fromEntries((opf.match(/<item\b[^>]*>/g) ?? []).map((t) => [attr(t, 'id'), attr(t, 'href')]))
  let files = [...opf.matchAll(/<itemref\b[^>]*?idref="([^"]+)"/g)].map((m) => manifest[m[1]!]).filter(Boolean).map((h) => dir + decodeURIComponent(String(h)))
  if (!files.length) files = Object.keys(zip).filter((p) => /\.x?html?$/i.test(p)).sort()
  return files.map((f) => htmlToText(read(zip, f))).filter(Boolean).join('\n\n')
}

/** RTF แบบพื้นฐาน: ข้อความ ย่อหน้า และอักษรไทย (\uN และ \'hh ตาม \ansicpg) · ไม่เก็บรูปแบบ */
export function rtfToText(rtf: string): string {
  const cp = rtf.match(/\\ansicpg(\d+)/)?.[1] ?? '1252'
  const dec = (() => { try { return new TextDecoder(('windows-' + cp) as 'utf-8') } catch { return new TextDecoder('windows-1252') } })()
  // กลุ่มที่ไม่ใช่เนื้อหา: ตารางฟอนต์ สี สไตล์ ข้อมูลเอกสาร รูป
  let s = rtf
  for (const g of ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', '\\*']) {
    for (let i = s.indexOf('{\\' + g); i >= 0; i = s.indexOf('{\\' + g)) {
      let depth = 0, j = i
      for (; j < s.length; j++) { if (s[j] === '\\') { j++; continue } if (s[j] === '{') depth++; else if (s[j] === '}' && --depth === 0) break }
      s = s.slice(0, i) + s.slice(j + 1)
    }
  }
  const out: string[] = []
  let bytes: number[] = []
  const flush = () => { if (bytes.length) { out.push(dec.decode(new Uint8Array(bytes))); bytes = [] } }
  const re = /\\'([0-9a-f]{2})|\\u(-?\d+)\??|\\(par|line|tab|cell|row)\b ?|\\[a-z]+-?\d* ?|\\([\\{}])|([{}])|([^\\{}]+)/gi
  for (const m of s.matchAll(re)) {
    if (m[1]) { bytes.push(parseInt(m[1], 16)); continue }
    flush()
    if (m[2]) out.push(String.fromCharCode(Number(m[2]) < 0 ? Number(m[2]) + 65536 : Number(m[2])))
    else if (m[3]) out.push(m[3] === 'tab' ? '\t' : m[3] === 'cell' ? ' | ' : '\n')
    else if (m[4]) out.push(m[4])
    else if (m[6]) out.push(m[6].replace(/[\r\n]/g, ''))
  }
  flush()
  return tidy(out.join('').split('\n'))
}

/** PDF ไทยหลายไฟล์เก็บสระอำเป็นนิคหิต+สระอา และมีช่องว่างแทรกหน้าสระบน/วรรณยุกต์: รวมกลับเป็นตัวอักษรเดียว */
export const fixThai = (s: string) =>
  s.replace(/ํ[\s\0]*า/g, 'ำ').replace(/\0/g, '').replace(/(?<=[ก-ฮ]) +(?=[ัิ-ฺ็-๎])/g, '').normalize('NFC')

async function pdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const doc = await getDocumentProxy(new Uint8Array(bytes))
  const { text } = await extractText(doc, { mergePages: false })
  const pages = (text as string[]).map((t, i) => (t.trim() ? `# Page ${i + 1}\n${fixThai(t.trim())}` : '')).filter(Boolean)
  if (!pages.length) throw new Error('this PDF has no text layer (a scan?): export the pages as images and upload them for OCR')
  return pages.join('\n\n')
}

/** ข้อความจากเอกสารหรือไฟล์ข้อความ (ไม่รวมเสียงและภาพ) */
export async function extractDocument(name: string, bytes: Uint8Array): Promise<string> {
  const ext = extOf(name)
  if (ext === 'pdf' || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) return pdf(bytes)
  if (['docx', 'docm', 'dotx', 'pptx', 'ppsx', 'pptm', 'xlsx', 'xlsm', 'odt', 'odp', 'ods', 'epub'].includes(ext)) {
    let zip: Unzipped
    // ข้ามรูปและสื่อในไฟล์ (ไม่ใช่ข้อความ) · zip bomb: เนื้อที่แตกออกมารวมเกิน 300 MB = ปฏิเสธ
    let total = 0
    const tooBig = new Error(`.${ext} file expands to more than 300 MB of text`)
    try {
      zip = unzipSync(bytes, {
        filter: (f) => {
          if (/\.(png|jpe?g|gif|bmp|emf|wmf|tiff?|svg|mp[34]|wav|bin|ttf|otf|woff2?)$/i.test(f.name)) return false
          if ((total += f.originalSize) > 300 * 1024 * 1024) throw tooBig
          return true
        },
      })
    } catch (e) { throw e === tooBig ? e : new Error(`.${ext} file is damaged or not a zip-based document`) }
    if (ext.startsWith('doc')) return docx(zip)
    if (ext.startsWith('pp')) return pptx(zip)
    if (ext.startsWith('xl')) return xlsx(zip)
    if (ext === 'epub') return epub(zip)
    return odf(zip, ext)
  }
  const text = decodeText(bytes)
  if (text === null) throw new Error(`.${ext || 'unknown'} is not a supported file type (binary data)`)
  return ext === 'rtf' ? rtfToText(text) : textFile(ext, text)
}

// ── เสียง วิดีโอ ภาพ: โปรแกรมภายนอก ─────────────────────────────────

const probe = new Map<string, Promise<boolean>>()
const canRun = (cmd: string[]) => {
  const key = cmd.join(' ')
  if (!probe.has(key)) probe.set(key, (async () => {
    try { const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }); return (await p.exited) === 0 } catch { return false }
  })())
  return probe.get(key)!
}

// Windows: python ที่ติดตั้งจาก Microsoft Store/winget อยู่ใน WindowsApps เป็น alias ที่ Bun หาใน PATH ไม่เจอ
const python = () => {
  const c = config.files.python
  if (process.platform !== 'win32' || Bun.which(c)) return c
  // alias เป็นไฟล์พิเศษ (reparse point) ที่ stat ไม่ผ่าน จึงเรียกตรง ๆ ถ้าไม่มีจริง canRun จะได้ false
  return `${process.env.LOCALAPPDATA}/Microsoft/WindowsApps/${c}.exe`
}

/** ถอดเสียงได้ไหม: on = ต้องได้ · off = ปิด · auto = ใช้เมื่อเครื่องนี้มี faster-whisper */
export const asrAvailable = () =>
  config.files.asr === 'off' ? Promise.resolve(false) : canRun([python(), '-c', 'import faster_whisper'])
export const ocrAvailable = () =>
  config.files.ocr === 'off' ? Promise.resolve(false) : canRun([config.files.tesseract, '--version'])

const SCRIPT = new URL('../scripts/transcribe.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** ถอดคำพูดจากไฟล์เสียงหรือวิดีโอ เป็นบรรทัด "[นาที:วินาที] ข้อความ" · onProgress(0..1) */
export async function transcribe(path: string, onProgress?: (p: number) => void): Promise<string> {
  const args = [python(), '-X', 'utf8', SCRIPT, path, '--model', config.files.asrModel]
  if (config.files.asrLang) args.push('--lang', config.files.asrLang)
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  const lines: string[] = []
  let duration = 0
  let rest = ''
  const dec = new TextDecoder()
  for await (const part of p.stdout) {
    rest += dec.decode(part, { stream: true })
    const all = rest.split('\n')
    rest = all.pop()!
    for (const raw of all) {
      let m: any
      try { m = JSON.parse(raw) } catch { continue }
      if (m.duration) duration = m.duration
      if (typeof m.text === 'string' && m.text.trim()) lines.push(`[${ts(m.start)}] ${m.text.trim()}`)
      if (duration && typeof m.end === 'number') onProgress?.(Math.min(1, m.end / duration))
    }
  }
  const code = await p.exited
  if (code !== 0) {
    const err = (await new Response(p.stderr).text()).trim().split('\n').filter((l) => !/warn/i.test(l)).slice(-2).join(' ')
    throw new Error('transcription failed: ' + (err || `exit ${code}`).slice(0, 300))
  }
  return lines.join('\n')
}

/** อ่านตัวอักษรในภาพด้วย tesseract */
export async function ocr(path: string): Promise<string> {
  const p = Bun.spawn([config.files.tesseract, path, 'stdout', '-l', config.files.ocrLang], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error('OCR failed: ' + err.trim().slice(-300))
  // tesseract ใส่ช่องว่างระหว่างอักษรไทยบางตัว: ตัดช่องว่างเดี่ยวที่คั่นอักษรไทยกับวรรณยุกต์/สระ
  return tidy(fixThai(out).replace(/(?<=[฀-๿]) (?=[ัิ-ฺ็-๎])/g, '').split('\n'))
}
