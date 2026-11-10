// Panya-Setup.exe: ติดตั้งให้ผู้ใช้คนนี้คนเดียว ไม่ต้องใช้สิทธิ์ผู้ดูแลเครื่อง (ไม่มีหน้าต่าง UAC)
// แตกไฟล์ไปที่ %LOCALAPPDATA%\Programs\Panya ด้วย tar.exe ที่มากับ Windows 10/11 สร้างทางลัด และลงทะเบียนให้ถอนได้จาก Settings > Apps
// อาร์กิวเมนต์: --yes = ไม่ถาม (เปิดพร้อม Windows) · --no-autostart = ไม่เปิดพร้อม Windows · --no-launch = ติดตั้งแล้วไม่เปิด
// @ts-ignore: build.ts สร้างไฟล์นี้ก่อนคอมไพล์ แล้วฝังไว้ใน exe
import payload from '../dist/windows/payload.tar.gz' with { type: 'file' }
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

declare const PANYA_VERSION: string
const args = process.argv.slice(2)
const LOCAL = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local')
const TARGET = join(LOCAL, 'Programs', 'Panya')
const EXE = join(TARGET, 'Panya.exe')
const MENU = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const say = (th: string, en: string) => console.log(`${th}\n  ${en}`)

function run(cmd: string, a: string[]) {
  const r = spawnSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')}\n${r.stderr || r.stdout}`)
  return r.stdout
}

function shortcut(path: string, target: string, opts: { args?: string; desc?: string } = {}) {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(path)})`,
    `$s.TargetPath = ${q(target)}`,
    `$s.Arguments = ${q(opts.args ?? '')}`,
    `$s.WorkingDirectory = ${q(TARGET)}`,
    `$s.IconLocation = ${q(EXE + ',0')}`,
    `$s.Description = ${q(opts.desc ?? 'Panya')}`,
    '$s.Save()',
  ].join('; ')
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])
}

function ask(q: string): boolean {
  if (args.includes('--yes')) return true
  const a = prompt(`${q} [Y/n]`)
  return a === null || !/^n/i.test(a.trim())
}

console.log(`Panya ${PANYA_VERSION} · ติดตั้งสมองที่สองบนเครื่องนี้ / installing your second brain on this computer\n`)

// ติดตั้งทับรุ่นเดิม: ปิดเซิร์ฟเวอร์เดิมก่อน ความจำอยู่คนละโฟลเดอร์ (%LOCALAPPDATA%\Panya) จึงไม่หาย
if (existsSync(EXE)) {
  say('พบรุ่นเดิม กำลังปิดและอัปเดต…', 'Found an earlier version, stopping it and updating…')
  spawnSync(EXE, ['--stop'], { windowsHide: true })
  await Bun.sleep(1500)
  rmSync(TARGET, { recursive: true, force: true })
}

say('กำลังแตกไฟล์ (ราว 1 นาที)…', 'Unpacking files (about a minute)…')
mkdirSync(TARGET, { recursive: true })
const tmp = join(tmpdir(), `panya-setup-${Date.now()}.tar.gz`)
await Bun.write(tmp, Bun.file(payload))
try {
  run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xzf', tmp, '-C', join(TARGET, '..')])
} finally {
  rmSync(tmp, { force: true })
}
if (!existsSync(EXE)) throw new Error(`unpack failed: ${EXE} is missing`)

say('กำลังสร้างทางลัด…', 'Creating shortcuts…')
const folder = join(MENU, 'Panya')
mkdirSync(folder, { recursive: true })
shortcut(join(folder, 'Panya.lnk'), EXE, { desc: 'เปิด Panya / Open Panya' })
shortcut(join(folder, 'Stop Panya.lnk'), EXE, { args: '--stop', desc: 'ปิด Panya / Stop Panya' })
shortcut(join(folder, 'Panya settings.lnk'), 'notepad.exe', { args: join(LOCAL, 'Panya', 'panya.env'), desc: 'ตั้งค่า Panya / Panya settings' })
shortcut(join(folder, 'Uninstall Panya.lnk'), EXE, { args: '--uninstall', desc: 'ถอนการติดตั้ง Panya / Uninstall Panya' })
shortcut(join(process.env.USERPROFILE ?? '', 'Desktop', 'Panya.lnk'), EXE, { desc: 'เปิด Panya / Open Panya' })

const startup = join(MENU, 'Startup', 'Panya.lnk')
if (!args.includes('--no-autostart') && ask('เปิด Panya พร้อม Windows ทุกครั้งไหม / Start Panya when you sign in to Windows?')) {
  shortcut(startup, EXE, { args: '--background', desc: 'Panya (เบื้องหลัง / background)' })
} else rmSync(startup, { force: true })

// ลงทะเบียนใน Settings > Apps ของผู้ใช้คนนี้ (HKCU ไม่ต้องใช้สิทธิ์ผู้ดูแล)
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Panya'
const reg = (name: string, type: string, value: string) => run('reg.exe', ['add', KEY, '/v', name, '/t', type, '/d', value, '/f'])
reg('DisplayName', 'REG_SZ', 'Panya')
reg('DisplayVersion', 'REG_SZ', PANYA_VERSION)
reg('Publisher', 'REG_SZ', 'ksmaster03')
reg('DisplayIcon', 'REG_SZ', `${EXE},0`)
reg('InstallLocation', 'REG_SZ', TARGET)
reg('UninstallString', 'REG_SZ', `"${EXE}" --uninstall`)
reg('URLInfoAbout', 'REG_SZ', 'https://github.com/ksmaster03/panya')
reg('NoModify', 'REG_DWORD', '1')
reg('NoRepair', 'REG_DWORD', '1')
reg('EstimatedSize', 'REG_DWORD', String(Math.round(Bun.file(payload).size / 1024 * 2.2)))

say(`\nติดตั้งเสร็จแล้วที่ ${TARGET}`, `Installed to ${TARGET}`)
if (!args.includes('--no-launch')) {
  say('กำลังเปิด Panya ในเบราว์เซอร์ ครั้งแรกให้ตั้งชื่อผู้ใช้และรหัสผ่านของผู้ดูแล', 'Opening Panya in your browser. The first time, create the administrator account.')
  Bun.spawn([EXE], { stdio: ['ignore', 'ignore', 'ignore'] }).unref()
  await Bun.sleep(2500)
}
