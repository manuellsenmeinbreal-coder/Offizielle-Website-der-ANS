(() => {
  'use strict';

  const CFG = window.ANS_CONFIG || {};
  const VIEWS = ['start', 'programm', 'team', 'beitritt', 'admin'];
  const RETURN_KEY = 'ans.returnTo';

  const state = {
    user: null,
    isAdmin: false,
    authLoaded: false,
    view: null,
    program: null,
    applications: [],
    appFilter: 'alle',
    justChanged: null,
    editorDirty: false,
    remoteChanged: false,
    lastOwnSave: null,
  };

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** Erstellt DOM-Elemente sicher (Texte werden nie als HTML interpretiert). */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'hidden') el.hidden = true;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', headers: {}, ...options };
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* keine JSON-Antwort */ }
    if (!res.ok) {
      const err = new Error(data?.error || `Fehler ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDate = (iso) => (iso ? `${dateFmt.format(new Date(iso))} Uhr` : '–');

  const TOAST_MS = 4500;
  let toastTimer;
  function toast(message, type = '', duration = TOAST_MS) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast';
    void el.offsetWidth; // Animation (Zeitbalken) neu starten
    el.className = `toast show ${type}`;
    el.style.setProperty('--toast-ms', `${duration}ms`);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  // --- UX-Feedback-Helfer ----------------------------------------------------

  /** Startet eine CSS-Animation erneut, auch wenn die Klasse schon gesetzt war. */
  function replay(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  /** Lade-Kreisel im Button anzeigen bzw. entfernen. */
  function setBusy(btn, busy) {
    if (!btn) return;
    btn.classList.toggle('is-loading', busy);
    btn.disabled = busy;
    btn.setAttribute('aria-busy', String(busy));
  }

  /** Button kurz grün mit Erfolgsmeldung anzeigen. */
  function flashSuccess(btn, label = 'Gespeichert ✓') {
    if (!btn) return;
    btn.dataset.label ??= btn.textContent; // Originaltext nur beim ersten Mal merken
    clearTimeout(btn._successTimer);
    btn.classList.add('is-success');
    btn.textContent = label;
    btn._successTimer = setTimeout(() => {
      btn.classList.remove('is-success');
      btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
    }, 1600);
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function storage(action, key, value) {
    try {
      if (action === 'get') return sessionStorage.getItem(key);
      if (action === 'set') sessionStorage.setItem(key, value);
      if (action === 'remove') sessionStorage.removeItem(key);
    } catch { /* Speicher nicht verfügbar */ }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Mini-Markdown für das Parteiprogramm (HTML wird vorher escaped)
  // ---------------------------------------------------------------------------

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

  function inline(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>');
  }

  function renderMarkdown(src) {
    const out = [];
    let para = [];
    let list = null;
    let quote = [];

    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => {
      if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    };
    const flushQuote = () => { if (quote.length) out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`); quote = []; };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };
    const pushItem = (type, text) => {
      flushPara(); flushQuote();
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push(text);
    };

    for (const raw of String(src || '').replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushAll(); continue; }
      if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
        flushAll();
        const level = m[1].length + 1;
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushAll(); out.push('<hr>');
      } else if ((m = line.match(/^\s*[-*•]\s+(.+)$/))) {
        pushItem('ul', m[1]);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.+)$/))) {
        pushItem('ol', m[1]);
      } else if ((m = line.match(/^>\s?(.*)$/))) {
        flushPara(); flushList(); quote.push(m[1]);
      } else {
        flushList(); flushQuote(); para.push(line.trim());
      }
    }
    flushAll();
    return out.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Navigation (Hash-Router)
  // ---------------------------------------------------------------------------

  function route() {
    let view = location.hash.slice(1).split('?')[0] || 'start';
    if (!VIEWS.includes(view)) view = 'start';

    if (view === 'admin' && !state.isAdmin) {
      if (!state.authLoaded) return; // erst nach dem Login-Check entscheiden
      history.replaceState(null, '', '#start');
      view = 'start';
    }

    const changed = state.view !== view;
    state.view = view;

    for (const section of $$('.view')) section.hidden = section.dataset.view !== view;
    if (changed) replay($(`.view[data-view="${view}"]`), 'view-enter');
    for (const link of $$('[data-nav]')) {
      if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }

    const title = $(`.view[data-view="${view}"]`).dataset.title;
    document.title = view === 'start'
      ? 'Allianz für Nationale Souveränität (ANS)'
      : `${title} · ANS – Allianz für Nationale Souveränität`;

    closeNav();
    if (changed) window.scrollTo(0, 0);

    if (view === 'beitritt') renderJoin();
    if (view === 'admin') loadApplications();
  }

  function closeNav() {
    $('#mainNav').classList.remove('open');
    $('#navToggle').setAttribute('aria-expanded', 'false');
  }

  function initNav() {
    const toggle = $('#navToggle');
    toggle.addEventListener('click', () => {
      const open = !$('#mainNav').classList.contains('open');
      $('#mainNav').classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
    });
    window.addEventListener('hashchange', route);
  }

  // ---------------------------------------------------------------------------
  // Login / Benutzer
  // ---------------------------------------------------------------------------

  async function loadMe() {
    try {
      const me = await api('/api/me');
      state.user = me.user;
      state.isAdmin = me.isAdmin;
    } catch {
      state.user = null;
      state.isAdmin = false;
    }
    state.authLoaded = true;
    renderAuth();
  }

  function renderAuth() {
    const el = $('#auth');
    el.replaceChildren();
    $('.nav-admin').hidden = !state.isAdmin;

    if (!state.user) {
      el.append(
        h('a', { class: 'btn btn-discord js-login', href: '/auth/discord' },
          icon('discord'), h('span', { class: 'btn-label' }, 'Mit Discord anmelden'))
      );
      return;
    }

    const menu = h('div', { class: 'user-menu', id: 'userMenu', role: 'menu' },
      h('div', { class: 'user-menu-head' },
        'Angemeldet als',
        h('strong', {}, state.user.displayName),
        `@${state.user.username}`),
      state.isAdmin && h('a', { href: '#admin', class: 'admin-link', role: 'menuitem' }, 'Verwaltung (Admin-Panel)'),
      h('a', { href: '#beitritt', role: 'menuitem' }, 'Mein Beitrittsantrag'),
      h('button', { type: 'button', role: 'menuitem', onclick: logout }, 'Abmelden')
    );

    const button = h('button', {
      class: 'user-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'userMenu',
      onclick: (e) => {
        e.stopPropagation();
        setUserMenu(!menu.classList.contains('open'));
      },
    },
    h('img', { src: state.user.avatarUrl, alt: '', width: 32, height: 32 }),
    h('span', { class: 'user-name' }, state.user.displayName),
    icon('chevron'));

    menu.addEventListener('click', () => setUserMenu(false));
    el.append(button, menu);
  }

  function setUserMenu(open) {
    const menu = $('#userMenu');
    if (!menu) return false;
    const wasOpen = menu.classList.contains('open');
    menu.classList.toggle('open', open);
    $('.user-btn')?.setAttribute('aria-expanded', String(open));
    return wasOpen;
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.auth')) setUserMenu(false);

    // Login: Lade-Kreisel, bis Discord sich öffnet; Rücksprungziel merken
    const login = e.target.closest('.js-login');
    if (login) {
      storage('set', RETURN_KEY, location.hash || '#start');
      login.classList.add('is-loading');
    }

    // "Nach oben" und "Zum Inhalt springen" dürfen den Hash-Router nicht auslösen
    const toTop = e.target.closest('[data-to-top]');
    if (toTop) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    if (e.target.closest('.skip-link')) {
      e.preventDefault();
      $('#main').focus();
    }
  });

  // Zurück-Taste nach dem Discord-Login: Lade-Zustand zurücksetzen
  window.addEventListener('pageshow', () => $$('.js-login.is-loading').forEach((b) => b.classList.remove('is-loading')));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (setUserMenu(false)) $('.user-btn')?.focus();
    closeNav();
  });

  function initThemeToggle() {
    const btn = $('#themeToggle');
    const sync = () => {
      const dark = window.ANS_THEME?.get() === 'dark';
      btn.setAttribute('aria-pressed', String(dark));
      btn.setAttribute('aria-label', dark ? 'Helles Design aktivieren' : 'Dunkles Design aktivieren');
      btn.title = dark ? 'Helles Design' : 'Dunkles Design';
    };
    btn.addEventListener('click', () => {
      const root = document.documentElement;
      root.classList.add('theme-switching');
      window.ANS_THEME.set(window.ANS_THEME.get() === 'dark' ? 'light' : 'dark');
      sync();
      setTimeout(() => root.classList.remove('theme-switching'), 400);
    });
    // Systemeinstellung geändert (ohne eigene Wahl)
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(sync));
    sync();
  }

  function initToTop() {
    const btn = $('#toTop');
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        btn.classList.toggle('show', window.scrollY > 600);
        ticking = false;
      });
    }, { passive: true });
  }

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch { /* Session ist ohnehin weg */ }
    state.user = null;
    state.isAdmin = false;
    renderAuth();
    toast('Sie wurden abgemeldet.');
    route();
  }

  function handleLoginResult() {
    const params = new URLSearchParams(location.search);
    const result = params.get('login');
    if (!result) return;

    const returnTo = storage('get', RETURN_KEY) || location.hash || '#start';
    storage('remove', RETURN_KEY);
    history.replaceState(null, '', `${location.pathname}${returnTo}`);

    if (result === 'ok') toast(`Willkommen, ${state.user?.displayName ?? ''}!`, 'success');
    else if (result === 'abgebrochen') toast('Die Anmeldung wurde abgebrochen.');
    else toast('Die Anmeldung ist fehlgeschlagen. Bitte versuchen Sie es erneut.', 'error');
  }

  // ---------------------------------------------------------------------------
  // Parteiprogramm (öffentlich, live)
  // ---------------------------------------------------------------------------

  function renderProgram({ flash = false } = {}) {
    if (!state.program) return;
    const doc = $('#programDoc');
    doc.innerHTML = renderMarkdown(state.program.content);
    doc.setAttribute('aria-busy', 'false');
    $('#programMeta').textContent = `Stand: ${fmtDate(state.program.updatedAt)} · zuletzt bearbeitet von ${state.program.updatedBy}`;
    if (flash) replay(doc, 'program-flash');
  }

  function applyProgram(program) {
    const isUpdate = state.program && program.updatedAt !== state.program.updatedAt;
    const ownSave = program.updatedAt === state.lastOwnSave;
    state.program = program;
    renderProgram({ flash: isUpdate });
    if (isUpdate && !ownSave && state.view === 'programm') toast('Das Parteiprogramm wurde soeben aktualisiert.');
    syncEditorFromRemote(isUpdate && !ownSave);
  }

  // Prüft regelmäßig auf Änderungen – nur solange der Tab sichtbar ist.
  const POLL_MS = 15_000;
  let pollTimer = null;
  let polling = false;

  async function pollProgram() {
    clearTimeout(pollTimer);
    if (polling || document.hidden) return;
    polling = true;
    const dot = $('#liveDot');
    try {
      const since = state.program ? `?since=${encodeURIComponent(state.program.updatedAt)}` : '';
      const program = await api(`/api/program${since}`);
      if (program) applyProgram(program);
      dot.classList.add('on');
      dot.title = 'Live – Änderungen erscheinen automatisch';
    } catch {
      dot.classList.remove('on');
      dot.title = 'Keine Verbindung – neuer Versuch …';
      if (!state.program) {
        $('#programDoc').replaceChildren(h('p', { class: 'muted' }, 'Das Parteiprogramm konnte nicht geladen werden.'));
      }
    } finally {
      polling = false;
    }
    pollTimer = setTimeout(pollProgram, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollProgram(); });

  // ---------------------------------------------------------------------------
  // Beitrittsformular
  // ---------------------------------------------------------------------------

  const STATUS_TEXT = {
    offen: ['Ihr Antrag wird geprüft', 'Der Bundesvorstand prüft Ihren Antrag. Sie erhalten eine Rückmeldung über Discord.'],
    angenommen: ['Willkommen in der ANS!', 'Ihr Antrag wurde angenommen. Sie sind jetzt Mitglied der Allianz für Nationale Souveränität.'],
    abgelehnt: ['Ihr Antrag wurde abgelehnt', 'Sie können unten einen neuen Antrag stellen.'],
  };

  function statusBox(application) {
    const [title, text] = STATUS_TEXT[application.status];
    return h('div', { class: `status-box status-${application.status}` },
      h('h3', {}, title),
      h('p', {}, text),
      h('p', { class: 'hint' }, `Eingereicht am ${fmtDate(application.createdAt)}`));
  }

  async function renderJoin() {
    const login = $('#joinLogin');
    const status = $('#joinStatus');
    const form = $('#joinForm');

    if (!state.authLoaded) return;
    if (!state.user) {
      login.hidden = false; status.hidden = true; form.hidden = true;
      return;
    }
    login.hidden = true;
    $('#fDiscord').value = `${state.user.displayName} (@${state.user.username})`;

    let application = null;
    try {
      ({ application } = await api('/api/applications/me'));
    } catch { /* Formular trotzdem anzeigen */ }

    status.replaceChildren();
    if (application) {
      status.append(statusBox(application));
      status.hidden = false;
    } else {
      status.hidden = true;
    }
    form.hidden = Boolean(application && application.status !== 'abgelehnt');
  }

  function initJoinForm() {
    const form = $('#joinForm');
    const motivation = $('#fMotivation');
    const errorBox = $('#joinError');

    const updateCount = () => {
      const length = motivation.value.trim().length;
      $('#motivationCount').textContent = length;
      $('#motivationCount').parentElement.classList.toggle('ok', length >= 30);
    };
    motivation.addEventListener('input', updateCount);
    form.addEventListener('input', (e) => e.target.classList?.remove('invalid'));
    form.addEventListener('change', (e) => e.target.classList?.remove('invalid'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.hidden = true;

      const fields = $$('input[required], select[required], textarea[required]', form);
      const invalid = fields.filter((f) => (f.type === 'checkbox' ? !f.checked : !f.checkValidity() || !f.value.trim()));
      fields.forEach((f) => f.classList.toggle('invalid', invalid.includes(f)));
      if (invalid.length) {
        errorBox.textContent = 'Bitte füllen Sie alle markierten Pflichtfelder korrekt aus.';
        errorBox.hidden = false;
        invalid.forEach((f) => replay(f.closest('.field') || f.closest('.check'), 'shake'));
        invalid[0].focus();
        return;
      }

      const fd = new FormData(form);
      const body = {
        robloxName: fd.get('robloxName'),
        rpName: fd.get('rpName'),
        activity: fd.get('activity'),
        engagement: fd.get('engagement'),
        experience: fd.get('experience'),
        motivation: fd.get('motivation'),
        accepted: fd.get('accepted') === 'on',
      };

      const submit = $('button[type="submit"]', form);
      setBusy(submit, true);
      try {
        await api('/api/applications', { method: 'POST', body });
        form.reset();
        updateCount();
        toast('Ihr Beitrittsantrag wurde erfolgreich übermittelt.', 'success');
        await renderJoin();
        window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
      } catch (err) {
        if (err.status === 401) { await loadMe(); renderJoin(); }
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        replay(submit, 'shake');
      } finally {
        setBusy(submit, false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Admin: Tabs
  // ---------------------------------------------------------------------------

  function initTabs() {
    const tabs = $$('.tab');
    const select = (tab) => {
      for (const t of tabs) {
        const active = t === tab;
        t.setAttribute('aria-selected', String(active));
        t.tabIndex = active ? 0 : -1;
        $(`#${t.getAttribute('aria-controls')}`).hidden = !active;
      }
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        select(next);
        next.focus();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Admin: Beitrittsanträge
  // ---------------------------------------------------------------------------

  async function loadApplications() {
    if (!state.isAdmin) return;
    if (!state.applications.length) {
      $('#appList').replaceChildren(h('div', { class: 'skeleton', 'aria-label': 'Anträge werden geladen …' },
        h('span', { class: 'sk sk-card' }), h('span', { class: 'sk sk-card' })));
    }
    try {
      ({ applications: state.applications } = await api('/api/applications'));
      renderApplications();
    } catch (err) {
      handleAdminError(err);
    }
  }

  function handleAdminError(err) {
    if (err.status === 401 || err.status === 403) {
      toast('Ihre Sitzung ist abgelaufen oder Sie haben keinen Zugriff.', 'error');
      loadMe().then(route);
    } else {
      toast(err.message, 'error');
    }
  }

  function renderApplications() {
    const open = state.applications.filter((a) => a.status === 'offen').length;
    const count = $('#openCount');
    if (count.textContent !== String(open)) replay(count, 'pop');
    count.textContent = open;
    count.classList.toggle('zero', open === 0);

    const list = $('#appList');
    const shown = state.appFilter === 'alle'
      ? state.applications
      : state.applications.filter((a) => a.status === state.appFilter);

    if (!shown.length) {
      list.replaceChildren(h('p', { class: 'empty' },
        state.applications.length ? 'Keine Anträge mit diesem Status.' : 'Es sind noch keine Beitrittsanträge eingegangen.'));
      return;
    }
    list.replaceChildren(...shown.map(applicationCard));
  }

  function applicationCard(a) {
    const action = (label, cls, status) =>
      a.status !== status && h('button', {
        type: 'button', class: `btn btn-sm ${cls}`, onclick: (e) => setStatus(a, status, e.currentTarget),
      }, label);
    const justChanged = a.id === state.justChanged;

    return h('article', { class: 'app', 'data-status': a.status, 'data-id': a.id },
      h('div', { class: 'app-head' },
        h('div', {},
          h('h3', {}, a.rpName),
          h('span', { class: 'sub' }, `Eingereicht am ${fmtDate(a.createdAt)}`)),
        h('span', { class: `pill pill-${a.status}${justChanged ? ' pop' : ''}` }, a.status)),
      h('dl', { class: 'app-meta' },
        h('div', {}, h('dt', {}, 'Discord'), h('dd', {}, `${a.discord.displayName} (@${a.discord.username})`)),
        h('div', {}, h('dt', {}, 'Discord-ID'), h('dd', {}, a.discord.id)),
        h('div', {}, h('dt', {}, 'Roblox'), h('dd', {}, a.robloxName)),
        h('div', {}, h('dt', {}, 'Aktivität / Woche'), h('dd', {}, a.activity)),
        h('div', {}, h('dt', {}, 'Engagement'), h('dd', {}, a.engagement))),
      h('div', { class: 'app-text' }, h('h4', {}, 'Motivation'), h('p', {}, a.motivation)),
      a.experience && h('div', { class: 'app-text' }, h('h4', {}, 'Politische Erfahrung'), h('p', {}, a.experience)),
      h('div', { class: 'app-foot' },
        h('p', { class: 'reviewed' }, a.reviewedBy ? `Bearbeitet von ${a.reviewedBy} am ${fmtDate(a.reviewedAt)}` : 'Noch nicht bearbeitet'),
        h('div', { class: 'app-actions' },
          action('Annehmen', 'btn-primary', 'angenommen'),
          action('Ablehnen', 'btn-red', 'abgelehnt'),
          action('Wieder öffnen', 'btn-outline', 'offen'),
          h('button', {
            type: 'button', class: 'btn btn-sm btn-danger-text', onclick: (e) => removeApplication(a, e.currentTarget),
          }, 'Löschen'))));
  }

  async function setStatus(a, status, button) {
    setBusy(button, true);
    try {
      const { application, dm } = await api(`/api/applications/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { status } });
      Object.assign(a, application);
      state.justChanged = a.id;
      renderApplications();
      state.justChanged = null;
      if (!dm) toast(`Antrag von ${a.rpName}: ${status}.`, 'success');
      else if (dm.sent) toast(`Antrag von ${a.rpName}: ${status}. Discord-DM wurde verschickt.`, 'success');
      else toast(`Status gespeichert, aber keine DM verschickt: ${dm.reason}`, 'error', 9000);
    } catch (err) {
      setBusy(button, false);
      handleAdminError(err);
    }
  }

  async function removeApplication(a, button) {
    if (!confirm(`Antrag von „${a.rpName}“ endgültig löschen?`)) return;
    setBusy(button, true);
    try {
      await api(`/api/applications/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
      const card = button.closest('.app');
      card.classList.add('leaving');
      if (!reducedMotion()) await wait(250);
      state.applications = state.applications.filter((x) => x.id !== a.id);
      renderApplications();
      toast('Antrag gelöscht.');
    } catch (err) {
      setBusy(button, false);
      handleAdminError(err);
    }
  }

  function initApplicationTools() {
    $('#appFilter').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-filter]');
      if (!btn) return;
      state.appFilter = btn.dataset.filter;
      $$('#appFilter button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderApplications();
    });
    $('#reloadApps').addEventListener('click', async (e) => {
      const button = e.currentTarget;
      setBusy(button, true);
      await loadApplications();
      setBusy(button, false);
      flashSuccess(button, 'Aktualisiert ✓');
    });
  }

  // ---------------------------------------------------------------------------
  // Admin: Programm-Editor
  // ---------------------------------------------------------------------------

  const editor = () => $('#programEditor');

  function updatePreview() {
    $('#programPreview').innerHTML = renderMarkdown(editor().value);
  }

  function updateEditorStatus() {
    const status = $('#editorStatus');
    status.classList.toggle('dirty', state.editorDirty && !state.remoteChanged);
    status.classList.toggle('conflict', state.remoteChanged);
    if (state.remoteChanged) {
      status.textContent = `Achtung: ${state.program.updatedBy} hat das Programm zwischenzeitlich geändert.`;
    } else if (state.editorDirty) {
      status.textContent = 'Ungespeicherte Änderungen';
    } else {
      status.textContent = `Veröffentlicht · ${fmtDate(state.program?.updatedAt)}`;
    }
    $('#saveProgram').disabled = !state.editorDirty;
    $('#revertProgram').disabled = !state.editorDirty;
  }

  function syncEditorFromRemote(changedByOther) {
    if (!state.editorDirty) {
      editor().value = state.program.content;
      updatePreview();
      state.remoteChanged = false;
    } else if (changedByOther) {
      state.remoteChanged = true;
    }
    updateEditorStatus();
  }

  async function saveProgram(force = false) {
    if (!state.editorDirty) return;
    const button = $('#saveProgram');
    setBusy(button, true);
    try {
      const program = await api('/api/program', {
        method: 'PUT',
        body: { content: editor().value, baseUpdatedAt: state.program.updatedAt, force },
      });
      state.lastOwnSave = program.updatedAt;
      state.editorDirty = false;
      state.remoteChanged = false;
      setBusy(button, false);
      applyProgram(program);
      flashSuccess(button, 'Veröffentlicht ✓');
      toast('Parteiprogramm gespeichert und live veröffentlicht.', 'success');
    } catch (err) {
      setBusy(button, false);
      replay(button, 'shake');
      if (err.status === 409) {
        state.program = err.data.program;
        renderProgram();
        if (confirm(`${state.program.updatedBy} hat das Programm in der Zwischenzeit geändert.\n\nMöchten Sie dessen Version mit Ihrer überschreiben?`)) {
          return saveProgram(true);
        }
        state.remoteChanged = true;
      } else {
        handleAdminError(err);
      }
      updateEditorStatus();
    }
  }

  function initEditor() {
    const ta = editor();
    ta.addEventListener('input', () => {
      state.editorDirty = ta.value !== state.program?.content;
      if (!state.editorDirty) state.remoteChanged = false;
      updatePreview();
      updateEditorStatus();
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveProgram();
      }
    });
    $('#saveProgram').addEventListener('click', () => saveProgram());
    $('#revertProgram').addEventListener('click', () => {
      if (!confirm('Alle ungespeicherten Änderungen verwerfen?')) return;
      state.editorDirty = false;
      syncEditorFromRemote(false);
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.editorDirty) e.preventDefault();
    });
  }

  // ---------------------------------------------------------------------------
  // Footer & Start
  // ---------------------------------------------------------------------------

  function initFooter() {
    const links = CFG.links || {};
    const map = { linkDiscord: links.discord, linkDiscordCta: links.discord, linkCommunity: links.community, linkGame: links.game };
    for (const [id, url] of Object.entries(map)) {
      if (url) $(`#${id}`).href = url;
    }
    $('#year').textContent = new Date().getFullYear();
  }

  async function init() {
    initNav();
    initFooter();
    initJoinForm();
    initTabs();
    initApplicationTools();
    initEditor();
    initToTop();
    initThemeToggle();
    renderAuth();
    route();

    pollProgram();
    await loadMe();
    handleLoginResult();
    route();
  }

  init();
})();
