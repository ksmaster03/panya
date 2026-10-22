// ใช้ร่วมกันทุกหน้าเมื่อล็อกอินด้วยชื่อผู้ใช้ (เซิร์ฟเวอร์ใส่ window.PANYA_USER ให้ในหน้า)
// เพิ่มชื่อผู้ใช้ + ปุ่มออกจากระบบ ลิงก์หน้าผู้ใช้สำหรับ admin และพาไปหน้าล็อกอินเมื่อ session หมดอายุ
(() => {
  const me = window.PANYA_USER
  if (!me) return
  const th = () => (document.documentElement.lang || 'th').startsWith('th')
  const text = () => (th() ? { out: 'ออกจากระบบ', users: 'ผู้ใช้' } : { out: 'Sign out', users: 'Users' })

  // session หมดอายุหรือถูกระงับ: คำขอ /v1 ตอบ 401 → ไปหน้าล็อกอินแล้วกลับมาหน้านี้
  const fetch0 = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const r = await fetch0(input, init)
    const url = typeof input === 'string' ? input : input.url
    if (r.status === 401 && /^(\/|https?:\/\/[^/]+\/)v1\//.test(url)) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search)
    }
    return r
  }

  const style = document.createElement('style')
  style.textContent = '.panya-me{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted,#9db0d0)}.panya-me button{min-height:36px;padding:2px 12px}'
  document.head.appendChild(style)

  const mount = () => {
    const header = document.querySelector('header')
    const nav = document.querySelector('header .nav')
    if (nav && me.role === 'admin' && !nav.querySelector('a[href="/users"]')) {
      const a = document.createElement('a'); a.href = '/users'; a.dataset.panyaUsers = '1'; nav.appendChild(a)
    }
    if (!header || header.querySelector('.panya-me')) return
    const box = document.createElement('span'); box.className = 'panya-me'
    const name = document.createElement('span'); name.textContent = me.username
    const out = document.createElement('button'); out.type = 'button'
    out.addEventListener('click', async () => { await fetch0('/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/login' })
    box.append(name, out); header.appendChild(box)
    const paint = () => {
      const s = text(); out.textContent = s.out
      const link = nav && nav.querySelector('a[data-panya-users]'); if (link) link.textContent = s.users
    }
    paint()
    // หน้าเปลี่ยนภาษาด้วยการแก้ <html lang> จึงวาดข้อความใหม่ตาม
    new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()
