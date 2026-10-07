// ทะเบียนชื่อเฉพาะต่อ container: ลูกค้า ผู้ขนส่ง ฯลฯ
// ใช้ตอบสองคำถามตอนค้น: คำค้นพูดถึงรายที่รู้จักไหม และพูดถึงรายที่ไม่รู้จักหรือเปล่า
import type { SeekdbClient } from 'seekdb'

export interface EntityType {
  type: string
  /** คำนำหน้าที่บอกว่าคำถัดไปคือชื่อ เช่น "ลูกค้า" "ผู้ขนส่ง" */
  cues: string[]
  names: string[]
}

/** เทียบชื่อแบบไม่สนช่องว่างและตัวพิมพ์ */
export const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, '')

export class EntityRegistry {
  private cache = new Map<string, EntityType[]>()

  private constructor(private client: SeekdbClient) {}

  static async open(client: SeekdbClient): Promise<EntityRegistry> {
    await client.execute(
      'CREATE TABLE IF NOT EXISTS panya_entity_types (container VARCHAR(191) NOT NULL, type VARCHAR(64) NOT NULL, cues TEXT, PRIMARY KEY (container, type))',
    )
    await client.execute(
      'CREATE TABLE IF NOT EXISTS panya_entities (container VARCHAR(191) NOT NULL, type VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL, norm VARCHAR(191) NOT NULL, PRIMARY KEY (container, norm))',
    )
    return new EntityRegistry(client)
  }

  /** ตั้งคำนำหน้าของประเภท และเพิ่มชื่อ (ชื่อเดิมไม่ถูกลบ) */
  async register(container: string, type: string, cues: string[], names: string[]) {
    await this.client.execute('REPLACE INTO panya_entity_types (container, type, cues) VALUES (?, ?, ?)', [
      container, type, JSON.stringify(cues),
    ])
    for (const name of names) await this.addName(container, type, name)
    this.cache.delete(container)
  }

  async addName(container: string, type: string, name: string) {
    const n = norm(name)
    if (!n) return
    await this.client.execute('INSERT IGNORE INTO panya_entities (container, type, name, norm) VALUES (?, ?, ?, ?)', [
      container, type, name.trim(), n,
    ])
    this.cache.delete(container)
  }

  async list(container: string): Promise<EntityType[]> {
    const hit = this.cache.get(container)
    if (hit) return hit
    const types = (await this.client.execute('SELECT type, cues FROM panya_entity_types WHERE container = ?', [container])) ?? []
    const names = (await this.client.execute('SELECT type, name FROM panya_entities WHERE container = ?', [container])) ?? []
    const by = new Map<string, EntityType>()
    for (const t of types) by.set(t.type, { type: t.type, cues: JSON.parse(t.cues || '[]'), names: [] })
    for (const n of names) {
      if (!by.has(n.type)) by.set(n.type, { type: n.type, cues: [], names: [] })
      by.get(n.type)!.names.push(n.name)
    }
    const out = [...by.values()]
    this.cache.set(container, out)
    return out
  }

  async clear(container: string) {
    await this.client.execute('DELETE FROM panya_entities WHERE container = ?', [container])
    await this.client.execute('DELETE FROM panya_entity_types WHERE container = ?', [container])
    this.cache.delete(container)
  }
}
