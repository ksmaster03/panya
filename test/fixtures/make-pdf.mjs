// สร้าง PDF ภาษาไทย 2 หน้าเป็นไฟล์ตัวอย่างของ panya test/fixtures/sample.pdf
import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<html><body style="font-family:Tahoma">
<h1>นโยบายการลา</h1><p>พนักงานลาพักร้อนได้ปีละ 10 วัน</p>
<div style="page-break-before:always"></div>
<h1>การเบิกค่าเดินทาง</h1><p>เบิกค่าน้ำมันได้กิโลเมตรละ 5 บาท</p></body></html>`)
await p.pdf({ path: 'D:/Project/panya/test/fixtures/sample.pdf', format: 'A5' })
await b.close()
console.log('ok')
