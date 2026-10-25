// กฎสำคัญของ panya: ห้ามเก็บความลับ (รหัสผ่าน, API key, token, private key, connection string ที่มีรหัส)
// ความจำถูกค้นและแสดงให้ผู้อื่นที่ได้รับสิทธิ์อ่านเห็น ความลับที่หลุดเข้ามาจะรั่วไปถึงทุกคนที่อ่านสมองนั้นได้
// ตรวจทุกช่องทางที่เขียน: บันทึก, บันทึกเป็นชุด, นำเข้า · ปฏิเสธทั้งคำขอ ไม่ตัดเฉพาะส่วน

export interface SecretHit {
  /** ชื่อกฎที่ตรง เช่น aws-access-key */
  rule: string
}

// รูปแบบของผู้ให้บริการที่รู้จัก: ตรงแบบนี้แทบไม่มีทางเป็นข้อความทั่วไป
const PROVIDERS: [string, RegExp][] = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['stripe-key', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['panya-api-key', /\b(?:pk_[A-Za-z0-9]{32,}|pnu_[a-z0-9]{12}_[A-Za-z0-9]{20,})\b/],
  ['cloudflare-token', /\b(?:cf|CF)[_-]?(?:api[_-]?)?token\s*[:=]\s*["']?[A-Za-z0-9_-]{37,}/],
  ['url-credentials', /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,64}:[^\s:/@]{3,128}@[^\s/]+/i],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
]

// คำบอกว่าเป็นความลับ ตามด้วยค่า เช่น password: Abc12345!  /  api_key = "..."  /  รหัสผ่าน คือ xyz123
const KEYWORD = /(?:pass(?:word|wd|phrase)?|pwd|secret|api[_ -]?key|access[_ -]?key|private[_ -]?key|client[_ -]?secret|auth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|รหัสผ่าน|พาสเวิร์ด|คีย์)(?:\s+[^\s:=]{1,20}){0,2}\s*(?:คือ|=|:|:=|=>|เป็น)\s*["'`]?([^\s"'`,;]{6,})/gi

// ค่าที่เป็นตัวอย่างหรือที่ว่าง ไม่ใช่ความลับจริง: <your-key>, ${VAR}, xxx, ****, your_password, changeme
const PLACEHOLDER = /^(?:<[^>]*>?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_]+%|\{\{.*\}\}|x{3,}.*|\*{3,}.*|\.{3,}.*|(?:your|my|the|example|sample|dummy|fake|test)[_-]?\w*|changeme|redacted|hidden|null|none|undefined|placeholder|process\.env\.\w+|env\.\w+|os\.environ.*|config\.\w+.*|getenv.*)$/i

/** คืนกฎแรกที่ตรง หรือ null เมื่อไม่พบความลับ */
export function findSecret(text: string): SecretHit | null {
  if (!text) return null
  for (const [rule, re] of PROVIDERS) if (re.test(text)) return { rule }
  for (const m of text.matchAll(KEYWORD)) {
    const value = m[1]!.replace(/[.)\]}>]+$/, '')
    if (value.length < 6 || PLACEHOLDER.test(value)) continue
    // ค่าที่เป็นคำธรรมดาล้วน (เช่น "password: required") ไม่นับ ต้องมีตัวเลขหรือสัญลักษณ์ปนอยู่
    if (/^[A-Za-zก-๙]+$/.test(value)) continue
    return { rule: 'credential-assignment' }
  }
  return null
}
