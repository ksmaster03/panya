// Panya-Setup.exe: แตก payload กับตัวช่วยติดตั้ง (windows/wizard.ps1) ลงโฟลเดอร์ชั่วคราว แล้วเปิดหน้าต่างติดตั้ง
// ติดตั้งให้ผู้ใช้คนนี้คนเดียว ไม่ต้องใช้สิทธิ์ผู้ดูแลเครื่อง · ตัวเลือกสำหรับติดตั้งอัตโนมัติ:
//   --silent [--dir=<โฟลเดอร์โปรแกรม>] [--data=<โฟลเดอร์ความจำ>] [--port=6800] [--no-desktop] [--no-autostart] [--no-launch]
// @ts-ignore: build.ts สร้างไฟล์นี้ก่อนคอมไพล์ แล้วฝังไว้ใน exe
import payload from '../dist/windows/payload.tar.gz' with { type: 'file' }
// @ts-ignore
import wizard from './wizard.ps1' with { type: 'text' }
// @ts-ignore
import license from '../LICENSE.md' with { type: 'text' }
// @ts-ignore
import icon from './panya.ico' with { type: 'file' }
// @ts-ignore
import logo from './panya.png' with { type: 'file' }
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

declare const PANYA_VERSION: string
const args = process.argv.slice(2)
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const tmp = mkdtempSync(join(tmpdir(), 'panya-setup-'))
const log = join(tmpdir(), 'panya-setup.log')

let code = 1
try {
  const files = { payload: join(tmp, 'payload.tar.gz'), wizard: join(tmp, 'wizard.ps1'), license: join(tmp, 'LICENSE.md'), icon: join(tmp, 'panya.ico'), logo: join(tmp, 'panya.png') }
  await Bun.write(files.payload, Bun.file(payload))
  await Bun.write(files.icon, Bun.file(icon))
  await Bun.write(files.logo, Bun.file(logo))
  // Windows PowerShell 5.1 อ่านไฟล์ที่ไม่มี BOM เป็น ANSI: ข้อความไทยจะเพี้ยน
  await Bun.write(files.wizard, '﻿' + String(wizard).replace(/^﻿/, ''))
  await Bun.write(files.license, String(license))
  const ps = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', files.wizard, '-Payload', files.payload, '-Version', PANYA_VERSION, '-License', files.license, '-Icon', files.icon, '-Logo', files.logo]
  if (args.includes('--silent')) ps.push('-Silent')
  for (const [flag, name] of [['dir', 'Dir'], ['data', 'Data'], ['port', 'Port']] as const) if (opt(flag)) ps.push(`-${name}`, opt(flag)!)
  for (const [flag, name] of [['no-desktop', 'NoDesktop'], ['no-autostart', 'NoAutostart'], ['no-launch', 'NoLaunch']] as const) if (args.includes(`--${flag}`)) ps.push(`-${name}`)
  // ห้ามใช้ windowsHide: Windows จะซ่อนหน้าต่างแรกที่โปรเซสแสดง ซึ่งคือหน้าต่างตัวช่วยติดตั้งเอง
  // ซ่อนแค่ console ของ PowerShell ด้วย -WindowStyle Hidden แทน
  const r = spawnSync('powershell.exe', ps, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  appendFileSync(log, `${new Date().toISOString()} setup ${PANYA_VERSION} ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}\n`)
  code = r.status ?? 1
} catch (e) {
  appendFileSync(log, `${new Date().toISOString()} setup failed: ${(e as Error).message}\n`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(code)
