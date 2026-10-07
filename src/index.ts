import { config } from './config'
import { localEmbedder, warmup } from './embed'
import { MemoryStore } from './memory'
import { createApp } from './server'

if (config.apiKeys.length === 0) {
  console.error('[panya] PANYA_API_KEYS is not set: refusing to start without auth')
  process.exit(1)
}

const store = await MemoryStore.open(localEmbedder)
await warmup()
const app = createApp(store)

Bun.serve({ port: config.port, hostname: process.env.PANYA_HOST ?? '127.0.0.1', fetch: app.fetch })
console.log(`[panya] listening on :${config.port} · seekdb ${config.seekdb.host}:${config.seekdb.port}/${config.seekdb.database} · ${config.embed.model}`)
