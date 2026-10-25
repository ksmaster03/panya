// panya UI helpers: theme (light/dark), language (TH/EN), shared header, toast, API helper
// Load in <head> without defer so the theme is applied before the page paints.
(() => {
  const store = {
    get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
  }
  const media = matchMedia('(prefers-color-scheme: dark)')
  const themeOf = () => store.get('panya.theme') || (media.matches ? 'dark' : 'light')
  const applyTheme = () => { document.documentElement.dataset.theme = themeOf() }
  applyTheme()
  media.addEventListener('change', () => { if (!store.get('panya.theme')) { applyTheme(); fire('panya:theme') } })

  let lang = store.get('panya.lang') || ((navigator.language || 'th').toLowerCase().startsWith('th') ? 'th' : 'en')
  document.documentElement.lang = lang
  const fire = (name) => document.dispatchEvent(new CustomEvent(name))

  const H = {
    th: { dashboard: 'แดชบอร์ด', brain: 'สมอง', warehouse: 'คลังสินค้า', brains: 'สมองของฉัน', account: 'บัญชีและ API', users: 'ผู้ใช้', signIn: 'เข้าสู่ระบบ', signOut: 'ออกจากระบบ',
          features: 'ความสามารถ', api: 'ใช้ผ่าน API', security: 'ความปลอดภัย', menu: 'เมนู', toDark: 'โหมดมืด', toLight: 'โหมดสว่าง', lang: 'EN', langAria: 'Switch to English', nav: 'เมนูหลัก', skip: 'ข้ามไปเนื้อหา',
          sub: 'สมองที่สอง', expired: 'หมดเวลาเข้าระบบ กรุณาเข้าสู่ระบบใหม่' },
    en: { dashboard: 'Dashboard', brain: 'Brain', warehouse: 'Warehouse', brains: 'My brains', account: 'Account & API', users: 'Users', signIn: 'Sign in', signOut: 'Sign out',
          features: 'Features', api: 'API', security: 'Security', menu: 'Menu', toDark: 'Dark mode', toLight: 'Light mode', lang: 'ไทย', langAria: 'เปลี่ยนเป็นภาษาไทย', nav: 'Main', skip: 'Skip to content',
          sub: 'Second brain', expired: 'Your session ended. Please sign in again.' },
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b9dff"/><stop offset="1" stop-color="#3fd0bd"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#pg)"/><path d="M10 22c-2.2 0-4-1.8-4-4 0-1.6 1-3 2.4-3.6C8.6 11.4 11 9 14 9c1 0 2 .3 2.8.8C17.6 9.3 18.6 9 19.6 9c3 0 5.4 2.4 5.6 5.4 1.3.7 2.2 2 2.2 3.6 0 2.2-1.8 4-4 4H10z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 10v12M12 15h3M17 18h4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>'
  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  const BURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'

  const fetch0 = window.fetch.bind(window)
  const UI = {
    get lang() { return lang },
    get theme() { return themeOf() },
    esc,
    /** ข้อความจากพจนานุกรมของหน้า: dict[lang][key] เป็นข้อความหรือฟังก์ชัน */
    t(dict, key, ...a) { const v = (dict[lang] || dict.th)[key]; return typeof v === 'function' ? v(...a) : v ?? key },
    setLang(next) { lang = next; store.set('panya.lang', lang); document.documentElement.lang = lang; fire('panya:lang') },
    setTheme(next) { store.set('panya.theme', next); applyTheme(); fire('panya:theme') },
    /** ใส่ข้อความตาม data-i18n / data-i18n-ph / data-i18n-aria ภายใน root */
    apply(dict, root = document) {
      for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = UI.t(dict, el.dataset.i18n)
      for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = UI.t(dict, el.dataset.i18nHtml)
      for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = UI.t(dict, el.dataset.i18nPh)
      for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', UI.t(dict, el.dataset.i18nAria))
    },
    toast(msg, crit = false) {
      for (const old of document.querySelectorAll('.toast')) old.remove() // ทีละอัน ไม่ซ้อนกัน
      const el = document.createElement('div')
      el.className = 'toast' + (crit ? ' crit' : ''); el.setAttribute('role', crit ? 'alert' : 'status'); el.textContent = msg
      document.body.appendChild(el); setTimeout(() => el.remove(), crit ? 6000 : 3200)
    },
    /** เรียก API ด้วย cookie · 401 → หน้าเข้าสู่ระบบ · error → throw Error(ข้อความจากเซิร์ฟเวอร์) */
    async api(method, path, body) {
      const r = await fetch0(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      if (r.status === 401 && window.PANYA_USER) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error(H[lang].expired) }
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error(j.error || String(r.status)), { status: r.status })
      return j
    },
    /** หัวหน้ากลาง: current = path ของหน้านี้ · public = หน้าที่ไม่ต้องล็อกอิน (landing) */
    header(current, { public: isPublic = false } = {}) {
      const me = window.PANYA_USER
      const host = document.querySelector('header.app-header') || document.body.insertBefore(Object.assign(document.createElement('header'), { className: 'app-header' }), document.body.firstChild)
      const links = me
        ? [['/dashboard', 'dashboard'], ['/brain', 'brain'], ['/warehouse', 'warehouse'], ['/brains', 'brains'], ['/account', 'account'], ...(me.role === 'admin' ? [['/users', 'users']] : [])]
        : isPublic ? [['#features', 'features'], ['#api', 'api'], ['#security', 'security']] : []
      const paint = () => {
        const h = H[lang], dark = themeOf() === 'dark'
        host.innerHTML = `<a class="skip" href="#main">${h.skip}</a><div class="bar">
          <a class="brand" href="${me ? '/dashboard' : '/'}">${LOGO}panya <span>· ${h.sub}</span></a>
          <nav class="app-nav" id="app-nav" aria-label="${h.nav}">${links.map(([href, k]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${h[k]}</a>`).join('')}${me ? `<button class="btn nav-out" type="button" data-act="out">${h.signOut} · ${esc(me.username)}</button>` : ''}</nav>
          <i class="grow"></i>
          <div class="tools">
            ${me ? `<span class="who" title="${esc(me.username)}">${esc(me.username)}</span>` : ''}
            <button class="icon-btn" type="button" data-act="theme" aria-label="${dark ? h.toLight : h.toDark}" title="${dark ? h.toLight : h.toDark}">${dark ? SUN : MOON}</button>
            <button class="icon-btn" type="button" data-act="lang" aria-label="${h.langAria}">${h.lang}</button>
            ${me ? `<button class="btn sm tool-out" type="button" data-act="out">${h.signOut}</button>` : current === '/login' ? '' : `<a class="btn sm primary" href="/login">${h.signIn}</a>`}
            ${links.length ? `<button class="icon-btn menu-btn" type="button" data-act="menu" aria-expanded="false" aria-controls="app-nav" aria-label="${h.menu}">${BURGER}</button>` : ''}
          </div></div>`
      }
      host.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-act]'); if (!b) { if (ev.target.closest('.app-nav a')) host.querySelector('.app-nav')?.classList.remove('open'); return }
        if (b.dataset.act === 'theme') UI.setTheme(themeOf() === 'dark' ? 'light' : 'dark')
        else if (b.dataset.act === 'lang') UI.setLang(lang === 'th' ? 'en' : 'th')
        else if (b.dataset.act === 'out') { await fetch0('/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/login' }
        else if (b.dataset.act === 'menu') { const nav = host.querySelector('.app-nav'); const open = nav.classList.toggle('open'); b.setAttribute('aria-expanded', String(open)) }
      })
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') host.querySelector('.app-nav')?.classList.remove('open') })
      document.addEventListener('panya:lang', paint)
      document.addEventListener('panya:theme', paint)
      paint()
    },
  }
  window.PanyaUI = UI
})()
