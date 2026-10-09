// Sichert die Board-Datenbank per VACUUM INTO (konsistent, auch waehrend die API laeuft) und
// behaelt die neuesten Staende.
//
//   node scripts/backup.mjs [grund]
//
// BOARD_DB      Datenbank, Standard data/board.db im Projektordner
// BACKUP_DIR    Zielordner, Standard ~/backups/ticket-board
// BACKUP_KEEP   Anzahl aufbewahrter Staende, Standard 14
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.resolve(root, process.env.BOARD_DB ?? 'data/board.db');
const dir = process.env.BACKUP_DIR ?? path.join(os.homedir(), 'backups', 'ticket-board');
const keep = Number(process.env.BACKUP_KEEP ?? 14);
const reason = (process.argv[2] ?? 'manuell').replace(/[^a-z0-9-]/gi, '');

if (!existsSync(source)) {
  console.error(`Keine Datenbank unter ${source}.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const target = path.join(dir, `board-${stamp}-${reason}.db`);
const db = new DatabaseSync(source, { readOnly: true });
db.prepare('VACUUM INTO ?').run(target);
db.close();

// Gegenprobe: Die Sicherung muss sich oeffnen lassen und dieselbe Ticketzahl haben.
const check = new DatabaseSync(target, { readOnly: true });
const count = check.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
const ok = check.prepare('PRAGMA integrity_check').get();
check.close();
if (Object.values(ok)[0] !== 'ok') throw new Error(`Sicherung ${target} ist beschädigt.`);

const old = readdirSync(dir)
  .filter((f) => /^board-.*\.db$/.test(f))
  .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(keep);
for (const { f } of old) rmSync(path.join(dir, f));

console.log(`Gesichert: ${target} (${count} Tickets), ${old.length} alte Stände entfernt.`);
