// นำเข้าไฟล์: ดึงข้อความจากเอกสารทุกแบบ และ POST /v1/files · ส่วน API ต้องมี seekdb รันอยู่
// ไฟล์ตัวอย่างสร้างด้วย test/fixtures/make.py และ make-pdf.mjs · เสียง/ภาพทดสอบเฉพาะเมื่อเครื่องมี faster-whisper/tesseract
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { localEmbedder } from '../src/embed'
import { asrAvailable, decodeText, extractDocument, ocrAvailable, fixThai, htmlToText, kindOf, rtfToText, subtitlesToText } from '../src/extract'
import { MemoryStore } from '../src/memory'
import { createApp } from '../src/server'

const fixture = async (name: string) => new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer())

describe('ดึงข้อความจากเอกสาร', () => {
  test('Word: หัวข้อเป็น # รายการ และตาราง', async () => {
    const t = await extractDocument('a.docx', await fixture('sample.docx'))
    expect(t).toContain('# คู่มือคลังสินค้า\n## การรับของ')
    expect(t).toContain('08:00 ถึง 16:00')
    expect(t).toContain('ตรวจนับก่อนเซ็นรับทุกครั้ง')
    expect(t).toContain('A | คุณสมชาย')
  })
  test('PowerPoint: สไลด์เป็นหัวข้อ พร้อมโน้ตผู้บรรยาย', async () => {
    const t = await extractDocument('a.pptx', await fixture('sample.pptx'))
    expect(t).toContain('# Slide 1\nแผนย้ายคลัง')
    expect(t).toContain('Notes: อย่าลืมแจ้งลูกค้าล่วงหน้าสองสัปดาห์')
    expect(t).toContain('# Slide 2\nงบประมาณ\nค่าขนย้าย 85,000 บาท')
  })
  test('Excel: ชีตเป็นหัวข้อ แถวละบรรทัดพร้อมชื่อคอลัมน์', async () => {
    const t = await extractDocument('a.xlsx', await fixture('sample.xlsx'))
    expect(t).toContain('# Sheet: สต็อก')
    expect(t).toContain('รหัส: P-002 · สินค้า: เทปกาว · คงเหลือ: 35')
  })
  test('PDF: หน้าเป็นหัวข้อ และสระอำที่แตกถูกรวมกลับ', async () => {
    const t = await extractDocument('a.pdf', await fixture('sample.pdf'))
    expect(t).toContain('# Page 1\nนโยบายการลา')
    expect(t).toContain('# Page 2')
    // pdf.js ไม่ได้ส่งวรรณยุกต์ของ "น้ำ" ในไฟล์นี้มาเลย (ได้ "นำ") จึงตรวจแค่ว่าสระอำไม่แตกเป็นสองตัวและไม่มี NUL ค้าง
    expect(t).toContain('เบิกค่านำมันได้กิโลเมตรละ 5 บาท')
    expect(fixThai('น้ํ\0า')).toBe('น้ำ')
  }, 30_000) // โหลด pdf.js ครั้งแรกในคอนเทนเนอร์ใช้หลายวินาที
  test('OpenDocument และ EPUB', async () => {
    const odt = zipSync({ 'content.xml': strToU8('<office:document-content><office:body><office:text><text:h text:outline-level="1">สรุปประชุม</text:h><text:p>เลื่อน<text:span>เปิดสาขา</text:span>ไปมกราคม</text:p></office:text></office:body></office:document-content>') })
    expect(await extractDocument('a.odt', odt)).toBe('# สรุปประชุม\nเลื่อนเปิดสาขาไปมกราคม')
    const ods = zipSync({ 'content.xml': strToU8('<table:table table:name="ราคา"><table:table-row><table:table-cell><text:p>สินค้า</text:p></table:table-cell><table:table-cell><text:p>ราคา</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>ชา</text:p></table:table-cell><table:table-cell><text:p>45</text:p></table:table-cell></table:table-row></table:table>') })
    expect(await extractDocument('a.ods', ods)).toContain('# Sheet: ราคา\nสินค้า: ชา · ราคา: 45')
    const epub = zipSync({
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
      'OEBPS/book.opf': strToU8('<package><manifest><item href="c2.xhtml" id="c2"/><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'),
      'OEBPS/c1.xhtml': strToU8('<html><body><h1>บทที่ 1</h1><p>เริ่มต้น</p></body></html>'),
      'OEBPS/c2.xhtml': strToU8('<html><body><h1>บทที่ 2</h1><p>ตอนจบ</p></body></html>'),
    })
    const t = await extractDocument('a.epub', epub)
    expect(t.indexOf('# บทที่ 1')).toBeLessThan(t.indexOf('# บทที่ 2'))
  })
  test('ไฟล์ข้อความ: CSV, ซับไตเติล, HTML, RTF, JSON และ TIS-620', async () => {
    const csv = strToU8('ชื่อ,เบอร์ภายใน\n"สมชาย, ใจดี",201\nสมหญิง,202\n')
    expect(await extractDocument('a.csv', csv)).toBe('ชื่อ: สมชาย, ใจดี · เบอร์ภายใน: 201\nชื่อ: สมหญิง · เบอร์ภายใน: 202')
    expect(subtitlesToText('1\n00:01:05,000 --> 00:01:07,000\nสวัสดีครับ\n\n2\n01:00:00.000 --> 01:00:02.000\n<i>ลาก่อน</i>')).toBe('[1:05] สวัสดีครับ\n[1:00:00] ลาก่อน')
    expect(htmlToText('<html><head><title>x</title><script>bad()</script></head><body><h2>เมนู</h2><ul><li>ชา</li><li>กาแฟ</li></ul><table><tr><td>ชา</td><td>45</td></tr></table></body></html>'))
      .toBe('## เมนู\n- ชา\n- กาแฟ\nชา | 45')
    expect(rtfToText('{\\rtf1\\ansi\\ansicpg874{\\fonttbl{\\f0 Tahoma;}}\\f0 \\\'a1\\\'d2\\\'c3\\par \\u3588?\\u3619?\\u3633?\\u3610?}')).toBe('การ\nครับ')
    expect(await extractDocument('a.json', strToU8('{"ร้าน":"บางนา"}'))).toBe('{\n "ร้าน": "บางนา"\n}')
    // ไฟล์ไทยรุ่นเก่าที่ไม่ใช่ UTF-8: "สวัสดี" ในรหัส TIS-620
    expect(decodeText(new Uint8Array([0xca, 0xc7, 0xd1, 0xca, 0xb4, 0xd5]))).toBe('สวัสดี')
  })
  test('ชนิดไฟล์: เสียง/วิดีโอ/ภาพ/เอกสาร และปฏิเสธไฟล์ Office รุ่นเก่ากับไฟล์ไบนารี', async () => {
    expect(kindOf('ประชุม.MP4')).toBe('media')
    expect(kindOf('voice', 'audio/ogg')).toBe('media')
    expect(kindOf('scan.jpg')).toBe('image')
    expect(kindOf('a.docx')).toBe('document')
    expect(kindOf('notes.py')).toBe('text')
    expect(kindOf('old.doc')).toEqual({ unsupported: expect.stringContaining('.docx') })
    expect(extractDocument('a.bin', new Uint8Array([0, 1, 2, 3, 0, 255]))).rejects.toThrow('binary')
  })
})

const B = 'files_brain'
const canOcr = await ocrAvailable()
const canAsr = !!process.env.PANYA_TEST_AUDIO && (await asrAvailable())
const KEY = 'files-machine-key'
let store: MemoryStore
let app: ReturnType<typeof createApp>
const upload = async (name: string, bytes: Uint8Array, fields: Record<string, string> = {}, wait = true, key = KEY) => {
  const form = new FormData()
  form.set('file', new File([bytes], name))
  form.set('brain', B)
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return app.request(`/v1/files${wait ? '?wait=1' : ''}`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form })
}

describe('POST /v1/files', () => {
  beforeAll(async () => {
    store = await MemoryStore.open(localEmbedder, { database: 'panya_test', collection: 'memories_files_test' })
    await store.clear(B)
    app = createApp(store, [KEY, 'other-key@another_brain'], { publicDashboard: 'off' })
  }, 120_000)
  afterAll(async () => {
    await store.clear(B)
    await store.close()
  })

  test('Word: ตัดเป็นท่อนพร้อมหัวข้อ ค้นเจอ และ source = ชื่อไฟล์', async () => {
    const r = await upload('คู่มือ.docx', await fixture('sample.docx'))
    expect(r.status).toBe(201)
    const { job } = (await r.json()) as any
    expect(job).toMatchObject({ status: 'done', type: 'document', source: 'คู่มือ.docx' })
    expect(job.result.chunks).toBeGreaterThan(0)
    const hit = (await store.search(B, 'ใครดูแลโซน A')).hits[0]!
    expect(hit.source).toBe('คู่มือ.docx')
    expect(hit.text).toContain('คุณสมชาย')
  }, 30_000)
  test('อัปไฟล์ชื่อเดิมซ้ำ = แทนที่ชุดเก่า · ตั้ง source และหมวดเองได้', async () => {
    await upload('stock.xlsx', await fixture('sample.xlsx'))
    const first = (await store.exportAll(B)).filter((m) => m.source === 'stock.xlsx').length
    await upload('stock.xlsx', await fixture('sample.xlsx'), { panya: 'suta' })
    const again = (await store.exportAll(B)).filter((m) => m.source === 'stock.xlsx')
    expect(again).toHaveLength(first)
    expect(again.every((m) => m.panya === 'suta')).toBe(true)
    await upload('x.pdf', await fixture('sample.pdf'), { source: 'นโยบาย HR' })
    expect((await store.search(B, 'ลาพักร้อนได้กี่วัน')).hits[0]!.source).toBe('นโยบาย HR')
  })
  test('ไม่รอ: ได้ 202 แล้วดูสถานะงานได้ · key ของ brain อื่นดูงานไม่ได้', async () => {
    const r = await upload('slides.pptx', await fixture('sample.pptx'), {}, false)
    expect(r.status).toBe(202)
    const id = ((await r.json()) as any).job.id
    let job: any
    for (let i = 0; i < 100; i++) {
      job = ((await (await app.request(`/v1/files/jobs/${id}`, { headers: { authorization: `Bearer ${KEY}` } })).json()) as any).job
      if (job.status === 'done' || job.status === 'error') break
      await Bun.sleep(100)
    }
    expect(job.status).toBe('done')
    expect((await app.request(`/v1/files/jobs/${id}`, { headers: { authorization: 'Bearer other-key' } })).status).toBe(404)
  })
  test('ปฏิเสธ: ไม่มีไฟล์, Office รุ่นเก่า, ไฟล์ไบนารี, หมวดผิด, brain ที่ไม่มีสิทธิ์, ไฟล์ที่มีความลับ', async () => {
    const empty = new FormData(); empty.set('brain', B)
    expect((await app.request('/v1/files', { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: empty })).status).toBe(400)
    expect((await upload('old.doc', strToU8('x'))).status).toBe(415)
    const bin = await upload('blob.dat', new Uint8Array([0, 1, 2, 0, 9]))
    expect(bin.status).toBe(400)
    expect(((await bin.json()) as any).error).toContain('binary')
    expect((await upload('a.txt', strToU8('สวัสดี'), { panya: 'x' })).status).toBe(400)
    expect((await upload('a.txt', strToU8('สวัสดี'), {}, true, 'other-key')).status).toBe(403)
    const before = (await store.exportAll(B)).length
    expect((await upload('keys.txt', strToU8('# คีย์ระบบ\nAKIAABCDEFGHIJKLMNOP'))).status).toBe(400)
    expect((await store.exportAll(B)).length).toBe(before)
  })
  // ภาพ: ทดสอบเมื่อเครื่องมี tesseract (อิมเมจ Docker มีให้) · ตัวเลขและภาษาอังกฤษต้องตรง ภาษาไทยอาจหล่นวรรณยุกต์บางตัว
  test.if(canOcr)('ภาพ: อ่านตัวอักษรด้วย OCR แล้วค้นเจอ', async () => {
    const r = await upload('ใบแจ้งหนี้.png', await fixture('invoice-th.png'))
    expect(r.status).toBe(201)
    const hit = (await store.search(B, 'INV-2026-0042 ครบกำหนดชำระ')).hits[0]!
    expect(hit.source).toBe('ใบแจ้งหนี้.png')
    expect(hit.text).toContain('12,500')
  })
  // เสียง: ตั้ง PANYA_TEST_AUDIO เป็นไฟล์เสียงพูดไทยสั้น ๆ (ไม่เก็บไฟล์เสียงใน repo) และเครื่องต้องมี faster-whisper
  test.if(canAsr)('เสียง: ถอดคำพูดเป็นบรรทัดมีเวลา', async () => {
    const r = await upload('เสียง.mp3', new Uint8Array(await Bun.file(process.env.PANYA_TEST_AUDIO!).arrayBuffer()))
    expect(r.status).toBe(201)
    const mine = (await store.exportAll(B)).filter((m) => m.source === 'เสียง.mp3')
    expect(mine.length).toBeGreaterThan(0)
    expect(mine[0]!.text).toMatch(/^เสียง\.mp3\n\[0:\d\d\] /)
  }, 300_000)
  test('ประเภทไฟล์ที่เครื่องนี้รับได้', async () => {
    const t = (await (await app.request('/v1/files/types', { headers: { authorization: `Bearer ${KEY}` } })).json()) as any
    expect(t.document).toContain('pdf')
    expect(typeof t.media.enabled).toBe('boolean')
    expect(typeof t.image.enabled).toBe('boolean')
  })
})
