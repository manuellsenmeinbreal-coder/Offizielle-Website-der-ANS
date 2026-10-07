# Website der ANS – Allianz für Nationale Souveränität

Offizielle Website der Roleplay-Partei **ANS** im Spiel **BwRP**: Startseite, Parteiprogramm (live editierbar), Team, Beitrittsformular, Discord-Login und ein geschütztes Admin-Panel.

## Ordnerstruktur

```
Offizielle Website der ANS/
├── server.js                 # Backend: Discord-Login, Admin-Prüfung, API, Live-Updates
├── package.json              # Abhängigkeiten (express, express-session, dotenv)
├── .env.example              # Vorlage für deine geheimen Zugangsdaten → als .env kopieren
├── .gitignore
├── README.md                 # diese Anleitung
├── content/
│   └── programm-standard.md  # Start-Text des Parteiprogramms (nur beim allerersten Start verwendet)
├── data/
│   └── db.json               # Datenbank (Programm + Anträge) – wird automatisch erstellt
└── public/                   # Alles, was der Browser lädt
    ├── index.html            # Die komplette Seite (Single-Page-App)
    ├── css/style.css         # Design
    ├── js/config.js          # ← Footer-Links (Discord, Community, Spiel) hier eintragen
    ├── js/app.js             # Frontend-Logik
    └── assets/
        ├── logo.jpg          # ANS-Logo
        └── vorstand.png      # Bild von Vorsitz & Stellv. Vorsitz
```

## So funktioniert es

| Funktion | Umsetzung |
|---|---|
| Login | Discord OAuth2 (Scope `identify`). Der Server tauscht den Code gegen ein Token und liest die Discord-ID aus. |
| Admin-Prüfung | **Ausschließlich auf dem Server.** Nur die IDs `1367038661451055117` und `1413531547876851837` (fest in `server.js` → `ADMIN_IDS`) dürfen Anträge lesen und das Programm ändern. Wer im Browser tricksen will, bekommt vom Server trotzdem nur „Kein Zugriff“. |
| Beitrittsanträge | Nur mit Discord-Login möglich und mit dem Discord-Konto verknüpft. Pro Person ist nur ein offener Antrag erlaubt. Admins können Anträge annehmen, ablehnen, wieder öffnen und löschen. Antragsteller sehen ihren Status auf der Beitrittsseite. |
| Parteiprogramm in Echtzeit | Admins bearbeiten das Programm mit Live-Vorschau. Beim Speichern landet es in `data/db.json` und wird per *Server-Sent Events* sofort an alle offenen Browser geschickt, ohne Neuladen. Wenn zwei Admins gleichzeitig bearbeiten, gibt es eine Konfliktwarnung. |

> Warum nicht Firebase? Firebase Auth unterstützt Discord nicht direkt. Man bräuchte trotzdem einen eigenen Server für den Login. Ein einziger Node.js-Server ist deshalb einfacher, kostenlos und hält alles an einem Ort.

---

## Schritt-für-Schritt-Einrichtung

### 1. Node.js installieren
Lade Node.js (LTS, mindestens Version 18) von https://nodejs.org herunter und installiere es. Prüfe danach im Terminal:
```
node -v
```

### 2. Discord Application erstellen
1. Öffne https://discord.com/developers/applications und melde dich an.
2. Klicke auf **New Application**, gib als Namen z. B. `ANS Website` ein und bestätige.
3. Optional unter **General Information**: Lade das ANS-Logo als App-Icon hoch. Das Icon erscheint im Discord-Login-Fenster.
4. Links im Menü auf **OAuth2** klicken.
5. Kopiere die **Client ID**.
6. Klicke bei **Client Secret** auf **Reset Secret** und kopiere das Secret. **Gib es niemals weiter.**
7. Klicke unter **Redirects** auf **Add Redirect** und trage exakt ein:
   - zum lokalen Testen: `http://localhost:3000/auth/discord/callback`
   - für die Online-Version zusätzlich: `https://DEINE-DOMAIN/auth/discord/callback`
8. Klicke auf **Save Changes**.

> Ein Bot ist **nicht** nötig. Die Seite fragt nur den Scope `identify` ab, also Name, Avatar und ID.

### 3. `.env` anlegen
1. Kopiere `.env.example` und nenne die Kopie `.env`.
2. Trage die Werte ein:
   ```
   PORT=3000
   BASE_URL=http://localhost:3000
   DISCORD_CLIENT_ID=deine_client_id
   DISCORD_CLIENT_SECRET=dein_client_secret
   SESSION_SECRET=langer_zufaelliger_text
   ```
3. Einen sicheren `SESSION_SECRET` erzeugst du mit:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

**Wichtig:** `BASE_URL` muss genau die Adresse sein, die du im Browser aufrufst, also nicht `127.0.0.1`, wenn dort `localhost` steht. `BASE_URL + /auth/discord/callback` muss außerdem exakt so im Discord Developer Portal eingetragen sein.

### 4. Footer-Links eintragen
Öffne `public/js/config.js` und trage deinen Discord-Einladungslink, den Link zur BwRP Community und den Link zum Spiel ein.

### 5. Starten
Im Projektordner:
```
npm install
npm start
```
Öffne dann http://localhost:3000.

### 6. Admin-Panel testen
1. Oben rechts auf **Mit Discord anmelden** klicken und bei Discord autorisieren.
2. Bist du mit einer der beiden Admin-IDs angemeldet, erscheinen der rote Menüpunkt **Verwaltung** und im Benutzermenü der Eintrag **Verwaltung (Admin-Panel)**. Alle anderen Nutzer sehen davon nichts.
3. Im Reiter **Parteiprogramm bearbeiten** den Text ändern und **Speichern & veröffentlichen** klicken (oder `Strg + S`). Öffne die Seite parallel in einem zweiten Fenster: Das Programm ändert sich dort sofort.

---

## Online stellen (Hosting)

Die Seite braucht einen Host, der dauerhaft einen **Node.js-Prozess** laufen lässt und Dateien speichern kann. Reines Static-Hosting wie GitHub Pages reicht nicht. Geeignet sind:

- **Eigener vServer / Raspberry Pi** mit Node.js und z. B. `pm2` (`npm i -g pm2 && pm2 start server.js --name ans`) hinter Nginx/Caddy mit HTTPS.
- **Railway, Render o. Ä.**: Repository hochladen, die Variablen aus `.env` dort als *Environment Variables* eintragen und für den Ordner `data/` ein persistentes Volume einrichten, damit Anträge Neustarts überleben.

Für die Online-Version:
1. In der `.env` `BASE_URL=https://deine-domain.de` setzen. Bei `https` werden Login-Cookies automatisch als „secure“ markiert.
2. Im Discord Developer Portal den Redirect `https://deine-domain.de/auth/discord/callback` hinzufügen.
3. Den Ordner `data/` regelmäßig sichern, denn dort liegen Programm und Anträge.

## Häufige Probleme

| Problem | Lösung |
|---|---|
| Discord meldet „Invalid OAuth2 redirect_uri“ | Der Redirect im Developer Portal stimmt nicht **exakt** mit `BASE_URL/auth/discord/callback` überein (auf http/https, Port und Schrägstriche achten). |
| Nach dem Login kommt „Anmeldung fehlgeschlagen“ | `DISCORD_CLIENT_SECRET` prüfen. Den genauen Grund zeigt das Server-Terminal an. |
| „Ungültige Herkunft der Anfrage“ beim Speichern | Die Seite wird unter einer anderen Adresse aufgerufen als in `BASE_URL` angegeben. |
| Nach einem Server-Neustart ist man ausgeloggt | Das ist normal, Logins werden im Arbeitsspeicher gehalten. Einfach neu anmelden. |
| Programm auf den Ursprungstext zurücksetzen | Server stoppen, in `data/db.json` den Block `program` löschen oder die ganze Datei löschen (**Achtung: dann sind auch alle Anträge weg**) und neu starten. |

## Weitere Admins hinzufügen
In `server.js` ganz oben die Discord-ID in `ADMIN_IDS` ergänzen und den Server neu starten. Die eigene Discord-ID findest du so: Discord → Einstellungen → Erweitert → **Entwicklermodus** aktivieren, dann Rechtsklick auf deinen Namen → **Benutzer-ID kopieren**.
