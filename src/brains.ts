// เจ้าของและการแชร์ของแต่ละสมอง
// เจ้าของอ่าน เขียน ลบ และเลือกคนที่อ่านได้ · คนที่ได้รับแชร์อ่านและค้นได้อย่างเดียว ไม่มีใครเขียนสมองของคนอื่นได้
// สมองที่ไม่มีในทะเบียน (สร้างก่อนมีระบบนี้ หรือเขียนด้วย API key) เป็นของ admin
import type { SeekdbClient } from 'seekdb'

export interface BrainInfo {
  name: string
  owner: string
  description: string
  createdAt: number
  /** ผู้ใช้ที่เจ้าของให้อ่านได้ */
  readers: string[]
}

export class BrainRegistry {
  private all: Map<string, BrainInfo> | null = null

  private constructor(private client: SeekdbClient) {}

  static async open(client: SeekdbClient): Promise<BrainRegistry> {
    await client.execute(
      'CREATE TABLE IF NOT EXISTS panya_brains (name VARCHAR(128) NOT NULL PRIMARY KEY, owner VARCHAR(64) NOT NULL, description VARCHAR(500), created_at BIGINT NOT NULL)',
    )
    await client.execute(
      'CREATE TABLE IF NOT EXISTS panya_brain_readers (brain VARCHAR(128) NOT NULL, username VARCHAR(64) NOT NULL, PRIMARY KEY (brain, username))',
    )
    return new BrainRegistry(client)
  }

  /** ทะเบียนทั้งหมด (เล็ก อ่านครั้งเดียวแล้วเก็บไว้ ล้างเมื่อมีการแก้) */
  async list(): Promise<Map<string, BrainInfo>> {
    if (this.all) return this.all
    const rows = (await this.client.execute('SELECT * FROM panya_brains')) ?? []
    const readers = (await this.client.execute('SELECT brain, username FROM panya_brain_readers')) ?? []
    const all = new Map<string, BrainInfo>()
    for (const r of rows) all.set(String(r.name), { name: String(r.name), owner: String(r.owner), description: String(r.description ?? ''), createdAt: Number(r.created_at), readers: [] })
    for (const r of readers) all.get(String(r.brain))?.readers.push(String(r.username))
    this.all = all
    return all
  }

  async get(name: string) { return (await this.list()).get(name) ?? null }

  /** สมองที่ผู้ใช้คนนี้เป็นเจ้าของ และที่ได้รับแชร์ให้อ่าน */
  async accessFor(username: string): Promise<{ own: string[]; shared: string[] }> {
    const own: string[] = [], shared: string[] = []
    for (const b of (await this.list()).values()) {
      if (b.owner === username) own.push(b.name)
      else if (b.readers.includes(username)) shared.push(b.name)
    }
    return { own, shared }
  }

  async create(name: string, owner: string, description: string) {
    await this.client.execute('INSERT INTO panya_brains (name, owner, description, created_at) VALUES (?, ?, ?, ?)', [name, owner, description, Date.now()])
    this.all = null
  }

  async update(name: string, patch: { description?: string; readers?: string[]; owner?: string }) {
    if (patch.description !== undefined) await this.client.execute('UPDATE panya_brains SET description = ? WHERE name = ?', [patch.description, name])
    if (patch.owner !== undefined) await this.client.execute('UPDATE panya_brains SET owner = ? WHERE name = ?', [patch.owner, name])
    if (patch.readers !== undefined) {
      await this.client.execute('DELETE FROM panya_brain_readers WHERE brain = ?', [name])
      for (const u of new Set(patch.readers)) await this.client.execute('INSERT INTO panya_brain_readers (brain, username) VALUES (?, ?)', [name, u])
    }
    this.all = null
  }

  async remove(name: string) {
    await this.client.execute('DELETE FROM panya_brain_readers WHERE brain = ?', [name])
    await this.client.execute('DELETE FROM panya_brains WHERE name = ?', [name])
    this.all = null
  }

  /** ผู้ใช้ถูกลบ: เอาออกจากรายชื่อผู้อ่านทุกสมอง (สมองที่เป็นเจ้าของยังอยู่ ให้ admin ตัดสินใจ) */
  async forgetUser(username: string) {
    await this.client.execute('DELETE FROM panya_brain_readers WHERE username = ?', [username])
    this.all = null
  }
}
