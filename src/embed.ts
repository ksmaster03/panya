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
export const localEmbedder: Embedder = {
  passage: (texts) => run(texts.map((t) => 'passage: ' + t)),
  query: async (text) => (await run(['query: ' + text]))[0]!,
}

export const warmup = () => load().then(() => undefined)
