# Ticket Board

Dashboard für die Tickets des Jira-Projekts **Emperor (EMP)** und die Claude-Nutzungslimits.

## Start

```bash
npm install
npm run dev
```

Frontend läuft auf http://localhost:5173, die API auf http://localhost:8787.

## Jira-Anbindung

Die Tickets werden live über die Jira-REST-API geladen. Dafür `.env.example` nach `.env`
kopieren und ausfüllen:

- `JIRA_API_TOKEN` unter https://id.atlassian.com/manage-profile/security/api-tokens erstellen
- `JIRA_EMAIL` ist die Adresse des Atlassian-Kontos

Ohne `.env` zeigt das Dashboard einen Hinweis statt der Tickets.

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
  `usage.js` erlaubt deshalb höchstens einen Versuch pro Minute — auch nach einem Fehlschlag,
  denn sofortiges Nachfassen erzeugt nur einen 429, der den eigentlichen Fehler verdeckt.
  Scheitert ein Abruf, zeigt das Panel den letzten bekannten Wert mit dem Zeitpunkt, zu dem er
  galt, plus Warnhinweis.
- **`utilization` ist bereits ein Prozentwert** (`13.0` = 13 %), im Ereignisstrom eines
  Agentenlaufs dagegen ein Anteil (`0.13`). Das Feld `is_active` bleibt ungenutzt: Es wechselt
  zwischen den Fenstern, ohne erkennbare Bedeutung — ein zu 10 % gefülltes Fenster stand damit
  schon auf `false`.

Zusätzlich liefert der Endpunkt `seven_day_breakdown`: die Aufteilung des Wochenfensters auf
Claude Code, Chats und Cowork. Das Panel zeigt sie unter den beiden Balken.

## Implementierer starten

Jedes Ticket mit Label `umsetzung` in `To Do`, `Ready for implementation` oder `In Progress`
hat den Knopf „An Implementierer übergeben". Der Klick tut zwei Dinge:

1. **Jira vorbereiten** — das Ticket wird dem eigenen Konto zugewiesen und, falls es noch in
   `To Do` steht, nach `Ready for implementation` gezogen. Das Label wird nicht gesetzt: Es ist
   die Rollenzuordnung des Game-Designers, Tickets anderer Rollen werden abgewiesen.
2. **Claude-CLI starten** — der Server ruft `claude -p --agent implementer` im Emperor-Ordner
   (`EMPEROR_DIR`) auf. Die Sitzung läuft damit selbst als der Agent aus `.claude/agents/`,
   statt die Arbeit an einen Unteragenten zu delegieren: Nur so tauchen seine Schritte im
   Ereignisstrom auf, sonst wäre dazwischen minutenlang Stille.

Der Server liest diesen Strom (`--output-format stream-json`) zeilenweise mit und macht aus
jedem Werkzeugaufruf eine lesbare Zeile. Das Panel „Implementierer" zeigt sie fortlaufend, am
Ende das Ergebnis. Es läuft immer nur ein Lauf; die letzten fünf stehen in `data/runs.json`
und überdauern einen Serverneustart.

Voraussetzungen auf dem Rechner, auf dem der Server läuft:

- lokaler Klon von `DaVudu/Emperor`, Pfad in `EMPEROR_DIR`
- `npm install -g @anthropic-ai/claude-code`
- einmal interaktiv `claude` im Emperor-Ordner starten: `/login` mit dem claude.ai-Abo-Konto
  (für das Artifact-Tool), `/mcp` für die Atlassian-Anmeldung. Die Läufe vom Dashboard aus
  nutzen diese Anmeldungen.

Ein Lauf ohne Bediener kann keine Rückfragen beantworten, deshalb bekommt er die Werkzeuge aus
`IMPLEMENTER_ALLOWED_TOOLS` vorab freigegeben. Bricht ein Lauf mit Berechtigungsfehlern ab,
steht das fehlende Werkzeug in der Fehlermeldung im Panel.

Der Verlauf liegt in `data/runs.json`; ein Neustart des Servers beendet einen laufenden Lauf
nicht, verliert aber die Verbindung zu ihm — der Jira-Status bleibt in dem Fall die Wahrheit.

## Einrichtung auf einem anderen Rechner

1. Archiv entpacken, `npm install` ausführen (Node 18 oder neuer; Vite ist auf Version 5
   festgelegt, damit es unter Node 18 läuft).
2. `.env.example` nach `.env` kopieren und ein **neues** Jira-API-Token eintragen, statt das
   alte mitzunehmen. Das alte danach unter
   https://id.atlassian.com/manage-profile/security/api-tokens widerrufen.
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
