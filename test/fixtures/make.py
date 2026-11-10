# สร้างไฟล์ตัวอย่างสำหรับ test/files.test.ts: python test/fixtures/make.py (ต้องมี python-docx python-pptx openpyxl)
# PDF สร้างด้วย Chromium (Playwright): ดู make-pdf.mjs
import os
from docx import Document
from pptx import Presentation
from openpyxl import Workbook

here = os.path.dirname(os.path.abspath(__file__))

d = Document()
d.add_heading('คู่มือคลังสินค้า', 1)
d.add_heading('การรับของ', 2)
d.add_paragraph('รับของได้ทุกวันจันทร์ถึงศุกร์ เวลา 08:00 ถึง 16:00')
d.add_paragraph('ตรวจนับก่อนเซ็นรับทุกครั้ง', style='List Bullet')
t = d.add_table(rows=2, cols=2)
t.cell(0, 0).text, t.cell(0, 1).text = 'โซน', 'ผู้ดูแล'
t.cell(1, 0).text, t.cell(1, 1).text = 'A', 'คุณสมชาย'
d.save(os.path.join(here, 'sample.docx'))

p = Presentation()
s = p.slides.add_slide(p.slide_layouts[1])
s.shapes.title.text = 'แผนย้ายคลัง'
s.placeholders[1].text = 'ย้ายไปบางนาวันที่ 15 ธันวาคม'
s.notes_slide.notes_text_frame.text = 'อย่าลืมแจ้งลูกค้าล่วงหน้าสองสัปดาห์'
s2 = p.slides.add_slide(p.slide_layouts[1])
s2.shapes.title.text = 'งบประมาณ'
s2.placeholders[1].text = 'ค่าขนย้าย 85,000 บาท'
p.save(os.path.join(here, 'sample.pptx'))

wb = Workbook()
ws = wb.active
ws.title = 'สต็อก'
ws.append(['รหัส', 'สินค้า', 'คงเหลือ'])
ws.append(['P-001', 'กล่องกระดาษ', 120])
ws.append(['P-002', 'เทปกาว', 35])
wb.save(os.path.join(here, 'sample.xlsx'))
print('ok')
