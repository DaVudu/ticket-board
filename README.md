# Ticket Board

Ticket-Board für das Projekt **Emperor (EMP)** mit den Claude-Nutzungslimits. Es ersetzt das
Jira-Board: Tickets werden hier angelegt, bearbeitet und verschoben und liegen lokal in SQLite.

## Start

```bash
npm install
npm run dev
```

Frontend läuft auf http://localhost:5173, die API auf http://localhost:8787. Nötig ist
**Node 22.5 oder neuer** (für `node:sqlite`).

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

## Einrichtung auf einem anderen Rechner

1. Archiv entpacken, `npm install` ausführen (Node 22.5 oder neuer).
2. `data/board.db` mitnehmen — darin stehen alle Tickets. Vorher den Server beenden, damit die
   Datei vollständig geschrieben ist.
3. Den Snapshot-Task neu anlegen — er ist an den Rechner gebunden und wandert nicht mit.
   In einer Claude-Code-Session im Projektordner genügt die Bitte, einen geplanten Task mit
   dem Prompt unten und dem Zeitplan `0 */2 * * *` anzulegen. Die Pfade darin an den neuen
   Ort anpassen, falls das Projekt nicht unter `C:\Projects\Board` liegt.

Prompt für den Task:

> Lies die aktuellen Claude-Plan-Limits mit dem Tool `get_usage` des MCP-Servers
> `ccd_session_mgmt` aus (Aufruf ohne Argumente, relevant ist nur der Abschnitt `plan`).
> Überschreibe `C:\Projects\Board\data\usage.json` mit einem Objekt aus `plan` (z. B. "Pro")
> und `windows`, einer Liste aus `{ label, percentUsed, resetsAt }`. Dabei wird das Fenster
> "5-hour limit" zu "5-Stunden-Limit" und "Weekly · all models" zu
> "Wochenlimit · alle Modelle"; weitere Fenster mit Originallabel anhängen. Schreibe **kein**
> Feld `updatedAt` — den Zeitpunkt ermittelt der Server aus dem Dateizeitstempel, und die
> aktuelle Uhrzeit ist dir nicht bekannt. Meldet `get_usage` den Status "unavailable" oder
> "not_applicable", lass die Datei unverändert. Ändere keine anderen Dateien.
