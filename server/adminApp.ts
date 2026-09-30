// ─────────────────────────────────────────────────────────────────────────────
// The control panel's browser code. It is sent to the page as its own source text
// (adminApp.toString()), so it must stay self-contained: no imports, no outside variables.
// Everything user-provided is put on the page as text, never as HTML.
// ─────────────────────────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
export function adminApp(): void {
  type Json = Record<string, any>;
  type Kid = Node | string | number | null | undefined | false;

  const root = document.getElementById('app') as HTMLElement;
  let token = sessionStorage.getItem('mc-admin') || '';
  let data: Json | null = null;
  let tab = ['overview', 'users', 'settings', 'security', 'log'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  let userFilter = '';
  let userView: 'all' | 'pending' | 'locked' | 'admin' = 'all';
  let settingsDirty = false;
  const draft = { name: '', pass: '', admin: false };
  let flashTimer = 0;
  let refresh = 0;

  // ── little helpers ──
  function h(tag: string, attrs?: Json | null, ...kids: Kid[]): HTMLElement {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'class') el.className = String(v);
        else if (k === 'value') (el as HTMLInputElement).value = String(v);
        else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    return el;
  }
  const when = (t: number | null) =>
    t ? new Date(t).toLocaleString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
  const dur = (s: number) => (s >= 3600 ? Math.floor(s / 3600) + ' ó ' + Math.floor((s % 3600) / 60) + ' p' : s >= 60 ? Math.ceil(s / 60) + ' perc' : s + ' mp');

  async function api(path: string, body: Json = {}): Promise<Json> {
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(Object.assign({}, body, { token })) });
      const j = await res.json();
      if (j && j.auth === false && token) {
        signOut('A bejelentkezés lejárt – lépj be újra.');
        return { ok: false, error: j.error };
      }
      return j;
    } catch {
      return { ok: false, error: 'Nem érem el a szervert.' };
    }
  }

  // one message at a time, outside #app so re-renders leave it alone
  function say(text: string, tone: 'ok' | 'error' = 'ok'): void {
    window.clearTimeout(flashTimer);
    document.querySelectorAll('.flash').forEach((f) => f.remove());
    document.body.append(h('div', { class: 'flash flash-' + tone, role: tone === 'error' ? 'alert' : 'status' }, text));
    flashTimer = window.setTimeout(() => document.querySelectorAll('.flash').forEach((f) => f.remove()), tone === 'error' ? 6000 : 3000);
  }

  async function act(path: string, body: Json, done: string): Promise<boolean> {
    const r = await api(path, body);
    if (r.ok) {
      say(done);
      await load();
    } else say(r.error || 'Hiba.', 'error');
    return !!r.ok;
  }

  // ── a small dialog (confirmations, new password) ──
  function dialog(title: string, body: Kid, actions: { label: string; tone?: string; run: () => void | Promise<unknown> }[]): void {
    const close = () => wrap.remove();
    const wrap = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', onclick: (e: Event) => e.target === wrap && close() },
      h(
        'div',
        { class: 'modal-card' },
        h('h3', null, title),
        body,
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: close }, 'Mégse'),
          ...actions.map((a) =>
            h(
              'button',
              {
                class: 'btn ' + (a.tone || 'btn-primary'),
                onclick: async () => {
                  await a.run();
                  close();
                },
              },
              a.label,
            ),
          ),
        ),
      ),
    );
    document.body.append(wrap);
    const first = wrap.querySelector('input, .btn-primary, .btn-danger') as HTMLElement | null;
    if (first) first.focus();
  }

  // ── signing in ──
  function signOut(msg?: string): void {
    token = '';
    sessionStorage.removeItem('mc-admin');
    data = null;
    window.clearInterval(refresh);
    void start(msg);
  }

  async function start(msg?: string): Promise<void> {
    let status: Json;
    try {
      status = await (await fetch('/api/admin/status', { method: 'POST', body: '{}' })).json();
    } catch {
      status = { ok: false };
    }
    document.title = (status.name || 'Mana Chess') + ' – vezérlőpult';
    if (token) {
      await load();
      if (data) {
        refresh = window.setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          const a = document.activeElement;
          const typing = a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
          // never under the admin's hands: not while typing, in a dialog, or with unsaved settings
          if (!typing && !document.querySelector('.modal') && !(tab === 'settings' && settingsDirty)) void load();
        }, 5000);
        return;
      }
    }
    if (status.setup) renderSetup(msg, !!status.recovery);
    else renderLogin(msg);
  }

  function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
  }

  function authCard(title: string, lead: string, fields: HTMLElement[], button: string, submit: () => Promise<void>, msg?: string, extra?: HTMLElement): void {
    const err = h('p', { class: 'msg msg-error', hidden: !msg }, msg || '');
    const btn = h('button', { class: 'btn btn-primary btn-wide', type: 'submit' }, button) as HTMLButtonElement;
    const form = h(
      'form',
      {
        class: 'auth-card card',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          btn.disabled = true;
          try {
            await submit();
          } finally {
            btn.disabled = false;
          }
        },
      },
      h('div', { class: 'brand' }, h('span', { class: 'crest' }, '♜'), h('div', null, h('b', null, 'Mana Chess'), h('small', null, 'Vezérlőpult'))),
      h('h1', null, title),
      h('p', { class: 'lead' }, lead),
      ...fields,
      err,
      btn,
      extra ?? null,
    );
    root.replaceChildren(h('main', { class: 'auth' }, form));
    (form.querySelector('input') as HTMLInputElement | null)?.focus();
    (form as any).showError = (t: string) => {
      err.textContent = t;
      err.hidden = false;
    };
  }

  function renderLogin(msg?: string): void {
    const name = h('input', { name: 'name', autocomplete: 'username', required: true, maxlength: 20 }) as HTMLInputElement;
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }) as HTMLInputElement;
    authCard('Bejelentkezés', 'Adminisztrátori fiókkal léphetsz be.', [field('Név', name), field('Jelszó', pass)], 'Belépés', async () => {
      const r = await api('/api/auth/login', { name: name.value, password: pass.value });
      if (!r.ok) return (document.querySelector('.auth-card') as any).showError(r.error);
      if (r.me.user.role !== 'admin') {
        token = r.token;
        await api('/api/auth/logout', {});
        token = '';
        return (document.querySelector('.auth-card') as any).showError('Ez a fiók nem adminisztrátor.');
      }
      token = r.token;
      sessionStorage.setItem('mc-admin', token);
      void start();
    }, msg);
  }

  function renderSetup(msg?: string, recovery = false): void {
    const code = h('input', { name: 'code', autocomplete: 'off', required: true, placeholder: 'XXXX-XXXX', class: 'mono' }) as HTMLInputElement;
    const name = h('input', { name: 'name', autocomplete: 'username', required: true, maxlength: 20 }) as HTMLInputElement;
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true }) as HTMLInputElement;
    const pass2 = h('input', { name: 'password2', type: 'password', autocomplete: 'new-password', required: true }) as HTMLInputElement;
    authCard(
      recovery ? 'Adminisztrátor visszaállítása' : 'Első indítás',
      recovery
        ? 'A szerver --setup kapcsolóval indult. Írd be az ablakában látható beállítókódot: ha egy meglévő fiók nevét adod meg, az adminisztrátor lesz, és ezt az új jelszót kapja; új névvel új admin fiók készül.'
        : 'Hozd létre az adminisztrátori fiókot. A beállítókódot a szerver ablakában (konzolján) látod – ez bizonyítja, hogy te futtatod a szervert.',
      [field('Beállítókód', code), field('Adminisztrátor neve', name, '3–20 karakter: betű, szám, szóköz, _ . -'), field('Jelszó', pass, 'Legalább 6 karakter'), field('Jelszó még egyszer', pass2)],
      recovery ? 'Adminisztrátor beállítása' : 'Adminisztrátor létrehozása',
      async () => {
        const card = document.querySelector('.auth-card') as any;
        if (pass.value !== pass2.value) return card.showError('A két jelszó nem egyezik.');
        const r = await api('/api/admin/setup', { code: code.value, name: name.value, password: pass.value });
        if (!r.ok) return card.showError(r.error);
        token = r.token;
        sessionStorage.setItem('mc-admin', token);
        void start();
      },
      msg,
      recovery ? h('button', { type: 'button', class: 'btn btn-ghost btn-wide link-login', onclick: () => renderLogin() }, 'Belépés meglévő adminfiókkal') : undefined,
    );
  }

  async function load(): Promise<void> {
    const r = await api('/api/admin/overview');
    if (!r.ok) {
      if (r.auth !== false && token) say(r.error || 'Hiba.', 'error');
      if (/adminisztrátori jog/.test(r.error || '')) signOut('Ez a fiók nem adminisztrátor.');
      return;
    }
    data = r;
    render();
  }

  // ── the dashboard ──
  function render(): void {
    if (!data) return;
    const d = data;
    const pending = d.stats.pending as number;
    const tabs: [string, string, number?][] = [
      ['overview', 'Áttekintés'],
      ['users', 'Felhasználók', pending],
      ['settings', 'Beállítások'],
      ['security', 'Biztonság', d.bans.length + d.stats.locked],
      ['log', 'Napló'],
    ];
    const content = tab === 'users' ? usersView(d) : tab === 'settings' ? settingsView(d) : tab === 'security' ? securityView(d) : tab === 'log' ? logView(d) : overviewView(d);
    root.replaceChildren(
      h(
        'header',
        { class: 'top' },
        h('div', { class: 'brand' }, h('span', { class: 'crest' }, '♜'), h('div', null, h('b', null, d.settings.serverName), h('small', null, 'Vezérlőpult · ' + d.build))),
        h(
          'nav',
          { class: 'tabs', role: 'tablist' },
          ...tabs.map(([id, label, n]) =>
            h(
              'button',
              {
                class: 'tab' + (tab === id ? ' is-on' : ''),
                role: 'tab',
                'aria-selected': String(tab === id),
                onclick: () => {
                  tab = id;
                  history.replaceState(null, '', '#' + id);
                  settingsDirty = false;
                  render();
                },
              },
              label,
              n ? h('span', { class: 'badge' }, n) : null,
            ),
          ),
        ),
        h('div', { class: 'who' }, h('span', null, d.me.name), h('button', { class: 'btn btn-ghost', onclick: async () => { await api('/api/auth/logout', {}); signOut(); } }, 'Kijelentkezés')),
      ),
      h('main', { class: 'page' }, content),
    );
  }

  function stat(label: string, value: Kid, tone = '', onclick?: () => void): HTMLElement {
    return h(onclick ? 'button' : 'div', { class: 'stat ' + tone, onclick }, h('b', null, value), h('span', null, label));
  }

  function overviewView(d: Json): HTMLElement {
    const s = d.stats;
    const reg: Json = { closed: 'zárva', approval: 'jóváhagyással', open: 'nyitott (automatikus)' };
    const goUsers = (v: typeof userView) => () => {
      tab = 'users';
      userView = v;
      history.replaceState(null, '', '#users');
      render();
    };
    return h(
      'div',
      { class: 'stack' },
      h(
        'section',
        { class: 'stats' },
        stat('aktív játékos', s.users),
        stat('jóváhagyásra vár', s.pending, s.pending ? 'is-hot' : '', s.pending ? goUsers('pending') : undefined),
        stat('online most', s.online, 'is-mana'),
        stat('nyitott szoba', s.rooms),
        stat('zárolt fiók', s.locked, s.locked ? 'is-warn' : '', s.locked ? goUsers('locked') : undefined),
        stat('kitiltott cím', s.bans, s.bans ? 'is-warn' : ''),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'A szerver'),
        h(
          'dl',
          { class: 'facts' },
          h('dt', null, 'Regisztráció'),
          h('dd', null, reg[d.settings.registration]),
          h('dt', null, 'Vendégjáték (LAN, fiók nélkül)'),
          h('dd', null, d.settings.guests ? 'engedélyezve' : 'tiltva'),
          h('dt', null, 'Brute-force védelem'),
          h('dd', null, d.settings.maxFails + ' hibás jelszó → ' + d.settings.lockMinutes + ' perc zárolás; egy címről ' + s.ipMaxFails + ' hiba → kitiltás'),
          h('dt', null, 'Fut'),
          h('dd', null, dur(s.uptime)),
          h('dt', null, 'Cím a játékhoz'),
          h('dd', { class: 'mono' }, (d.addresses as string[]).join('  ·  ') || 'nincs megadva – Dockerben: BACKEND_PUBLIC_URL / MANA_PUBLIC_URL'),
        ),
        h(
          'p',
          { class: 'hint' },
          'Interneten (HTTPS): Nginx Proxy Manager → Proxy Hosts → Add: a domain, Forward Hostname / IP: ennek a gépnek a címe, Forward Port: a szerver portja, SSL: Let’s Encrypt tanúsítvány + Force SSL. A játékban ezután a https://domain címet kell megadni.',
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Szobák'),
        d.rooms.length
          ? h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Kód'), h('th', null, 'Házigazda'), h('th', null, 'Vendég'), h('th', null, 'Állapot'), h('th', null, 'Nyitva'))),
              h(
                'tbody',
                null,
                ...d.rooms.map((r: Json) =>
                  h(
                    'tr',
                    null,
                    h('td', { class: 'mono' }, r.code),
                    h('td', null, r.host),
                    h('td', null, r.guest || '–'),
                    h('td', null, r.running ? r.game + '. játszma fut' : r.guest ? 'vége' : 'várakozik'),
                    h('td', null, dur(r.age)),
                  ),
                ),
              ),
            )
          : h('p', { class: 'hint' }, 'Most nincs nyitott szoba.'),
      ),
    );
  }

  function usersView(d: Json): HTMLElement {
    const all = d.users as Json[];
    const f = userFilter.trim().toLocaleLowerCase('hu');
    const list = all.filter(
      (u) =>
        (!f || String(u.name).toLocaleLowerCase('hu').includes(f)) &&
        (userView === 'all' || (userView === 'pending' && u.status === 'pending') || (userView === 'locked' && u.locked > 0) || (userView === 'admin' && u.role === 'admin')),
    );
    // the half-filled form survives the 5-second refresh
    const newName = h('input', { placeholder: 'Név', maxlength: 20, autocomplete: 'off', value: draft.name, oninput: (e: Event) => (draft.name = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
    const newPass = h('input', { placeholder: 'Jelszó (min. 6)', type: 'password', autocomplete: 'new-password', value: draft.pass, oninput: (e: Event) => (draft.pass = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
    const newAdmin = h('input', { type: 'checkbox', checked: draft.admin, onchange: (e: Event) => (draft.admin = (e.target as HTMLInputElement).checked) }) as HTMLInputElement;
    const create = h(
      'form',
      {
        class: 'card inline-form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const who = newName.value;
          const r = await api('/api/admin/users/create', { name: who, password: newPass.value, role: newAdmin.checked ? 'admin' : 'user' });
          if (!r.ok) return say(r.error || 'Hiba.', 'error');
          draft.name = draft.pass = '';
          draft.admin = false;
          say('Fiók létrehozva: ' + who);
          await load();
        },
      },
      h('h2', null, 'Új felhasználó'),
      h('p', { class: 'hint' }, 'Az így létrehozott fiók azonnal használható (nem kell jóváhagyni).'),
      h('div', { class: 'row' }, newName, newPass, h('label', { class: 'check' }, newAdmin, 'adminisztrátor'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Létrehozás')),
    );
    const views: [typeof userView, string][] = [
      ['all', 'Mind (' + all.length + ')'],
      ['pending', 'Jóváhagyásra vár (' + all.filter((u) => u.status === 'pending').length + ')'],
      ['locked', 'Zárolt (' + all.filter((u) => u.locked > 0).length + ')'],
      ['admin', 'Adminok (' + all.filter((u) => u.role === 'admin').length + ')'],
    ];
    const search = h('input', {
      type: 'search',
      placeholder: 'Keresés névre…',
      value: userFilter,
      oninput: (e: Event) => {
        userFilter = (e.target as HTMLInputElement).value;
        const keep = (e.target as HTMLInputElement).selectionStart;
        render();
        const s = document.querySelector('.users-search') as HTMLInputElement | null;
        if (s) {
          s.focus();
          s.setSelectionRange(keep, keep);
        }
      },
      class: 'users-search',
    });
    const rows = list.map((u) => {
      const status =
        u.status === 'pending'
          ? h('span', { class: 'pill pill-hot' }, 'jóváhagyásra vár')
          : u.locked > 0
            ? h('span', { class: 'pill pill-warn' }, 'zárolva még ' + dur(u.locked))
            : h('span', { class: 'pill' + (u.presence !== 'offline' ? ' pill-mana' : '') }, u.presence === 'playing' ? 'játszik' : u.presence === 'online' ? 'online' : 'aktív');
      const btn = (label: string, run: () => void, tone = '') => h('button', { class: 'btn btn-sm ' + tone, onclick: run }, label);
      const actions: HTMLElement[] = [];
      if (u.status === 'pending') {
        actions.push(btn('Jóváhagyás', () => void act('/api/admin/users/approve', { id: u.id }, u.name + ' jóváhagyva.'), 'btn-primary'));
        actions.push(btn('Elutasítás', () => dialog('Elutasítod ' + u.name + ' regisztrációját?', h('p', null, 'A regisztráció törlődik.'), [{ label: 'Elutasítás', tone: 'btn-danger', run: () => act('/api/admin/users/delete', { id: u.id }, 'Elutasítva: ' + u.name) }]), 'btn-danger'));
      } else {
        if (u.locked > 0) actions.push(btn('Feloldás', () => void act('/api/admin/users/unlock', { id: u.id }, u.name + ' zárolása feloldva.'), 'btn-primary'));
        actions.push(
          btn('Új jelszó', () => {
            const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Új jelszó (min. 6)' }) as HTMLInputElement;
            dialog('Új jelszó: ' + u.name, h('div', null, h('p', { class: 'hint' }, 'A játékos minden eszközön kijelentkezik, és az új jelszóval léphet be.'), pw), [
              { label: 'Beállítás', run: () => act('/api/admin/users/password', { id: u.id, password: pw.value }, 'Új jelszó beállítva: ' + u.name) },
            ]);
          }),
        );
        if (u.id !== d.me.id)
          actions.push(
            u.role === 'admin'
              ? btn('Admin jog elvétele', () => void act('/api/admin/users/role', { id: u.id, role: 'user' }, u.name + ' mostantól játékos.'))
              : btn('Adminná tesz', () =>
                  dialog('Adminná teszed ' + u.name + ' fiókját?', h('p', null, 'Hozzáfér a vezérlőpulthoz: felhasználókat hozhat létre és törölhet, és módosíthatja a beállításokat.'), [
                    { label: 'Adminná tesz', run: () => act('/api/admin/users/role', { id: u.id, role: 'admin' }, u.name + ' mostantól adminisztrátor.') },
                  ]),
                ),
          );
        if (u.sessions) actions.push(btn('Kijelentkeztetés', () => void act('/api/admin/users/signout', { id: u.id }, u.name + ' kijelentkeztetve.')));
        if (u.id !== d.me.id)
          actions.push(
            btn(
              'Törlés',
              () =>
                dialog('Törlöd ' + u.name + ' fiókját?', h('p', null, 'A paklijai és a barátkapcsolatai is törlődnek, a futó játszmáit feladja. Ez nem vonható vissza.'), [
                  { label: 'Végleges törlés', tone: 'btn-danger', run: () => act('/api/admin/users/delete', { id: u.id }, 'Törölve: ' + u.name) },
                ]),
              'btn-danger',
            ),
          );
      }
      return h(
        'tr',
        { class: u.status === 'pending' ? 'is-pending' : '' },
        h('td', { 'data-label': 'Név' }, h('b', null, u.name), u.role === 'admin' ? h('span', { class: 'pill pill-gold' }, 'admin') : null),
        h('td', { 'data-label': 'Állapot' }, status),
        h('td', { 'data-label': 'Regisztrált' }, when(u.createdAt)),
        h('td', { 'data-label': 'Utoljára belépett' }, when(u.lastLogin)),
        h('td', { 'data-label': 'Paklik / barátok', class: 'num' }, u.decks + ' / ' + u.friends),
        h('td', { 'data-label': 'Műveletek', class: 'actions' }, ...actions),
      );
    });
    return h(
      'div',
      { class: 'stack' },
      create,
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'row between' },
          h('h2', null, 'Felhasználók'),
          h(
            'div',
            { class: 'row' },
            search,
            h(
              'div',
              { class: 'seg' },
              ...views.map(([v, label]) =>
                h(
                  'button',
                  {
                    class: 'seg-btn' + (userView === v ? ' is-on' : ''),
                    onclick: () => {
                      userView = v;
                      render();
                    },
                  },
                  label,
                ),
              ),
            ),
          ),
        ),
        list.length
          ? h(
              'table',
              { class: 'table users' },
              h('thead', null, h('tr', null, h('th', null, 'Név'), h('th', null, 'Állapot'), h('th', null, 'Regisztrált'), h('th', null, 'Utoljára belépett'), h('th', null, 'Paklik / barátok'), h('th', null, ''))),
              h('tbody', null, ...rows),
            )
          : h('p', { class: 'hint' }, userView === 'pending' ? 'Nincs jóváhagyásra váró regisztráció.' : 'Nincs ilyen felhasználó.'),
      ),
    );
  }

  function settingsView(d: Json): HTMLElement {
    const s = d.settings;
    const dirty = () => {
      settingsDirty = true;
      (document.querySelector('.save-settings') as HTMLButtonElement).disabled = false;
      const note = document.querySelector('.save-note');
      if (note) note.textContent = 'Mentetlen változások';
      document.querySelector('.sticky-save')?.classList.add('is-dirty');
    };
    const name = h('input', { value: s.serverName, maxlength: 40, oninput: dirty }) as HTMLInputElement;
    const radio = (group: string, value: string, label: string, hint: string, on: boolean) =>
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: group, value, checked: on, onchange: dirty }), h('span', null, h('b', null, label), h('small', null, hint)));
    const guests = h('input', { type: 'checkbox', checked: s.guests, onchange: dirty }) as HTMLInputElement;
    const fails = h('input', { type: 'number', min: 3, max: 20, value: s.maxFails, oninput: dirty }) as HTMLInputElement;
    const mins = h('input', { type: 'number', min: 1, max: 1440, value: s.lockMinutes, oninput: dirty }) as HTMLInputElement;
    const picked = (group: string) => (document.querySelector('input[name="' + group + '"]:checked') as HTMLInputElement | null)?.value;
    return h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const r = await api('/api/admin/settings', {
            serverName: name.value,
            registration: picked('reg'),
            guests: guests.checked,
            trustProxy: picked('proxy'),
            maxFails: Number(fails.value),
            lockMinutes: Number(mins.value),
          });
          if (!r.ok) return say(r.error || 'Hiba.', 'error');
          settingsDirty = false;
          say('Beállítások mentve.');
          await load();
        },
      },
      h('section', { class: 'card' }, h('h2', null, 'A szerver neve'), h('p', { class: 'hint' }, 'A játékosok ezt látják, amikor kapcsolódnak.'), name),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Regisztráció'),
        h(
          'div',
          { class: 'choices' },
          radio('reg', 'closed', 'Zárva', 'Senki sem regisztrálhat – fiókot csak itt, a Felhasználók lapon hozhatsz létre.', s.registration === 'closed'),
          radio('reg', 'approval', 'Jóváhagyással', 'Bárki regisztrálhat, de csak akkor léphet be, ha itt jóváhagyod.', s.registration === 'approval'),
          radio('reg', 'open', 'Nyitott', 'Bárki regisztrálhat, és azonnal játszhat (automatikus elfogadás).', s.registration === 'open'),
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Vendégjáték (LAN mód)'),
        h('label', { class: 'check big' }, guests, h('span', null, h('b', null, 'Fiók nélkül is lehet játszani'), h('small', null, 'Szobát nyitni és belépni bejelentkezés nélkül is lehet; a vendégek paklija a böngészőjükben marad. Interneten elérhető szervernél érdemes kikapcsolni.'))),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Brute-force védelem (fail2ban)'),
        h(
          'div',
          { class: 'row' },
          field('Hibás jelszavak a zárolásig', fails, '3–20'),
          field('Zárolás hossza (perc)', mins, '1–1440'),
        ),
        h('p', { class: 'hint' }, 'Ennyi hibás jelszó után a fiók bejelentkezése zárolva lesz a megadott ideig (a Felhasználók lapon feloldhatod). Egy címről érkező ' + d.stats.ipMaxFails + ' hibás próbálkozás után maga a cím is ki lesz tiltva a bejelentkezésből ugyanennyi időre.'),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Fordított proxy (Nginx Proxy Manager)'),
        h(
          'div',
          { class: 'choices' },
          radio('proxy', 'auto', 'Automatikus', 'Az X-Real-IP / X-Forwarded-For fejléceknek csak akkor hisz, ha a kérés helyi hálózatról vagy erről a gépről jön (ott fut az NPM).', s.trustProxy === 'auto'),
          radio('proxy', 'always', 'Mindig', 'Mindig a fejlécekből veszi a játékos címét – csak akkor, ha a szerver közvetlenül nem érhető el, kizárólag a proxyn át.', s.trustProxy === 'always'),
          radio('proxy', 'never', 'Soha', 'Nincs proxy: a kapcsolat címe számít.', s.trustProxy === 'never'),
        ),
        h('p', { class: 'hint' }, 'A kitiltások a játékos valódi címére vonatkoznak – proxy mögött ehhez kellenek a fejlécek.'),
      ),
      h(
        'div',
        { class: 'sticky-save' + (settingsDirty ? ' is-dirty' : '') },
        h('span', { class: 'save-note' }, settingsDirty ? 'Mentetlen változások' : 'Minden mentve'),
        h('button', { class: 'btn btn-primary save-settings', type: 'submit', disabled: !settingsDirty }, 'Mentés'),
      ),
    );
  }

  function securityView(d: Json): HTMLElement {
    const locked = (d.users as Json[]).filter((u) => u.locked > 0);
    return h(
      'div',
      { class: 'stack' },
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Zárolt fiókok'),
        h('p', { class: 'hint' }, d.settings.maxFails + ' hibás jelszó után a fiók bejelentkezése ' + d.settings.lockMinutes + ' percre zárolódik.'),
        locked.length
          ? h(
              'table',
              { class: 'table' },
              h('tbody', null, ...locked.map((u) => h('tr', null, h('td', null, h('b', null, u.name)), h('td', null, 'még ' + dur(u.locked)), h('td', { class: 'actions' }, h('button', { class: 'btn btn-sm btn-primary', onclick: () => void act('/api/admin/users/unlock', { id: u.id }, u.name + ' zárolása feloldva.') }, 'Feloldás'))))),
            )
          : h('p', { class: 'ok-note' }, 'Nincs zárolt fiók.'),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Kitiltott címek'),
        h('p', { class: 'hint' }, 'Egy címről ' + d.stats.ipMaxFails + ' hibás bejelentkezés után a cím ' + d.settings.lockMinutes + ' percig nem jelentkezhet be és nem regisztrálhat.'),
        d.bans.length
          ? h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Cím'), h('th', null, 'Ok'), h('th', null, 'Hátravan'), h('th', null, ''))),
              h('tbody', null, ...d.bans.map((b: Json) => h('tr', null, h('td', { class: 'mono' }, b.ip), h('td', null, b.reason), h('td', null, dur(b.left)), h('td', { class: 'actions' }, h('button', { class: 'btn btn-sm btn-primary', onclick: () => void act('/api/admin/bans/remove', { ip: b.ip }, b.ip + ' kitiltása feloldva.') }, 'Feloldás'))))),
            )
          : h('p', { class: 'ok-note' }, 'Nincs kitiltott cím.'),
      ),
    );
  }

  function logView(d: Json): HTMLElement {
    const lines = (d.log as string[]).slice().reverse();
    return h('section', { class: 'card' }, h('h2', null, 'Napló'), h('p', { class: 'hint' }, 'A szerver legutóbbi eseményei (a legfrissebb felül).'), h('ol', { class: 'log' }, ...lines.map((l) => h('li', null, l))));
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelector('.modal')?.remove();
  });
  void start();
}
