// Uebernimmt den Jira-Export (scripts/export-jira.py) in eine Board-Datenbank.
//
//   node server/import-jira.js <export.json> [ziel.db] [--replace]
//
// - Schluessel bleiben erhalten (EMP-44 bleibt EMP-44), neue Tickets zaehlen danach weiter.
// - Reihenfolge nach dem Jira-Rang, Zeitstempel aus Jira.
// - Offene Tickets (Statuskategorie "new") landen im Backlog, alle anderen auf dem Board.
// - Jira kennt nur Viktors Konto als Autor. Der echte Autor eines Kommentars wird aus seiner
//   ersten Zeile erraten (siehe guessAuthor); ohne Treffer bleibt es "Viktor".
// - Die Datenbank wird erst in einer Nebendatei gebaut und dann an ihren Platz verschoben. Eine
//   vorhandene Ziel-Datenbank wird nur mit --replace ersetzt; die API darf dabei nicht auf ihr laufen.

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.js';
import { openStore, SCHEMA } from './store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const [exportFile, target = path.join(root, 'data', 'board.db')] = args.filter((a) => a !== '--replace');
if (!exportFile) {
  console.error('Aufruf: node server/import-jira.js <export.json> [ziel.db] [--replace]');
  process.exit(2);
}
if (existsSync(target) && !replace) {
  console.error(`${target} gibt es schon. Ersetzen nur mit --replace (vorher die API auf dieser DB stoppen).`);
  process.exit(1);
}

const config = loadConfig();
const statusCategory = new Map(config.statuses.map((s) => [s.name, s.category]));
const keyPattern = new RegExp(`^${config.projectKey}-(\\d+)$`);

// "2026-09-26T00:07:59.596+0200" -> ISO in UTC wie im Board.
function isoTime(value) {
  const date = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(date.getTime())) throw new Error(`Ungültiger Zeitstempel: ${value}`);
  return date.toISOString();
}

function oneOf(value, list, what, key) {
  if (!list.includes(value)) throw new Error(`${key}: ${what} „${value}“ gibt es im Board nicht (${list.join(', ')}).`);
  return value;
}

// Erste Zeile ohne Markdown-Zeichen, klein geschrieben.
function firstLine(body) {
  return String(body ?? '').trim().split('\n', 1)[0].replace(/^[#*>\s]+/, '').replace(/\*/g, '').trim().toLowerCase();
}

// Wer hat den Kommentar geschrieben? Die Agenten haben unter Viktors Konto kommentiert, ihre
// Kommentare beginnen aber mit festen Ueberschriften. Reihenfolge der Regeln ist wichtig.
export function guessAuthor(body, labels) {
  const l = firstLine(body);
  const graphicsOnly = labels.includes('grafik') && !labels.includes('umsetzung');
  const maker = graphicsOnly ? 'artist' : 'implementer';
  const designer = labels.includes('grafik') ? 'artist' : 'game-designer';

  if (/^tester\b/.test(l)) return 'tester';
  if (/^artist\b/.test(l)) return 'artist';
  if (/^implementer\b/.test(l)) return 'implementer';
  if (/^(game[- ]designer|des designers)/.test(l)) return 'game-designer';
  const named = /\((game-designer|implementer|tester|artist)\b/.exec(l) ?? /\b(game-designer|implementer|tester|artist)\)/.exec(l);
  if (named) return named[1];
  if (l.includes('klärung der rückfrage (viktor')) return 'Viktor';
  if (l.includes('des designers')) return 'game-designer';
  if (l.includes('durch den tester')) return 'tester';
  if (/^(zweite |erneute |gesamt)?(test|prüfung|prüfbericht|abnahme|nachtest|nachprüfung|nachmessung)|^die abnahme/.test(l)) return 'tester';
  if (/^(grafik runde|aus runde|entwurfsrunde|kartenentwurf|viktors? |viktor zu|viktor hat|viktor möchte|entwürfe|die entwürfe|runde \d|\d\. runde)/.test(l)) return designer;
  if (/^(beschreibung|die beschreibung|entscheidung|designentscheidung|hinweis|vorgabe|abschluss|klärung|umgewidmet|zusammengeführt|abgrenzung|antwort von)/.test(l)) {
    return 'game-designer';
  }
  if (/^(umgesetzt|umsetzung|behoben|nachbesserung|nachtrag|findings? behoben|korrektur|ergänzung|teil \d|rückfrage|startjahr|vorschau)/.test(l) || l.includes('commit')) {
    return maker;
  }
  return 'Viktor';
}

const assigneeMap = { 'Viktor Wendel': 'Viktor' };

const issues = JSON.parse(readFileSync(exportFile, 'utf8'));
if (!Array.isArray(issues) || !issues.length) throw new Error('Export ist leer.');

// Jira-Rang (LexoRank) sortiert als Text; ohne Rang ans Ende, nach Schluessel.
const rankOf = (issue) => issue.fields?.customFields?.Rank?.value ?? `~${String(issue.key).padStart(12, '0')}`;
const ordered = [...issues].sort((a, b) => (rankOf(a) < rankOf(b) ? -1 : rankOf(a) > rankOf(b) ? 1 : 0));

const tmp = `${target}.import-${process.pid}`;
const db = new DatabaseSync(tmp);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(SCHEMA);

const insertTicket = db.prepare(
  `INSERT INTO tickets (number, title, description, status, type, priority, assignee, labels, backlog, rank, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertComment = db.prepare(
  'INSERT INTO comments (ticket_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
);

const stats = { tickets: 0, backlog: 0, comments: 0, authors: {} };
let highest = 0;
try {
  db.exec('BEGIN');
  ordered.forEach((issue, index) => {
    const f = issue.fields;
    const match = keyPattern.exec(issue.key);
    if (!match) throw new Error(`Unerwarteter Schlüssel: ${issue.key}`);
    const number = Number(match[1]);
    highest = Math.max(highest, number);

    const status = oneOf(f.status?.name, [...statusCategory.keys()], 'Status', issue.key);
    const type = oneOf(f.issuetype?.name ?? config.defaultType, config.types, 'Typ', issue.key);
    const priority = oneOf(f.priority?.name ?? config.defaultPriority, config.priorities, 'Priorität', issue.key);
    const jiraAssignee = f.assignee?.displayName ?? null;
    const assignee = jiraAssignee === null ? null : oneOf(assigneeMap[jiraAssignee] ?? jiraAssignee, config.assignees, 'Zuständiger', issue.key);
    const labels = f.labels ?? [];
    const backlog = statusCategory.get(status) === 'new' ? 1 : 0;

    const { lastInsertRowid: ticketId } = insertTicket.run(
      number, f.summary, f.description ?? '', status, type, priority, assignee,
      JSON.stringify(labels), backlog, index + 1, isoTime(f.created), isoTime(f.updated ?? f.created),
    );
    stats.tickets++;
    stats.backlog += backlog;

    const comments = [...(issue._comments ?? [])].sort((a, b) => (isoTime(a.created) < isoTime(b.created) ? -1 : 1));
    const expected = f.comment?.total ?? comments.length;
    if (comments.length !== expected) throw new Error(`${issue.key}: ${comments.length} statt ${expected} Kommentaren im Export.`);
    for (const c of comments) {
      const author = guessAuthor(c.body, labels);
      insertComment.run(ticketId, author, c.body ?? '', isoTime(c.created), isoTime(c.updated ?? c.created));
      stats.comments++;
      stats.authors[author] = (stats.authors[author] ?? 0) + 1;
    }
  });
  db.prepare("INSERT INTO meta (key, value) VALUES ('next_number', ?)").run(String(highest + 1));
  db.exec('COMMIT');
  db.close();
} catch (error) {
  db.close();
  rmSync(tmp, { force: true });
  throw error;
}

if (replace) for (const suffix of ['', '-wal', '-shm']) rmSync(target + suffix, { force: true });
renameSync(tmp, target);

// Gegenprobe ueber die normale Ablage: liest alles wie die API.
const store = openStore(target, config);
const all = store.listTickets();
const commentCount = all.reduce((sum, t) => sum + t.commentCount, 0);
if (all.length !== stats.tickets || commentCount !== stats.comments) {
  throw new Error(`Gegenprobe passt nicht: ${all.length} Tickets / ${commentCount} Kommentare gelesen.`);
}
console.log(`${stats.tickets} Tickets (${stats.backlog} im Backlog), ${stats.comments} Kommentare -> ${target}`);
console.log('Autoren:', stats.authors);
console.log(`Nächster Schlüssel: ${config.projectKey}-${highest + 1}`);
