import { config } from './config'
import { localEmbedder, warmup } from './embed'
import { MemoryStore } from './memory'
import { localReranker, warmupReranker } from './rerank'
import { createApp } from './server'
import { MIN_PASSWORD, USERNAME } from './users'

const store = await MemoryStore.open(localEmbedder, { reranker: config.rerank.enabled ? localReranker : null })

// admin คนแรกจาก env (เช่นค่าจาก SSM บนคลาวด์) · สร้างเฉพาะเมื่อยังไม่มีผู้ใช้ จึงตั้งค่าค้างไว้ได้โดยไม่ทับรหัสที่เปลี่ยนแล้ว
const boot = config.bootstrapAdmin
if (boot.username && (await store.users.count()) === 0) {
  if (!USERNAME.test(boot.username) || boot.password.length < MIN_PASSWORD) {
    console.error(`[panya] PANYA_ADMIN_USER must match ${USERNAME} and PANYA_ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters`)
    process.exit(1)
  }
  await store.users.create(boot.username, boot.password, 'admin', ['*'])
  console.log(`[panya] created the first admin user "${boot.username}"`)
}

if (config.apiKeys.length === 0 && (await store.users.count()) === 0) {
  console.error('[panya] no PANYA_API_KEYS and no users: refusing to start without auth (set PANYA_ADMIN_USER + PANYA_ADMIN_PASSWORD or PANYA_API_KEYS)')
  process.exit(1)
}

await warmup()
if (config.rerank.enabled) await warmupReranker()
const app = createApp(store, undefined, { warmPoints: true, exitOnLostDb: true })

Bun.serve({ port: config.port, hostname: process.env.PANYA_HOST ?? '127.0.0.1', fetch: app.fetch })
console.log(`[panya] listening on :${config.port} · seekdb ${config.seekdb.host}:${config.seekdb.port}/${config.seekdb.database} · ${config.embed.model}${config.rerank.enabled ? ` · rerank ${config.rerank.model} (top ${config.rerank.top})` : ''} · ${store.users.loginRequired ? 'login required' : 'API key only'}`)
