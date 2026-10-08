import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { config } from './config'

export interface Embedder {
  passage(texts: string[]): Promise<number[][]>
  query(text: string): Promise<number[]>
}

let pipe: Promise<FeatureExtractionPipeline> | null = null
function load() {
  pipe ??= pipeline('feature-extraction', config.embed.model, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>
  return pipe
}

async function run(texts: string[]): Promise<number[][]> {
  const p = await load()
  const out = await p(texts, { pooling: 'mean', normalize: true })
  return out.tolist() as number[][]
}

// โมเดลตระกูล e5 ต้องมีคำนำหน้า "query: " / "passage: " ไม่งั้นคะแนนเกาะกลุ่มกัน
// คำค้นเดิมถูกถามซ้ำบ่อย (แดชบอร์ด รายงานประจำ) จำเวกเตอร์ไว้ไม่ต้องคำนวณใหม่
const QUERY_CACHE_MAX = 1000
const queryCache = new Map<string, Promise<number[]>>()

export const localEmbedder: Embedder = {
  passage: (texts) => run(texts.map((t) => 'passage: ' + t)),
  query: (text) => {
    const hit = queryCache.get(text)
    if (hit) {
      queryCache.delete(text)
      queryCache.set(text, hit)
      return hit
    }
    const vec = run(['query: ' + text]).then((r) => r[0]!)
    vec.catch(() => queryCache.delete(text))
    queryCache.set(text, vec)
    if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value!)
    return vec
  },
}

export const warmup = () => load().then(() => undefined)
