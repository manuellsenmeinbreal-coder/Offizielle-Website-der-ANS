# Website der ANS – Allianz für Nationale Souveränität

Offizielle Website der Roleplay-Partei **ANS** im Spiel **BwRP**: Startseite, Parteiprogramm (live editierbar), Team, Beitrittsformular, Discord-Login und ein geschütztes Admin-Panel.

Läuft **kostenlos auf Cloudflare** (Workers + D1-Datenbank). Du brauchst keinen eigenen Server.

## Ordnerstruktur

```
Offizielle Website der ANS/
├── wrangler.jsonc            # Cloudflare-Konfiguration (Database ID hier eintragen!)
├── package.json              # Abhängigkeiten (nur "wrangler")
├── .dev.vars.example         # Vorlage für lokale Zugangsdaten → als .dev.vars kopieren
├── .gitignore
├── README.md                 # diese Anleitung
├── src/
│   ├── worker.js             # Backend: Discord-Login, Admin-Prüfung, Datenbank
│   └── default-program.js    # Start-Text des Parteiprogramms (nur beim allerersten Start)
└── public/                   # Die eigentliche Website
    ├── index.html
    ├── _headers              # Sicherheits-Header
    ├── css/style.css
    ├── js/config.js          # ← Footer-Links (Discord, Community, Spiel) hier eintragen
    ├── js/app.js
    └── assets/logo.jpg, vorstand.png
```

## So funktioniert es

| Funktion | Umsetzung |
|---|---|
| Login | Discord OAuth2 (Scope `identify`). Der Login wird in einem **signierten Cookie** gespeichert, das niemand fälschen kann. |
| Admin-Prüfung | **Ausschließlich auf dem Server.** Nur die IDs `1367038661451055117` und `1413531547876851837` (in `src/worker.js` → `ADMIN_IDS`) dürfen Anträge lesen und das Programm ändern. |
| Beitrittsanträge | Werden in der D1-Datenbank gespeichert und sind mit dem Discord-Konto verknüpft. Pro Person ist nur ein offener Antrag erlaubt. |
| Parteiprogramm | Admins bearbeiten es mit Live-Vorschau. Alle Besucher sehen die Änderung automatisch innerhalb von ca. 15 Sekunden, ohne die Seite neu zu laden. |

> **GitHub Pages funktioniert nicht.** Es kann nur Dateien anzeigen und kein Backend ausführen. GitHub dient hier nur als Speicherort für den Code. Cloudflare holt sich den Code automatisch von dort.

---

## Einrichtung Schritt für Schritt

### Schritt 1: Discord Application vorbereiten
1. https://discord.com/developers/applications öffnen und deine App auswählen.
2. **OAuth2** öffnen, bei **Client Secret** auf **Reset Secret** klicken und das neue Secret kopieren.
   ⚠️ Das Secret gehört **niemals** in eine Datei, die auf GitHub landet.
3. Die **Client ID** steht bereits in `wrangler.jsonc` unter `DISCORD_CLIENT_ID`. Die Client ID ist öffentlich und darf dort stehen.

### Schritt 2: Cloudflare-Account
Unter https://dash.cloudflare.com/sign-up kostenlos registrieren. Eine Kreditkarte ist nicht nötig.

### Schritt 3: Datenbank anlegen
1. Im Cloudflare-Dashboard links **Storage & Databases** und dann **D1 SQL Database** öffnen.
2. Auf **Create Database** klicken, als Namen `ans-db` eingeben und auf **Create** klicken.
3. Die angezeigte **Database ID** kopieren. Sie sieht so aus: `a1b2c3d4-...`
4. In `wrangler.jsonc` die Nullen bei `"database_id"` durch diese ID ersetzen.

Die Tabellen legt die Website beim ersten Aufruf selbst an. Du musst dafür nichts eintippen.

### Schritt 4: Code auf GitHub hochladen
In VS Code unter *Quellcodeverwaltung* alles committen und **pushen** (Synchronisieren).

### Schritt 5: Cloudflare mit GitHub verbinden
1. Im Dashboard **Workers & Pages** öffnen und auf **Create application** klicken.
2. **Import a repository** wählen und GitHub verbinden. Dann das Repository `Offizielle-Website-der-ANS` auswählen.
3. Bei **Project name** genau `ans-website` eintragen. Der Name muss mit `"name"` in `wrangler.jsonc` übereinstimmen.
4. **Build command:** leer lassen. **Deploy command:** `npx wrangler deploy`
5. Auf **Deploy** klicken. Der erste Aufbau dauert etwa 1–2 Minuten.

Ab jetzt wird die Website bei **jedem Push auf GitHub automatisch aktualisiert**.

### Schritt 6: Geheime Zugangsdaten bei Cloudflare hinterlegen
1. Im Dashboard **Workers & Pages** öffnen, dann **ans-website**, dann **Settings** und dort **Variables and Secrets**.
2. Auf **Add** klicken, als Typ **Secret** wählen und folgende zwei Einträge anlegen:

   | Name | Wert |
   |---|---|
   | `DISCORD_CLIENT_SECRET` | das neue Secret aus Schritt 1 |
   | `SESSION_SECRET` | ein langer Zufallstext, erzeugt mit: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
3. Auf **Deploy** klicken.

### Schritt 7: Redirect bei Discord eintragen
1. Deine Website-Adresse findest du bei Cloudflare unter **ans-website**. Sie sieht so aus:
   `https://ans-website.DEIN-NAME.workers.dev`
2. Im Discord Developer Portal unter **OAuth2** → **Redirects** genau diese Adresse eintragen:
   `https://ans-website.DEIN-NAME.workers.dev/auth/discord/callback`
3. Auf **Save Changes** klicken.

### Schritt 8: GitHub Pages abschalten
Auf GitHub im Repository **Settings** → **Pages** öffnen und die Veröffentlichung deaktivieren (Source: *None* / *Unpublish*). So gibt es keine zweite, kaputte Version der Seite mehr.

### Schritt 9: Testen
Die Website öffnen und oben rechts auf **Mit Discord anmelden** klicken. Als Admin erscheint danach der rote Menüpunkt **Verwaltung**.

---

## Lokal testen (optional)

```
npm install
copy .dev.vars.example .dev.vars     # Werte eintragen
npm run dev
```
Danach http://localhost:8787 öffnen. Für den Login muss im Discord Developer Portal zusätzlich der Redirect `http://localhost:8787/auth/discord/callback` eingetragen sein. Lokal wird eine eigene Test-Datenbank verwendet, Online-Daten werden dabei nicht verändert.

## Eigene Domain (optional)
Im Dashboard **ans-website** → **Settings** → **Domains & Routes** → **Add** → **Custom domain** öffnen. Danach den neuen Redirect (`https://deine-domain.de/auth/discord/callback`) bei Discord ergänzen.

## Häufige Probleme

| Problem | Lösung |
|---|---|
| Discord meldet „Invalid OAuth2 redirect_uri“ | Der Redirect bei Discord stimmt nicht **exakt** mit der Adresse überein, unter der du die Seite aufrufst, plus `/auth/discord/callback`. |
| „Die Website ist noch nicht vollständig eingerichtet. Es fehlt: …“ | Die genannten Secrets fehlen (Schritt 6) oder die Database ID stimmt nicht (Schritt 3). |
| Deploy schlägt fehl mit Fehler zur Datenbank | Die `database_id` in `wrangler.jsonc` ist noch nicht eingetragen oder falsch. |
| Deploy schlägt fehl wegen des Namens | Der Projektname bei Cloudflare muss `ans-website` lauten, genau wie in `wrangler.jsonc`. |
| „Anmeldung fehlgeschlagen“ | `DISCORD_CLIENT_SECRET` prüfen. Die genaue Ursache steht bei Cloudflare unter **ans-website** → **Logs**. |
| Alle sind plötzlich ausgeloggt | Das passiert, wenn `SESSION_SECRET` geändert wurde. Einfach neu anmelden. |

## Weitere Admins hinzufügen
In `src/worker.js` ganz oben die Discord-ID in `ADMIN_IDS` ergänzen und pushen. Die eigene Discord-ID findest du so: Discord → Einstellungen → Erweitert → **Entwicklermodus** aktivieren, dann Rechtsklick auf deinen Namen → **Benutzer-ID kopieren**.
