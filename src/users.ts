// ผู้ใช้ที่ล็อกอินด้วยชื่อและรหัสผ่าน (คน) แยกจาก API key (โปรแกรม)
// รหัสผ่านเก็บเป็น argon2id · session เก็บเฉพาะ sha256 ของ token ถ้าฐานข้อมูลรั่วก็เอาไปใช้แทนไม่ได้
import type { SeekdbClient } from 'seekdb'

export type Role = 'admin' | 'member' | 'viewer'
export const ROLES = new Set<Role>(['admin', 'member', 'viewer'])
export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,63}$/

export interface User {
  username: string
  role: Role
  /** brain ที่เข้าได้ · ['*'] = ทุก brain · admin เข้าได้ทุก brain เสมอ */
  brains: string[]
  disabled: boolean
  createdAt: number
  lastLoginAt: number
}

export interface Session { user: User; expiresAt: number }

const SESSION_MS = 12 * 3600_000
/** ตรวจ session ซ้ำกับฐานข้อมูลไม่บ่อยกว่านี้ ผู้ใช้ที่ถูกระงับจะหลุดภายในเวลานี้ */
const RECHECK_MS = 30_000
/** รหัสผ่านสั้นกว่านี้ไม่รับ */
export const MIN_PASSWORD = 10

const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')
const toUser = (r: any): User => ({
  username: String(r.username),
  role: r.role as Role,
  brains: JSON.parse(r.brains || '[]'),
  disabled: Number(r.disabled) === 1,
  createdAt: Number(r.created_at),
  lastLoginAt: Number(r.last_login ?? 0),
})

export class UserRegistry {
  private sessions = new Map<string, { session: Session; checkedAt: number }>()
  private total = -1

  private constructor(private client: SeekdbClient) {}

  static async open(client: SeekdbClient): Promise<UserRegistry> {
    await client.execute(
      'CREATE TABLE IF NOT EXISTS panya_users (username VARCHAR(64) NOT NULL PRIMARY KEY, pass_hash VARCHAR(255) NOT NULL, role VARCHAR(16) NOT NULL, brains TEXT, disabled TINYINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, last_login BIGINT NOT NULL DEFAULT 0)',
    )
    await client.execute(
      'CREATE TABLE IF NOT EXISTS panya_sessions (token_hash CHAR(64) NOT NULL PRIMARY KEY, username VARCHAR(64) NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, ip VARCHAR(64))',
    )
    const r = new UserRegistry(client)
    await r.count()
    return r
  }

  /** จำนวนผู้ใช้ทั้งหมด · มีอย่างน้อยหนึ่งคน = หน้าเว็บต้องล็อกอิน */
  async count(): Promise<number> {
    const rows = (await this.client.execute('SELECT COUNT(*) AS n FROM panya_users')) ?? []
    this.total = Number(rows[0]?.n ?? 0)
    return this.total
  }
  /** ค่าล่าสุดที่รู้ ไม่แตะฐานข้อมูล */
  get loginRequired() { return this.total > 0 }

  async list(): Promise<User[]> {
    const rows = (await this.client.execute('SELECT * FROM panya_users ORDER BY username')) ?? []
    return rows.map(toUser)
  }

  async get(username: string): Promise<User | null> {
    const rows = (await this.client.execute('SELECT * FROM panya_users WHERE username = ?', [username])) ?? []
    return rows[0] ? toUser(rows[0]) : null
  }

  async create(username: string, password: string, role: Role, brains: string[]): Promise<User> {
    const hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
    const now = Date.now()
    await this.client.execute(
      'INSERT INTO panya_users (username, pass_hash, role, brains, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      [username, hash, role, JSON.stringify(brains), now],
    )
    await this.count()
    return { username, role, brains, disabled: false, createdAt: now, lastLoginAt: 0 }
  }

  /** แก้บทบาท brain สถานะ หรือรหัสผ่าน · ระงับหรือเปลี่ยนรหัสแล้ว session เดิมของผู้ใช้นั้นใช้ไม่ได้ทันที */
  async update(username: string, patch: { role?: Role; brains?: string[]; disabled?: boolean; password?: string }) {
    if (patch.role !== undefined) await this.client.execute('UPDATE panya_users SET role = ? WHERE username = ?', [patch.role, username])
    if (patch.brains !== undefined) await this.client.execute('UPDATE panya_users SET brains = ? WHERE username = ?', [JSON.stringify(patch.brains), username])
    if (patch.disabled !== undefined) await this.client.execute('UPDATE panya_users SET disabled = ? WHERE username = ?', [patch.disabled ? 1 : 0, username])
    if (patch.password !== undefined) {
      const hash = await Bun.password.hash(patch.password, { algorithm: 'argon2id' })
      await this.client.execute('UPDATE panya_users SET pass_hash = ? WHERE username = ?', [hash, username])
    }
    if (patch.disabled || patch.password !== undefined) await this.endSessions(username)
    else this.forget(username)
  }

  async remove(username: string) {
    await this.endSessions(username)
    await this.client.execute('DELETE FROM panya_users WHERE username = ?', [username])
    await this.count()
  }

  /** ตรวจรหัสผ่าน · ชื่อที่ไม่มีอยู่ก็เสียเวลาเท่ากัน เพื่อไม่ให้เดาได้ว่าชื่อไหนมีจริง */
  async verify(username: string, password: string): Promise<User | null> {
    const rows = (await this.client.execute('SELECT * FROM panya_users WHERE username = ?', [username])) ?? []
    const row = rows[0]
    const ok = row
      ? await Bun.password.verify(password, String(row.pass_hash))
      : (await Bun.password.verify(password, DUMMY_HASH), false)
    if (!ok || !row || Number(row.disabled) === 1) return null
    await this.client.execute('UPDATE panya_users SET last_login = ? WHERE username = ?', [Date.now(), username])
    return toUser(row)
  }

  /** ออก session ใหม่ คืน token ที่ต้องใส่ใน cookie (ฐานข้อมูลเก็บเฉพาะ hash) */
  async startSession(user: User, ip: string): Promise<{ token: string; expiresAt: number }> {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const now = Date.now(), expiresAt = now + SESSION_MS
    await this.client.execute('DELETE FROM panya_sessions WHERE expires_at < ?', [now])
    await this.client.execute(
      'INSERT INTO panya_sessions (token_hash, username, expires_at, created_at, ip) VALUES (?, ?, ?, ?, ?)',
      [sha256(token), user.username, expiresAt, now, ip.slice(0, 64)],
    )
    return { token, expiresAt }
  }

  async session(token: string): Promise<Session | null> {
    if (!token || token.length > 128) return null
    const h = sha256(token), now = Date.now()
    const hit = this.sessions.get(h)
    if (hit && now - hit.checkedAt < RECHECK_MS) return hit.session.expiresAt > now ? hit.session : null
    const rows = (await this.client.execute(
      'SELECT s.expires_at, u.* FROM panya_sessions s JOIN panya_users u ON u.username = s.username WHERE s.token_hash = ?', [h],
    )) ?? []
    const row = rows[0]
    if (!row || Number(row.expires_at) <= now || Number(row.disabled) === 1) { this.sessions.delete(h); return null }
    const session = { user: toUser(row), expiresAt: Number(row.expires_at) }
    this.sessions.set(h, { session, checkedAt: now })
    return session
  }

  async endSession(token: string) {
    const h = sha256(token)
    this.sessions.delete(h)
    await this.client.execute('DELETE FROM panya_sessions WHERE token_hash = ?', [h])
  }

  private async endSessions(username: string) {
    this.forget(username)
    await this.client.execute('DELETE FROM panya_sessions WHERE username = ?', [username])
  }

  /** ทิ้งแคชของผู้ใช้คนนี้ ให้คำขอถัดไปอ่านสิทธิ์ใหม่จากฐานข้อมูล */
  private forget(username: string) {
    for (const [h, v] of this.sessions) if (v.session.user.username === username) this.sessions.delete(h)
  }
}

// hash ของรหัสที่ไม่มีใครรู้ ใช้เทียบเมื่อไม่พบชื่อผู้ใช้ ให้เวลาตอบเท่ากับกรณีพบ
const DUMMY_HASH = await Bun.password.hash(crypto.randomUUID(), { algorithm: 'argon2id' })

/** สุ่มรหัสผ่านอ่านง่าย 20 ตัว (ไม่มีตัวที่สับสน เช่น 0/O, 1/l) */
export function randomPassword(): string {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes, (b) => abc[b % abc.length]).join('')
}
