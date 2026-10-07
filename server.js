'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

// NUR diese Discord-IDs erhalten Zugriff auf das Admin-Panel.
const ADMIN_IDS = new Set(['1367038661451055117', '1413531547876851837']);

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET } = process.env;
const REDIRECT_URI = `${BASE_URL}/auth/discord/callback`;
const BASE_ORIGIN = new URL(BASE_URL).origin;
const IS_HTTPS = BASE_URL.startsWith('https://');
const DISCORD_API = 'https://discord.com/api/v10';

const missing = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\n[ANS] Fehlende Einstellungen in der .env-Datei: ${missing.join(', ')}`);
  console.error('[ANS] Kopiere .env.example nach .env und trage die Werte ein (siehe README.md).\n');
  process.exit(1);
}

const ACTIVITY_OPTIONS = ['Weniger als 3 Stunden', '3–7 Stunden', '7–15 Stunden', 'Mehr als 15 Stunden'];
const ENGAGEMENT_OPTIONS = [
  'Einfaches Mitglied',
  'Kandidatur / Mandat',
  'Öffentlichkeitsarbeit & Medien',
  'Organisation & Verwaltung',
];
const STATUSES = ['offen', 'angenommen', 'abgelehnt'];

// ---------------------------------------------------------------------------
// Datenbank (JSON-Datei in ./data/db.json)
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DEFAULT_PROGRAM_FILE = path.join(__dirname, 'content', 'programm-standard.md');

let db;
let writeChain = Promise.resolve();

async function loadDb() {
  try {
    db = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    db = {
      program: {
        content: await fs.readFile(DEFAULT_PROGRAM_FILE, 'utf8'),
        updatedAt: new Date().toISOString(),
        updatedBy: 'System',
      },
      applications: [],
    };
    await saveDb();
  }
}

// Schreibvorgänge nacheinander ausführen und atomar ersetzen,
// damit die Datei bei gleichzeitigen Änderungen nie beschädigt wird.
function saveDb() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, DB_FILE);
    });
  return writeChain;
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

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.globalName || user.username,
    avatarUrl: avatarUrl(user),
  };
}

const isAdmin = (user) => Boolean(user && ADMIN_IDS.has(user.id));

function text(value, { min = 0, max }) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length >= min && t.length <= max ? t : null;
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Bitte melden Sie sich zuerst mit Discord an.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  if (!isAdmin(req.session.user)) return res.status(403).json({ error: 'Kein Zugriff.' });
  next();
}

// Schutz gegen Cross-Site-Requests: Ändernde Anfragen müssen von der eigenen Seite kommen.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('origin') !== BASE_ORIGIN) {
    return res.status(403).json({ error: 'Ungültige Herkunft der Anfrage. Stimmt BASE_URL in der .env?' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Live-Updates des Parteiprogramms (Server-Sent Events)
// ---------------------------------------------------------------------------

const liveClients = new Set();

function sendProgram(res) {
  res.write(`event: program\ndata: ${JSON.stringify(db.program)}\n\n`);
}

function broadcastProgram() {
  for (const res of liveClients) sendProgram(res);
}

setInterval(() => {
  for (const res of liveClients) res.write(': ping\n\n');
}, 25_000).unref();

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: https://cdn.discordapp.com",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
});

app.use(
  session({
    name: 'ans.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_HTTPS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(sameOrigin);

// --- Discord OAuth2 --------------------------------------------------------

app.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  req.session.save(() => res.redirect(`https://discord.com/oauth2/authorize?${params}`));
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?login=abgebrochen');
  if (!code || !state || state !== req.session.oauthState) return res.redirect('/?login=fehler');
  delete req.session.oauthState;

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token-Abruf fehlgeschlagen (${tokenRes.status}): ${await tokenRes.text()}`);
    const token = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) throw new Error(`Benutzer-Abruf fehlgeschlagen (${userRes.status})`);
    const u = await userRes.json();

    // Neue Session-ID nach dem Login (Schutz vor Session-Fixation)
    req.session.regenerate((err) => {
      if (err) return res.redirect('/?login=fehler');
      req.session.user = { id: u.id, username: u.username, globalName: u.global_name, avatar: u.avatar };
      req.session.save(() => res.redirect('/?login=ok'));
    });
  } catch (err) {
    console.error('[ANS] Discord-Login fehlgeschlagen:', err.message);
    res.redirect('/?login=fehler');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ans.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  const user = req.session.user;
  res.json(user ? { user: publicUser(user), isAdmin: isAdmin(user) } : { user: null, isAdmin: false });
});

// --- Parteiprogramm --------------------------------------------------------

app.get('/api/program', (req, res) => res.json(db.program));

app.get('/api/program/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  sendProgram(res);
  liveClients.add(res);
  req.on('close', () => liveClients.delete(res));
});

app.put('/api/program', requireAdmin, async (req, res) => {
  const content = text(req.body?.content, { min: 1, max: 50_000 });
  if (content === null) return res.status(400).json({ error: 'Das Programm darf nicht leer und höchstens 50.000 Zeichen lang sein.' });

  // Schutz davor, die Änderungen eines anderen Admins unbemerkt zu überschreiben
  const base = req.body.baseUpdatedAt;
  if (base && base !== db.program.updatedAt && !req.body.force) {
    return res.status(409).json({ error: 'Das Programm wurde zwischenzeitlich geändert.', program: db.program });
  }

  db.program = {
    content,
    updatedAt: new Date().toISOString(),
    updatedBy: publicUser(req.session.user).displayName,
  };
  await saveDb();
  broadcastProgram();
  res.json(db.program);
});

// --- Beitrittsanträge ------------------------------------------------------

app.get('/api/applications/me', requireLogin, (req, res) => {
  const mine = db.applications.filter((a) => a.discord.id === req.session.user.id);
  res.json({ application: mine.at(-1) || null });
});

app.post('/api/applications', requireLogin, async (req, res) => {
  const user = req.session.user;
  const b = req.body || {};

  const existing = db.applications.find((a) => a.discord.id === user.id && a.status !== 'abgelehnt');
  if (existing) {
    const msg = existing.status === 'angenommen'
      ? 'Sie sind bereits Mitglied der ANS.'
      : 'Sie haben bereits einen offenen Antrag. Bitte warten Sie auf die Rückmeldung des Vorstands.';
    return res.status(409).json({ error: msg });
  }

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
    return res.status(400).json({ error: 'Bitte füllen Sie alle Pflichtfelder korrekt aus.', fields: invalid });
  }

  const application = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'offen',
    discord: { id: user.id, username: user.username, displayName: user.globalName || user.username },
    ...data,
    reviewedBy: null,
    reviewedAt: null,
  };
  db.applications.push(application);
  await saveDb();
  res.status(201).json({ application });
});

app.get('/api/applications', requireAdmin, (req, res) => {
  res.json({ applications: [...db.applications].reverse() });
});

app.patch('/api/applications/:id', requireAdmin, async (req, res) => {
  const application = db.applications.find((a) => a.id === req.params.id);
  if (!application) return res.status(404).json({ error: 'Antrag nicht gefunden.' });
  if (!STATUSES.includes(req.body?.status)) return res.status(400).json({ error: 'Ungültiger Status.' });

  application.status = req.body.status;
  application.reviewedBy = req.body.status === 'offen' ? null : publicUser(req.session.user).displayName;
  application.reviewedAt = req.body.status === 'offen' ? null : new Date().toISOString();
  await saveDb();
  res.json({ application });
});

app.delete('/api/applications/:id', requireAdmin, async (req, res) => {
  const index = db.applications.findIndex((a) => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Antrag nicht gefunden.' });
  db.applications.splice(index, 1);
  await saveDb();
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

// --- Statische Website -----------------------------------------------------

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error('[ANS] Serverfehler:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Interner Serverfehler.' });
});

// ---------------------------------------------------------------------------

loadDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[ANS] Website läuft auf ${BASE_URL} (Port ${PORT})`);
      console.log(`[ANS] Discord-Redirect-URL: ${REDIRECT_URI}`);
    });
  })
  .catch((err) => {
    console.error('[ANS] Datenbank konnte nicht geladen werden:', err);
    process.exit(1);
  });
