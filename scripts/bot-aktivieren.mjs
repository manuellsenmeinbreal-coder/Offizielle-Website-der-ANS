// Discord verlangt, dass sich ein Bot mindestens EINMAL mit dem Gateway verbindet,
// bevor er Nachrichten (z. B. DMs) senden darf. Dieses Skript erledigt das.
//
// Aufruf:  npm run bot:aktivieren
// Der Token wird aus der Datei .dev.vars gelesen (DISCORD_BOT_TOKEN=...).

import fs from 'node:fs';

function readToken() {
  try {
    const vars = fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    return vars.match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1].trim();
  } catch {
    return undefined;
  }
}

const token = readToken();
if (!token) {
  console.error('❌ Kein Bot-Token gefunden. Trage DISCORD_BOT_TOKEN=... in die Datei .dev.vars ein (siehe README).');
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('❌ Dieses Skript braucht Node.js 22 oder neuer.');
  process.exit(1);
}

const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
const timeout = setTimeout(() => {
  console.error('❌ Zeitüberschreitung – Discord hat nicht geantwortet.');
  process.exit(1);
}, 20_000);

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.op === 10) {
    ws.send(JSON.stringify({
      op: 2,
      d: { token, intents: 0, properties: { os: process.platform, browser: 'ans-website', device: 'ans-website' } },
    }));
  }
  if (msg.op === 0 && msg.t === 'READY') {
    clearTimeout(timeout);
    console.log(`✅ Bot "${msg.d.user.username}" ist aktiviert und darf jetzt DMs verschicken.`);
    ws.close(1000);
    process.exit(0);
  }
});

ws.addEventListener('close', (event) => {
  clearTimeout(timeout);
  if (event.code === 4004) console.error('❌ Der Bot-Token ist ungültig. Bitte im Developer Portal unter "Bot" neu erzeugen.');
  else console.error(`❌ Verbindung beendet (Code ${event.code}).`);
  process.exit(1);
});
