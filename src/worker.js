import DEFAULT_PROGRAM from './default-program.js';

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

// NUR diese Discord-IDs erhalten Zugriff auf das Admin-Panel.
const ADMIN_IDS = new Set(['1367038661451055117', '1413531547876851837']);

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'ans_session';
const STATE_COOKIE = 'ans_oauth';
const SESSION_TTL = 7 * 24 * 60 * 60; // Sekunden
const MAX_BODY = 100_000; // Bytes

const ACTIVITY_OPTIONS = ['Weniger als 3 Stunden', '3–7 Stunden', '7–15 Stunden', 'Mehr als 15 Stunden'];
const ENGAGEMENT_OPTIONS = [
  'Einfaches Mitglied',
  'Kandidatur / Mandat',
  'Öffentlichkeitsarbeit & Medien',
  'Organisation & Verwaltung',
];
const STATUSES = ['offen', 'angenommen', 'abgelehnt'];

// ---------------------------------------------------------------------------
// Datenbank (Cloudflare D1) – Tabellen werden beim ersten Aufruf automatisch angelegt
// ---------------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS program (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     content TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS applications (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'offen',
     discord_id TEXT NOT NULL,
     discord_username TEXT NOT NULL,
     discord_display_name TEXT NOT NULL,
     roblox_name TEXT NOT NULL,
     rp_name TEXT NOT NULL,
     activity TEXT NOT NULL,
     engagement TEXT NOT NULL,
     experience TEXT NOT NULL DEFAULT '',
     motivation TEXT NOT NULL,
     reviewed_by TEXT,
     reviewed_at TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_applications_discord ON applications (discord_id)',
];

let dbReady = null;

function ensureDb(env) {
  dbReady ??= env.DB.batch([
    ...SCHEMA.map((sql) => env.DB.prepare(sql)),
    env.DB.prepare('INSERT OR IGNORE INTO program (id, content, updated_at, updated_by) VALUES (1, ?, ?, ?)')
      .bind(DEFAULT_PROGRAM, new Date().toISOString(), 'System'),
  ]).catch((err) => {
    dbReady = null;
    throw err;
  });
  return dbReady;
}

const toProgram = (r) => ({ content: r.content, updatedAt: r.updated_at, updatedBy: r.updated_by });

const toApplication = (r) => ({
  id: r.id,
  createdAt: r.created_at,
  status: r.status,
  discord: { id: r.discord_id, username: r.discord_username, displayName: r.discord_display_name },
  robloxName: r.roblox_name,
  rpName: r.rp_name,
  activity: r.activity,
  engagement: r.engagement,
  experience: r.experience,
  motivation: r.motivation,
  reviewedBy: r.reviewed_by,
  reviewedAt: r.reviewed_at,
});

// ---------------------------------------------------------------------------
// Antworten & Cookies
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

const error = (status, message, extra = {}) => json({ error: message, ...extra }, status);

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(name, value, { maxAge, path = '/', secure }) {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------------------
// Signierte Cookies (HMAC-SHA256) – fälschungssicher ohne Server-Speicher
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map();

function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(secret, crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    ));
  }
  return keyCache.get(secret);
}

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function sign(payload, secret) {
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verify(token, secret) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), encoder.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(decoder.decode(fromB64url(body)));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function avatarUrl(user) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=64`;
  }
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

const displayName = (user) => user.globalName || user.username;

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: displayName(user),
  avatarUrl: avatarUrl(user),
});

const isAdmin = (user) => Boolean(user && ADMIN_IDS.has(user.id));

function text(value, { min = 0, max }) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length >= min && t.length <= max ? t : null;
}

async function readJson(request) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return null;
  try {
    const raw = await request.text();
    return raw.length > MAX_BODY ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

const requireLogin = (c, handler) =>
  c.user ? handler(c) : error(401, 'Bitte melden Sie sich zuerst mit Discord an.');

const requireAdmin = (c, handler) => {
  if (!c.user) return error(401, 'Nicht angemeldet.');
  if (!isAdmin(c.user)) return error(403, 'Kein Zugriff.');
  return handler(c);
};

// ---------------------------------------------------------------------------
// Discord OAuth2
// ---------------------------------------------------------------------------

async function startLogin(c) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: `${c.url.origin}/auth/discord/callback`,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  const stateCookie = cookie(STATE_COOKIE, await sign({ state, exp: Date.now() + 600_000 }, c.env.SESSION_SECRET), {
    maxAge: 600, path: '/auth', secure: c.secure,
  });
  return redirect(`https://discord.com/oauth2/authorize?${params}`, [stateCookie]);
}

async function finishLogin(c) {
  const { env, url } = c;
  const clearState = cookie(STATE_COOKIE, '', { maxAge: 0, path: '/auth', secure: c.secure });
  const code = url.searchParams.get('code');

  if (url.searchParams.get('error')) return redirect('/?login=abgebrochen', [clearState]);
  const saved = await verify(parseCookies(c.request)[STATE_COOKIE], env.SESSION_SECRET);
  if (!code || !saved || saved.state !== url.searchParams.get('state')) {
    return redirect('/?login=fehler', [clearState]);
  }

  let user;
  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}/auth/discord/callback`,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token-Abruf fehlgeschlagen (${tokenRes.status}): ${await tokenRes.text()}`);
    const token = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) throw new Error(`Benutzer-Abruf fehlgeschlagen (${userRes.status})`);
    const u = await userRes.json();
    user = { id: u.id, username: u.username, globalName: u.global_name, avatar: u.avatar };
  } catch (err) {
    console.error('[ANS] Discord-Login fehlgeschlagen:', err.message);
    return redirect('/?login=fehler', [clearState]);
  }

  const session = await sign({ user, exp: Date.now() + SESSION_TTL * 1000 }, env.SESSION_SECRET);
  return redirect('/?login=ok', [clearState, cookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL, secure: c.secure })]);
}

async function readSession(request, env) {
  const payload = await verify(parseCookies(request)[SESSION_COOKIE], env.SESSION_SECRET);
  return payload?.user || null;
}

// ---------------------------------------------------------------------------
// API-Endpunkte
// ---------------------------------------------------------------------------

const logout = (c) =>
  json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0, secure: c.secure }) });

const me = (c) =>
  json(c.user ? { user: publicUser(c.user), isAdmin: isAdmin(c.user) } : { user: null, isAdmin: false });

async function getProgram(c) {
  const program = toProgram(await c.env.DB.prepare('SELECT * FROM program WHERE id = 1').first());
  // Unverändert seit dem letzten Abruf → leere Antwort spart Datenvolumen
  if (c.url.searchParams.get('since') === program.updatedAt) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  return json(program);
}

async function saveProgram(c) {
  const body = await readJson(c.request);
  const content = text(body?.content, { min: 1, max: 50_000 });
  if (content === null) return error(400, 'Das Programm darf nicht leer und höchstens 50.000 Zeichen lang sein.');

  const now = new Date().toISOString();
  const by = displayName(c.user);
  // Schutz davor, die Änderungen eines anderen Admins unbemerkt zu überschreiben
  const stmt = body.force || !body.baseUpdatedAt
    ? c.env.DB.prepare('UPDATE program SET content = ?, updated_at = ?, updated_by = ? WHERE id = 1')
      .bind(content, now, by)
    : c.env.DB.prepare('UPDATE program SET content = ?, updated_at = ?, updated_by = ? WHERE id = 1 AND updated_at = ?')
      .bind(content, now, by, body.baseUpdatedAt);

  const result = await stmt.run();
  if (!result.meta.changes) {
    const current = toProgram(await c.env.DB.prepare('SELECT * FROM program WHERE id = 1').first());
    return error(409, 'Das Programm wurde zwischenzeitlich geändert.', { program: current });
  }
  return json({ content, updatedAt: now, updatedBy: by });
}

async function myApplication(c) {
  const row = await c.env.DB
    .prepare('SELECT * FROM applications WHERE discord_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(c.user.id)
    .first();
  return json({ application: row ? toApplication(row) : null });
}

async function createApplication(c) {
  const { env, user } = c;

  const existing = await env.DB
    .prepare("SELECT status FROM applications WHERE discord_id = ? AND status != 'abgelehnt' LIMIT 1")
    .bind(user.id)
    .first();
  if (existing) {
    return error(409, existing.status === 'angenommen'
      ? 'Sie sind bereits Mitglied der ANS.'
      : 'Sie haben bereits einen offenen Antrag. Bitte warten Sie auf die Rückmeldung des Vorstands.');
  }

  const b = (await readJson(c.request)) || {};
  const data = {
    robloxName: text(b.robloxName, { min: 3, max: 40 }),
    rpName: text(b.rpName, { min: 3, max: 60 }),
    activity: ACTIVITY_OPTIONS.includes(b.activity) ? b.activity : null,
    engagement: ENGAGEMENT_OPTIONS.includes(b.engagement) ? b.engagement : null,
    experience: text(b.experience ?? '', { max: 2000 }),
    motivation: text(b.motivation, { min: 30, max: 2000 }),
  };
  const invalid = Object.entries(data).filter(([, v]) => v === null).map(([k]) => k);
  if (invalid.length || b.accepted !== true) {
    return error(400, 'Bitte füllen Sie alle Pflichtfelder korrekt aus.', { fields: invalid });
  }

  const application = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'offen',
    discord: { id: user.id, username: user.username, displayName: displayName(user) },
    ...data,
    reviewedBy: null,
    reviewedAt: null,
  };
  await env.DB.prepare(
    `INSERT INTO applications (id, created_at, status, discord_id, discord_username, discord_display_name,
       roblox_name, rp_name, activity, engagement, experience, motivation)
     VALUES (?, ?, 'offen', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    application.id, application.createdAt, user.id, user.username, displayName(user),
    data.robloxName, data.rpName, data.activity, data.engagement, data.experience, data.motivation
  ).run();

  return json({ application }, 201);
}

async function listApplications(c) {
  const { results } = await c.env.DB.prepare('SELECT * FROM applications ORDER BY created_at DESC').all();
  return json({ applications: results.map(toApplication) });
}

async function updateApplication(c) {
  const body = await readJson(c.request);
  if (!STATUSES.includes(body?.status)) return error(400, 'Ungültiger Status.');

  const previous = await c.env.DB.prepare('SELECT status FROM applications WHERE id = ?').bind(c.params.id).first();
  if (!previous) return error(404, 'Antrag nicht gefunden.');

  const reopened = body.status === 'offen';
  await c.env.DB
    .prepare('UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
    .bind(body.status, reopened ? null : displayName(c.user), reopened ? null : new Date().toISOString(), c.params.id)
    .run();

  const application = toApplication(
    await c.env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(c.params.id).first()
  );

  // Bei Annahme/Ablehnung die Person per Discord-DM benachrichtigen
  let dm = null;
  if (!reopened && previous.status !== body.status) {
    dm = await sendDecisionDm(c.env, application, c.url.origin);
  }
  return json({ application, dm });
}

// ---------------------------------------------------------------------------
// Discord-Bot: DM bei Annahme/Ablehnung
// ---------------------------------------------------------------------------

const escapeMarkdown = (s) => String(s).replace(/[\\*_`~|>]/g, '\\$&');

function decisionMessage(application, origin) {
  const accepted = application.status === 'angenommen';
  const name = escapeMarkdown(application.rpName);
  return {
    embeds: [{
      title: accepted ? '✅ Beitrittsantrag angenommen' : 'Beitrittsantrag abgelehnt',
      description: accepted
        ? `Hallo **${name}**,\n\nherzlichen Glückwunsch! Ihr Beitrittsantrag bei der **Allianz für Nationale Souveränität (ANS)** wurde angenommen.\n\nWillkommen in der Partei!`
        : `Hallo **${name}**,\n\nleider wurde Ihr Beitrittsantrag bei der **Allianz für Nationale Souveränität (ANS)** abgelehnt.\n\nSie können jederzeit einen neuen Antrag auf unserer Website stellen.`,
      url: `${origin}/#beitritt`,
      color: accepted ? 0xd4a83a : 0xc8102e,
      fields: [{ name: 'Bearbeitet von', value: escapeMarkdown(application.reviewedBy || 'Bundesvorstand'), inline: true }],
      footer: { text: 'Allianz für Nationale Souveränität · BwRP' },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

async function dmFailure(res) {
  let body = {};
  try { body = await res.json(); } catch { /* keine JSON-Antwort */ }
  console.error('[ANS] Discord-DM fehlgeschlagen:', res.status, JSON.stringify(body));
  if (body.code === 50007) {
    return 'Die Person hat DMs von Servermitgliedern deaktiviert oder ist auf keinem gemeinsamen Server mit dem Bot.';
  }
  if (res.status === 401) return 'Der Bot-Token ist ungültig. Bitte DISCORD_BOT_TOKEN prüfen.';
  if (body.code === 40001 || res.status === 403) {
    return 'Der Bot darf noch keine Nachrichten senden. Bitte einmalig "npm run bot:aktivieren" ausführen (siehe README).';
  }
  if (res.status === 429) return 'Discord meldet zu viele Anfragen. Bitte später erneut versuchen.';
  return `Discord-Fehler ${res.status}.`;
}

async function sendDecisionDm(env, application, origin) {
  if (!env.DISCORD_BOT_TOKEN) {
    return { sent: false, reason: 'Der Discord-Bot ist noch nicht eingerichtet (DISCORD_BOT_TOKEN fehlt).' };
  }
  const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const channelRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST', headers, body: JSON.stringify({ recipient_id: application.discord.id }),
    });
    if (!channelRes.ok) return { sent: false, reason: await dmFailure(channelRes) };
    const channel = await channelRes.json();

    const messageRes = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: 'POST', headers, body: JSON.stringify(decisionMessage(application, origin)),
    });
    if (!messageRes.ok) return { sent: false, reason: await dmFailure(messageRes) };
    return { sent: true };
  } catch (err) {
    console.error('[ANS] Discord nicht erreichbar:', err.message);
    return { sent: false, reason: 'Discord ist gerade nicht erreichbar.' };
  }
}

async function deleteApplication(c) {
  const result = await c.env.DB.prepare('DELETE FROM applications WHERE id = ?').bind(c.params.id).run();
  if (!result.meta.changes) return error(404, 'Antrag nicht gefunden.');
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function route(c) {
  const method = c.request.method;
  const path = c.url.pathname;
  const is = (m, p) => method === m && path === p;

  if (is('GET', '/auth/discord')) return startLogin(c);
  if (is('GET', '/auth/discord/callback')) return finishLogin(c);
  if (is('POST', '/auth/logout')) return logout(c);

  if (is('GET', '/api/me')) return me(c);
  if (is('GET', '/api/program')) return getProgram(c);
  if (is('PUT', '/api/program')) return requireAdmin(c, saveProgram);

  if (is('GET', '/api/applications/me')) return requireLogin(c, myApplication);
  if (is('POST', '/api/applications')) return requireLogin(c, createApplication);
  if (is('GET', '/api/applications')) return requireAdmin(c, listApplications);

  const m = path.match(/^\/api\/applications\/([0-9a-f-]{36})$/);
  if (m) {
    c.params = { id: m[1] };
    if (method === 'PATCH') return requireAdmin(c, updateApplication);
    if (method === 'DELETE') return requireAdmin(c, deleteApplication);
  }
  return error(404, 'Nicht gefunden.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Alles außer /api und /auth ist die normale Website (Ordner public/)
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) {
      return env.ASSETS.fetch(request);
    }

    const missing = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'].filter((k) => !env[k]);
    if (!env.DB) missing.push('D1-Datenbank (Binding "DB")');
    if (missing.length) {
      return error(500, `Die Website ist noch nicht vollständig eingerichtet. Es fehlt: ${missing.join(', ')}`);
    }

    // Schutz gegen Cross-Site-Requests: Ändernde Anfragen müssen von der eigenen Seite kommen
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') !== url.origin) {
      return error(403, 'Ungültige Herkunft der Anfrage.');
    }

    try {
      await ensureDb(env);
      const c = { request, env, url, secure: url.protocol === 'https:', user: await readSession(request, env) };
      return await route(c);
    } catch (err) {
      console.error('[ANS] Serverfehler:', err);
      return error(500, 'Interner Serverfehler.');
    }
  },
};
