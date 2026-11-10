// สร้างตัวติดตั้งแอป Windows: bun windows/build.ts → dist/windows/Panya-Setup.exe
// ต้องรันบน Windows x64 (Panya.exe คอมไพล์จาก bun ของเครื่องนี้ และใช้โมเดล e5-small ในแคชของ transformers)
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'dist', 'windows')
const STAGE = join(OUT, 'Panya')
const APP = join(STAGE, 'app')
const VERSION = process.env.PANYA_VERSION ?? '1.0.0'
const MODEL = 'Xenova/multilingual-e5-small'

const sh = (cmd: string[], cwd = ROOT) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(' ')}`)
}
const size = (p: string): number => (statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + size(join(p, f)), 0) : statSync(p).size)
/**
 * ตั้ง subsystem ของ exe เป็น GUI: --windows-hide-console ยังเปิดหน้าต่าง Windows Terminal ว่าง ๆ บนเครื่องที่ตั้ง Terminal เป็น console หลัก
 * โปรแกรม GUI ไม่มี console เลย (ผลลัพธ์ของเราเขียนลงไฟล์ log อยู่แล้ว)
 */
function guiSubsystem(exe: string) {
  const fd = openSync(exe, 'r+')
  const b = Buffer.alloc(4)
  readSync(fd, b, 0, 4, 0x3c)
  const pe = b.readUInt32LE(0)
  readSync(fd, b, 0, 4, pe)
  if (b.readUInt32LE(0) !== 0x4550) throw new Error(`${exe}: not a PE file`)
  // optional header เริ่มที่ pe + 24 · Subsystem อยู่ที่ offset 68 ทั้ง PE32 และ PE32+
  writeSync(fd, Buffer.from([2, 0]), 0, 2, pe + 24 + 68)
  closeSync(fd)
}
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`

if (process.platform !== 'win32') throw new Error('build on Windows x64')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(APP, { recursive: true })

console.log('1/6 copy source')
cpSync(join(ROOT, 'src'), join(APP, 'src'), { recursive: true, filter: (p) => !p.endsWith('.mp3') })
mkdirSync(join(APP, 'scripts'))
cpSync(join(ROOT, 'scripts', 'transcribe.py'), join(APP, 'scripts', 'transcribe.py'))
for (const f of ['package.json', 'bun.lock', 'tsconfig.json', 'LICENSE.md', 'README.md', 'README.th.md']) cpSync(join(ROOT, f), join(APP, f))

console.log('2/6 production dependencies')
sh([process.execPath, 'install', '--production', '--frozen-lockfile'], APP)
// เหลือเฉพาะไฟล์ของ Windows x64
const nm = join(APP, 'node_modules')
for (const d of readdirSync(join(nm, 'onnxruntime-node', 'bin'))) for (const os of ['linux', 'darwin', 'win32/arm64']) rmSync(join(nm, 'onnxruntime-node', 'bin', d, os), { recursive: true, force: true })
// transformers รุ่น node รวม onnxruntime-web ไว้ในไฟล์ตัวเองแล้ว · typescript/@types ใช้ตอนพัฒนาเท่านั้น
for (const d of ['onnxruntime-web', 'typescript', '@types', 'bun-types']) rmSync(join(nm, d), { recursive: true, force: true })
if (existsSync(join(nm, '@img'))) for (const d of readdirSync(join(nm, '@img'))) if (/^sharp-/.test(d) && !/win32-x64/.test(d)) rmSync(join(nm, '@img', d), { recursive: true, force: true })

console.log(`3/6 bundle the embedding model ${MODEL}`)
const cache = join(ROOT, 'node_modules', '@huggingface', 'transformers', '.cache', ...MODEL.split('/'))
if (!existsSync(join(cache, 'onnx', 'model_quantized.onnx'))) throw new Error(`run panya once so ${MODEL} is downloaded to ${cache}`)
const dest = join(nm, '@huggingface', 'transformers', '.cache', ...MODEL.split('/'))
mkdirSync(join(dest, 'onnx'), { recursive: true })
for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) cpSync(join(cache, f), join(dest, f))
cpSync(join(cache, 'onnx', 'model_quantized.onnx'), join(dest, 'onnx', 'model_quantized.onnx'))

console.log('4/6 launcher (also the runtime: it runs the server as bun with BUN_BE_BUN=1)')
const win = ['--windows-icon=' + join(import.meta.dir, 'panya.ico'), '--windows-title=Panya', '--windows-publisher=ksmaster03', `--windows-version=${VERSION}.0`, '--windows-copyright=PolyForm Noncommercial 1.0.0']
sh([process.execPath, 'build', '--compile', '--target=bun-windows-x64', '--windows-hide-console', ...win, '--windows-description=Panya second brain', join(import.meta.dir, 'launcher.ts'), '--outfile', join(STAGE, 'Panya.exe')])
guiSubsystem(join(STAGE, 'Panya.exe'))
console.log(`   app folder ${mb(size(STAGE))}`)

console.log('5/6 pack')
sh([join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), '-czf', join(OUT, 'payload.tar.gz'), '-C', OUT, 'Panya'])
console.log(`   payload ${mb(size(join(OUT, 'payload.tar.gz')))}`)

console.log('6/6 setup program')
sh([process.execPath, 'build', '--compile', '--target=bun-windows-x64', '--windows-hide-console', ...win, '--windows-description=Panya setup', `--define=PANYA_VERSION=${JSON.stringify(VERSION)}`, join(import.meta.dir, 'setup.ts'), '--outfile', join(OUT, 'Panya-Setup.exe')])
guiSubsystem(join(OUT, 'Panya-Setup.exe'))
console.log(`done: ${join(OUT, 'Panya-Setup.exe')} (${mb(size(join(OUT, 'Panya-Setup.exe')))})`)
