// จัดการผู้ใช้จากเครื่องเซิร์ฟเวอร์โดยตรง (ไม่ผ่าน HTTP) ใช้ตอนตั้งระบบครั้งแรก หรือเมื่อ admin ลืมรหัส
//   bun scripts/user.ts list
//   bun scripts/user.ts add <username> <admin|member|viewer> [brain,brain|*]   → สุ่มรหัสผ่านและพิมพ์ครั้งเดียว
//   bun scripts/user.ts reset <username>                                       → สุ่มรหัสใหม่ ปิด session เดิมทั้งหมด
//   bun scripts/user.ts disable|enable|remove <username>
import { SeekdbClient } from 'seekdb'
import { config } from '../src/config'
import { ROLES, USERNAME, UserRegistry, randomPassword, type Role } from '../src/users'

const [cmd, name, role, brains] = process.argv.slice(2)
const c = config.seekdb
const client = new SeekdbClient({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database })
const users = await UserRegistry.open(client)
const die = (msg: string) => { console.error(msg); process.exit(1) }

try {
  if (cmd === 'list') {
    for (const u of await users.list()) {
      console.log(`${u.username.padEnd(20)} ${u.role.padEnd(7)} ${u.disabled ? 'DISABLED' : 'active  '} brains=${u.brains.join(',') || '-'} last=${u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : 'never'}`)
    }
  } else if (cmd === 'add') {
    if (!name || !USERNAME.test(name)) die('username must be 2-64 characters: a-z 0-9 . _ -')
    if (!ROLES.has(role as Role)) die('role must be admin, member or viewer')
    if (await users.get(name!)) die('username already exists')
    const list = role === 'admin' ? ['*'] : (brains ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const password = randomPassword()
    await users.create(name!, password, role as Role, list)
    console.log(`created ${name} (${role}) brains=${list.join(',') || '-'}\npassword: ${password}\n(shown once, change it after the first login)`)
  } else if (cmd === 'reset') {
    if (!name || !(await users.get(name))) die('no such user')
    const password = randomPassword()
    await users.update(name!, { password })
    console.log(`new password for ${name}: ${password}`)
  } else if (cmd === 'disable' || cmd === 'enable') {
    if (!name || !(await users.get(name))) die('no such user')
    await users.update(name!, { disabled: cmd === 'disable' })
    console.log(`${name} ${cmd}d`)
  } else if (cmd === 'remove') {
    if (!name || !(await users.get(name))) die('no such user')
    await users.remove(name!)
    console.log(`${name} removed`)
  } else {
    die('usage: bun scripts/user.ts list | add <user> <role> [brains] | reset <user> | disable <user> | enable <user> | remove <user>')
  }
} finally {
  await client.close()
}
