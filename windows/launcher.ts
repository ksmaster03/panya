// Panya.exe: ตัวเปิดแอปบน Windows (คอมไพล์ด้วย bun build --compile --windows-hide-console)
// ไม่มีอาร์กิวเมนต์ = เปิดเซิร์ฟเวอร์ถ้ายังไม่เปิด แล้วเปิดเบราว์เซอร์ · --background = เปิดเซิร์ฟเวอร์อย่างเดียว (ตอนล็อกอิน Windows)
// --stop = ปิดเซิร์ฟเวอร์ · --uninstall [--purge] = ถอนการติดตั้ง (--purge ลบความจำทั้งหมดด้วย)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const APP = dirname(process.execPath)
const HOME = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'Panya')
const ENV_FILE = join(HOME, 'panya.env')
const PID_FILE = join(HOME, 'server.pid')
const LOG_FILE = join(HOME, 'logs', 'panya.log')
const args = process.argv.slice(2)

const DEFAULT_ENV = `# ตั้งค่าของ Panya บนเครื่องนี้ · แก้แล้วปิด/เปิด Panya ใหม่ (เมนู Start > Stop Panya แล้วเปิด Panya)
# Panya settings for this computer. Edit, then stop and start Panya again.
PANYA_PORT=6800
# 127.0.0.1 = ใช้ได้เฉพาะเครื่องนี้ · 0.0.0.0 = ให้เครื่องอื่นในวงแลนเข้าได้ด้วย
PANYA_HOST=127.0.0.1
`

function settings(): Record<string, string> {
  mkdirSync(join(HOME, 'logs'), { recursive: true })
  if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, DEFAULT_ENV)
  const out: Record<string, string> = {}
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1')
  }
  return out
}

const env = settings()
const port = Number(env.PANYA_PORT || 6800)
const base = `http://127.0.0.1:${port}`

async function up(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok && ((await r.json()) as { ok?: boolean }).ok === true
  } catch { return false }
}

function alert(text: string) {
  // กล่องข้อความของ Windows (ตัวเปิดไม่มีหน้าต่าง console)
  const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(text).replace(/\$/g, '`$')}, 'Panya') | Out-Null`
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true })
}

const open = (url: string) => spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref()

function startServer() {
  const log = openSync(LOG_FILE, 'a')
  // Panya.exe คือ bun ที่คอมไพล์แล้ว: BUN_BE_BUN=1 ให้ทำงานเป็น bun ธรรมดาเพื่อรันเซิร์ฟเวอร์ (ไม่ต้องมี bun.exe อีกตัว)
  const p = spawn(process.execPath, [join(APP, 'app', 'src', 'index.ts')], {
    cwd: join(APP, 'app'),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      PANYA_STORE: 'sqlite',
      PANYA_SETUP: 'local',
      PANYA_DATA_DIR: join(HOME, 'data'),
      ...env,
      BUN_BE_BUN: '1',
    },
  })
  writeFileSync(PID_FILE, String(p.pid))
  p.unref()
  return p
}

function stopServer() {
  if (!existsSync(PID_FILE)) return false
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  rmSync(PID_FILE, { force: true })
  if (!pid) return false
  // ปิดเฉพาะเมื่อ pid นั้นยังเป็น Panya.exe (pid อาจถูกนำไปใช้ใหม่หลังรีสตาร์ต)
  const q = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  if (!/"panya\.exe"/i.test(q.stdout ?? '')) return false
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  return true
}

async function waitUp(ms: number, gone: () => boolean) {
  const end = Date.now() + ms
  while (Date.now() < end && !gone()) {
    if (await up()) return true
    await Bun.sleep(700)
  }
  return false
}

function uninstall(purge: boolean) {
  stopServer()
  const appData = process.env.APPDATA ?? ''
  const links = [
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Panya'),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Panya.lnk'),
    join(process.env.USERPROFILE ?? '', 'Desktop', 'Panya.lnk'),
  ]
  for (const l of links) rmSync(l, { recursive: true, force: true })
  spawnSync('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Panya', '/f'], { windowsHide: true })
  if (purge) rmSync(HOME, { recursive: true, force: true })
  // โฟลเดอร์โปรแกรมลบตอนตัวเองยังทำงานไม่ได้: ให้ cmd รอให้ตัวเปิดปิดก่อนแล้วค่อยลบ
  spawn('cmd.exe', ['/d', '/c', `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${APP}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
  if (!args.includes('--quiet')) alert(purge ? 'ถอนการติดตั้ง Panya และลบความจำทั้งหมดแล้ว\nPanya and all of its memories were removed.' : `ถอนการติดตั้ง Panya แล้ว ความจำยังเก็บไว้ที่\n${HOME}\n\nPanya was removed. Your memories are kept in the folder above.`)
}

if (args.includes('--stop')) {
  stopServer()
} else if (args.includes('--uninstall')) {
  uninstall(args.includes('--purge'))
} else {
  const background = args.includes('--background')
  if (!(await up())) {
    const p = startServer()
    let died = false
    p.on('exit', () => { died = true })
    const ok = await waitUp(180_000, () => died)
    if (!ok) {
      const tail = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).slice(-12).join('\n') : ''
      if (!background) alert(`เปิด Panya ไม่สำเร็จ${died ? '' : ' (รอนานเกินไป)'}\nCould not start Panya.\n\nบันทึก / log: ${LOG_FILE}\n\n${tail}`)
      process.exit(1)
    }
  }
  if (!background) open(`${base}/login?next=%2Fbrains`)
}
