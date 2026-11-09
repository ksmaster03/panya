export type Q = { q: string; expect: string[]; type: string }
export type Ranked = { id: string; score: number }[]

/** แบ่งครึ่งแบบคงสัดส่วนประเภทคำถาม: ข้อคู่ของแต่ละประเภทไป tune ข้อคี่ไป holdout */
export function split(queries: Q[]): { tune: Q[]; holdout: Q[] } {
  const seen = new Map<string, number>()
  const tune: Q[] = []
  const holdout: Q[] = []
  for (const q of queries) {
    const n = seen.get(q.type) ?? 0
    seen.set(q.type, n + 1)
    ;(n % 2 === 0 ? tune : holdout).push(q)
  }
  return { tune, holdout }
}

/**
 * ตัวชี้วัดการค้นคืนแบบมีอันดับ (relevance แบบ ใช่/ไม่ใช่) ของคำถามที่มีคำตอบ
 *   rel = ผลแต่ละอันดับเกี่ยวหรือไม่ เรียงจากอันดับ 1 · relevant = จำนวนรายการที่เกี่ยวทั้งหมดในคลัง
 *   recall@k = มีรายการที่เกี่ยวอยู่ใน k อันดับแรกหรือไม่ (ค่าเฉลี่ยคือสัดส่วนคำถามที่หาเจอ)
 *   MRR = 1/อันดับของรายการที่เกี่ยวรายการแรก (หาไม่เจอ = 0)
 *   nDCG@k = DCG ของอันดับจริงหารด้วย DCG ของอันดับที่ดีที่สุดเท่าที่เป็นไปได้
 */
export function rankScores(rel: boolean[], relevant: number, k = 5) {
  const first = rel.findIndex(Boolean)
  const at = (n: number) => (first >= 0 && first < n ? 1 : 0)
  let dcg = 0, idcg = 0
  for (let i = 0; i < k; i++) {
    if (rel[i]) dcg += 1 / Math.log2(i + 2)
    if (i < relevant) idcg += 1 / Math.log2(i + 2)
  }
  return { r1: at(1), r3: at(3), r5: at(5), mrr: first >= 0 ? 1 / (first + 1) : 0, ndcg: idcg ? dcg / idcg : 0 }
}

/** hitsOf ต้องคืนผลที่ผ่านเกณฑ์แล้ว เรียงจากดีสุด */
export function measure(queries: Q[], hitsOf: (q: Q) => Ranked) {
  let top1 = 0, top3 = 0, answerable = 0, falseAbstain = 0, unanswerable = 0, correctAbstain = 0, mrr = 0, ndcg = 0
  const misses: string[] = []
  for (const query of queries) {
    const ranked = hitsOf(query)
    const hits = ranked.slice(0, 3)
    if (query.expect.length) {
      answerable++
      const rs = rankScores(ranked.map((h) => query.expect.includes(h.id)), query.expect.length)
      mrr += rs.mrr; ndcg += rs.ndcg
      if (hits.length === 0) falseAbstain++
      if (hits[0] && query.expect.includes(hits[0].id)) top1++
      if (hits.some((h) => query.expect.includes(h.id))) top3++
      else misses.push(`[${query.type}] ${query.q} -> ${hits.map((h) => h.id).join(',') || 'ไม่ตอบ'}`)
    } else {
      unanswerable++
      if (hits.length === 0) correctAbstain++
      else misses.push(`[${query.type}] ${query.q} -> ตอบ ${hits.map((h) => `${h.id}(${h.score.toFixed(2)})`).join(',')}`)
    }
  }
  const div = (a: number, b: number) => (b ? a / b : NaN)
  return {
    top1: div(top1, answerable), top3: div(top3, answerable), falseAbstain: div(falseAbstain, answerable),
    mrr: div(mrr, answerable), ndcg: div(ndcg, answerable),
    abstain: div(correctAbstain, unanswerable),
    // ใช้เลือกเกณฑ์: ตอบถูก กับ รู้จักไม่ตอบ มีน้ำหนักเท่ากัน
    combined: (div(top3, answerable) + div(correctAbstain, unanswerable)) / 2,
    misses, answerable, unanswerable,
  }
}

const pct = (x: number) => (Number.isNaN(x) ? '-' : (x * 100).toFixed(0) + '%')

export function report(name: string, queries: Q[], hitsOf: (q: Q) => Ranked, showMisses = false) {
  const m = measure(queries, hitsOf)
  console.log(`${name}: ถูกอันดับ1 ${pct(m.top1)} · ถูกใน3 ${pct(m.top3)} · ไม่ตอบทั้งที่มีคำตอบ ${pct(m.falseAbstain)} · ไม่ตอบเมื่อไม่มีคำตอบ ${pct(m.abstain)} · MRR ${m.mrr.toFixed(3)} · nDCG@5 ${m.ndcg.toFixed(3)} (มีคำตอบ ${m.answerable} ไม่มี ${m.unanswerable})`)
  for (const type of ['lex', 'para', 'off', 'near']) {
    const t = measure(queries.filter((q) => q.type === type), hitsOf)
    console.log(t.answerable
      ? `    ${type.padEnd(5)} ถูกอันดับ1 ${pct(t.top1)} · ถูกใน3 ${pct(t.top3)} · ไม่ตอบ ${pct(t.falseAbstain)} (${t.answerable} ข้อ)`
      : `    ${type.padEnd(5)} ไม่ตอบถูกต้อง ${pct(t.abstain)} (${t.unanswerable} ข้อ)`)
  }
  if (showMisses) for (const x of m.misses) console.log('      ' + x)
  return m
}
