# Ticket Board

Ticket-Board für das Projekt **Emperor (EMP)** mit den Claude-Nutzungslimits. Es hat Jira am
09.10.2026 abgelöst: Tickets werden hier angelegt, bearbeitet und verschoben und liegen in SQLite.
Es läuft auf dem Raspberry Pi (siehe „Betrieb auf dem Pi“); die Agenten greifen über den
MCP-Server zu.

## Entwicklung

```bash
npm install --include=dev
cp ~/apps/ticket-board/data/board.db data/dev.db     # oder: node scripts/backup.mjs + Kopie
BOARD_DB=data/dev.db API_PORT=8797 node server/index.js
API_PORT=8797 ./node_modules/.bin/vite --host 127.0.0.1 --port 5173 --strictPort
```

Entwickelt wird im Entwicklungsordner (`~/projects/ticket-board`) gegen `data/dev.db`, nie gegen
die echte Datenbank. Die Oberfläche ist dann unter http://localhost:5173 erreichbar (Vite leitet
`/api` an `API_PORT` weiter). Vite mit `--host 127.0.0.1`, sonst lauscht es nur auf `::1` und
ein SSH-Tunnel auf 127.0.0.1 läuft ins Leere. Nötig ist **Node 22.5 oder neuer** (für `node:sqlite`).

## Tickets

Die Tickets liegen in `data/board.db` (SQLite, Pfad über `BOARD_DB` änderbar). Die Datei
entsteht beim ersten Start; `data/` ist nicht im Repo.

Ein Ticket hat Schlüssel (`EMP-n`, fortlaufend, ein gelöschter Schlüssel wird nicht neu
vergeben), Titel, Beschreibung (Markdown), Status, Typ, Priorität, Zuständigen, Labels,
Kommentare und Verknüpfungen zu anderen Tickets.

Was es an Status, Typen, Prioritäten, Zuständigen und Verknüpfungsarten gibt, steht in
`server/board.config.json`. Nach einer Änderung dort den Server neu starten. Ein Ticket, dessen
Status aus der Datei entfernt wurde, behält ihn; das Board nennt es dann über den Spalten.

### Board und Backlog

- **Board:** je Status eine Spalte, alle nebeneinander, auch leere. Karten lassen sich per Drag &
  Drop in eine andere Spalte und innerhalb einer Spalte umsortieren: Ein Drop auf eine Karte
  reiht davor ein, ein Drop auf freie Fläche ans Ende.
- **Backlog:** Tickets, die noch nicht aufs Board gehören, als Liste in Prioritätsreihenfolge,
  per Drag & Drop sortierbar. „Aufs Board“ holt ein Ticket in seine Statusspalte; zurück geht es
  über „Im Backlog“ im Ticket.
- **Abhängigkeiten:** Ein Ticket mit offenem Blocker (Verknüpfung „blockiert“ von einem Ticket,
  das noch nicht in einem Status der Kategorie `done` steht) bekommt auf der Karte einen roten
  Rand und den Hinweis „Blockiert von …“.

Ein Klick auf eine Karte öffnet das Ticket. Der Schlüssel steht dann im Hash der URL
(`#EMP-12`), so lässt sich ein Link auf ein Ticket teilen. Gespeichert werden nur die
geänderten Felder: Ändert ein Agent parallel ein anderes Feld, bleibt seine Änderung erhalten.

Markdown wird ohne Roh-HTML dargestellt: `<script>` und Co. erscheinen als Text, Links nur mit
`http(s):` oder `mailto:`.

### API

Alle Endpunkte unter `/api`, Antworten als JSON, Fehler als `{ error, message }`.

| Methode und Pfad | Zweck |
|---|---|
| `GET /config` | Inhalt von `board.config.json` |
| `GET /tickets?q=&status=&type=&priority=&assignee=&label=&backlog=true\|false` | Liste, sortiert nach Rang |
| `POST /tickets` | anlegen: `{ title, description?, status?, type?, priority?, assignee?, labels?, backlog? }` |
| `GET /tickets/:key` | Ticket mit Beschreibung, Kommentaren und Verknüpfungen |
| `PATCH /tickets/:key` | Felder ändern, nur die mitgeschickten |
| `DELETE /tickets/:key` | löschen, mit Kommentaren und Verknüpfungen |
| `POST /tickets/:key/move` | `{ status?, backlog?, beforeKey? }`: Spalte wechseln und einreihen |
| `POST /tickets/:key/comments` | `{ author, body }`, `author` aus der Liste der Zuständigen |
| `PATCH` / `DELETE /comments/:id` | Kommentar ändern oder löschen |
| `POST /tickets/:key/links` | `{ type, target, direction? }`: `outward` = `key` *Art* `target` |
| `DELETE /links/:id` | Verknüpfung entfernen |
| `GET /usage` | Nutzungslimits (siehe unten) |

Unbekannte Felder und Werte außerhalb von `board.config.json` werden mit 400 abgewiesen, damit
ein Tippfehler auffällt statt still verloren zu gehen.

Die API lauscht nur auf 127.0.0.1 und hat keine Authentifizierung.

### MCP-Server für die Agenten

`server/mcp.js` ist ein MCP-Server über stdio. Er schreibt nicht selbst in die Datenbank, sondern
ruft die API auf (Standard `http://127.0.0.1:8787`, änderbar mit `BOARD_API_URL`). Die API muss
also laufen. Werkzeuge:

| Werkzeug | Zweck |
|---|---|
| `board_get_config` | gültige Status, Typen, Prioritäten, Zuständige, Verknüpfungsarten |
| `board_search_tickets` | kompakte Liste, Filter `q`, `status`, `type`, `priority`, `assignee`, `label`, `backlog` |
| `board_get_ticket` | Ticket mit Beschreibung, Kommentaren, Verknüpfungen |
| `board_create_ticket` | anlegen, nur `title` ist Pflicht |
| `board_update_ticket` | Felder ändern, nur die mitgeschickten |
| `board_transition_ticket` | Status, Backlog und Position (`beforeKey`) |
| `board_add_comment` | Kommentar mit `author` (Agentenname) |
| `board_link_tickets` | `blocks` / `relates`, Richtung `outward` oder `inward` |

Löschen gibt es absichtlich nicht; das geschieht in der Oberfläche.

Die Agenten auf dem Windows-PC starten den Server per SSH, ein Tunnel ist dafür nicht nötig.
Eintrag in `.mcp.json` des Projekts:

```json
{
  "mcpServers": {
    "board": {
      "command": "ssh",
      "args": [
        "-i", "D:\\SSH\\ssh-pi5", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "vudu@192.168.178.81",
        "/home/vudu/.local/bin/node /home/vudu/apps/ticket-board/server/mcp.js"
      ]
    }
  }
}
```

Den Pfad zu `node` absolut angeben: Bei einem Befehl über SSH liest die Shell `~/.bashrc` nicht
zu Ende, `~/.local/bin` steht dann nicht im `PATH`.

### Import aus Jira

Einmalig am 09.10.2026 erledigt (181 Tickets, 507 Kommentare). Seitdem ist das Board führend, ein
erneuter Import würde alle Änderungen im Board überschreiben. Die Werkzeuge bleiben zum
Nachvollziehen im Repo:

```bash
python3 scripts/export-jira.py data/jira-export.json        # liest nur
node server/import-jira.js data/jira-export.json [ziel.db]  # nur in eine neue Datenbank
```

- Schlüssel bleiben gleich (EMP-44 bleibt EMP-44), neue Tickets zählen nach dem höchsten weiter.
- Reihenfolge nach dem Jira-Rang, Zeitstempel aus Jira; offene Tickets landen im Backlog.
- In Jira stehen alle Kommentare unter Viktors Konto. Der Autor wird aus der ersten Zeile
  erraten (`guessAuthor` in `server/import-jira.js`); ohne Treffer bleibt es Viktor.

## Nutzungslimits

Die 5-Stunden- und Wochenwerte kommen von `GET https://api.anthropic.com/api/oauth/usage`.
Der Endpunkt ist **nicht dokumentiert** und kann sich ohne Ankündigung ändern — fällt er aus,
zeigt das Panel einen Fehler, der Rest des Dashboards läuft weiter.

Authentifiziert wird mit dem OAuth-Token aus `~/.claude/.credentials.json` (Pfad über
`CLAUDE_CONFIG_DIR` überschreibbar). Der Server liest ihn bei **jedem** Abruf frisch, hält ihn
nie im Speicher und protokolliert ihn nirgends; dadurch übernimmt er automatisch den Token,
den Claude Code rotiert. Ein eigens erzeugter Token aus `claude setup-token` funktioniert
**nicht** — der Endpunkt weist ihn mit 403 ab.

Zwei Eigenheiten des Endpunkts, die im Code berücksichtigt sind:

- **Drosselung.** Schon eine zweite Abfrage wenige Sekunden nach der ersten bringt einen 429.
  `usage.js` erlaubt deshalb höchstens einen Versuch alle zwei Minuten — auch nach einem Fehlschlag,
  denn sofortiges Nachfassen erzeugt nur einen 429, der den eigentlichen Fehler verdeckt.
  Scheitert ein Abruf, zeigt das Panel den letzten bekannten Wert mit dem Zeitpunkt, zu dem er
  galt, plus Warnhinweis.
- **`utilization` ist bereits ein Prozentwert** (`13.0` = 13 %), im Ereignisstrom eines
  Agentenlaufs dagegen ein Anteil (`0.13`). Das Feld `is_active` bleibt ungenutzt: Es wechselt
  zwischen den Fenstern, ohne erkennbare Bedeutung — ein zu 10 % gefülltes Fenster stand damit
  schon auf `false`.

Zusätzlich liefert der Endpunkt `seven_day_breakdown`: die Aufteilung des Wochenfensters auf
Claude Code, Chats und Cowork. Das Panel zeigt sie unter den beiden Balken.

## Betrieb auf dem Pi

| | Betrieb | Entwicklung |
|---|---|---|
| Ordner | `~/apps/ticket-board` (Klon, immer `main`) | `~/projects/ticket-board` |
| Datenbank | `~/apps/ticket-board/data/board.db` | `data/dev.db` |
| Adresse | http://127.0.0.1:8787 (API und gebaute Oberfläche) | API 8797, Vite 5173 |
| Start | systemd-User-Dienst `ticket-board.service` | von Hand |

Der Betriebsordner wird nie direkt bearbeitet. Eine Änderung kommt so hinein:

1. Im Entwicklungsordner auf einem eigenen Branch umsetzen und gegen `dev.db` testen.
2. Nach `main` mergen und pushen.
3. Im Betriebsordner `scripts/deploy.sh`: sichert die Datenbank, holt `main`, baut und startet
   den Dienst neu. Erst damit sehen auch die Agenten (MCP-Server) den neuen Stand.

Ändert sich das Datenbankschema, braucht es eine Migration im Code: `CREATE TABLE IF NOT EXISTS`
ergänzt keine Spalten in einer bestehenden Tabelle.

**Sicherung:** `ticket-board-backup.timer` sichert täglich um 03:30 per `scripts/backup.mjs` nach
`~/backups/ticket-board/` (14 Stände, mit Integritätsprüfung), `deploy.sh` zusätzlich vor jedem
Update. Zurückspielen: Dienst stoppen, Sicherung nach `data/board.db` kopieren, `-wal`/`-shm`
daneben löschen, Dienst starten.

**Einrichtung** (einmalig, Unit-Dateien in `scripts/systemd/`):

```bash
git clone <repo> ~/apps/ticket-board && cd ~/apps/ticket-board
npm ci --include=dev && npm run build
cp scripts/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ticket-board.service ticket-board-backup.timer
```

Damit der Dienst ohne Anmeldung nach einem Neustart des Pi läuft, muss Linger an sein
(`loginctl show-user $USER -p Linger`).

Logs: `journalctl --user -u ticket-board -f`.
