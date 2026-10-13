import { AutoModelForSequenceClassification, AutoTokenizer } from '@huggingface/transformers'
import { config } from './config'

/** ให้คะแนน 0-1 ว่าแต่ละข้อความตอบคำถามได้แค่ไหน เรียงตามลำดับของ docs */
export interface Reranker {
  score(query: string, docs: string[]): Promise<number[]>
}

type Loaded = { tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>; model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> }
let loaded: Promise<Loaded> | null = null
function load() {
  loaded ??= (async () => ({
    tokenizer: await AutoTokenizer.from_pretrained(config.rerank.model),
    model: await AutoModelForSequenceClassification.from_pretrained(config.rerank.model, { dtype: 'q8' }),
  }))()
  return loaded
}

// ความจำยาวไม่เกิน 2000 ตัวอักษร: 384 โทเคนครอบคลุมเกือบทั้งหมด และเวลาที่ใช้ขึ้นกับความยาวนี้โดยตรง
const MAX_TOKENS = 384

export const localReranker: Reranker = {
  async score(query, docs) {
    if (!docs.length) return []
    const { tokenizer, model } = await load()
    const inputs = tokenizer(new Array(docs.length).fill(query), { text_pair: docs, padding: true, truncation: true, max_length: MAX_TOKENS })
    const { logits } = await model(inputs)
    return Array.from(logits.data as Float32Array, (x) => 1 / (1 + Math.exp(-x)))
  },
}

export const warmupReranker = () => localReranker.score('warmup', ['warmup']).then(() => undefined)
