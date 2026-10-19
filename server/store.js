import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Ablage der Tickets in SQLite (node:sqlite, ab Node 22.5). Eine Datei unter data/, kein
// eigener Datenbankprozess. Alle Schreibzugriffe laufen ueber diesen Server; der MCP-Server
// fuer die Agenten geht spaeter ueber die REST-API, damit es nur einen Schreiber gibt.

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const invalid = (message) => new StoreError(400, message);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY,
  number      INTEGER NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  priority    TEXT    NOT NULL,
  assignee    TEXT,
  labels      TEXT    NOT NULL DEFAULT '[]',
  backlog     INTEGER NOT NULL DEFAULT 0,
  rank        REAL    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  -- Seit wann das Ticket in einem Status der Kategorie done steht; sonst NULL.
  done_at     TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY,
  from_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE (from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS comments_ticket ON comments(ticket_id);
CREATE INDEX IF NOT EXISTS links_to ON links(to_id);
`;

const TITLE_MAX = 255;
const TEXT_MAX = 100_000;
const LABELS_MAX = 20;
const LABEL_MAX = 50;
// Unterschreitet der Abstand zweier Raenge diesen Wert, werden alle Raenge neu durchnummeriert.
const RANK_EPSILON = 1e-6;

const now = () => new Date().toISOString();

export function openStore(file, config) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const statusNames = config.statuses.map((s) => s.name);
  const categoryOf = new Map(config.statuses.map((s) => [s.name, s.category]));
  const doneStatuses = config.statuses.filter((s) => s.category === 'done').map((s) => s.name);
  const linkTypes = new Map(config.linkTypes.map((l) => [l.id, l]));
  const keyPattern = new RegExp(`^${config.projectKey}-(\\d+)$`);
  const isDone = (status) => categoryOf.get(status) === 'done';

  migrateDoneAt();

  const toKey = (number) => `${config.projectKey}-${number}`;

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function parseKey(key) {
    const match = keyPattern.exec(String(key ?? '').trim().toUpperCase());
    if (!match) throw invalid(`Ungültiger Ticketschlüssel: ${key}`);
    return Number(match[1]);
  }

  function rowByKey(key) {
    const number = parseKey(key);
    const row = db.prepare('SELECT * FROM tickets WHERE number = ?').get(number);
    if (!row) throw new StoreError(404, `Ticket ${toKey(number)} gibt es nicht.`);
    return row;
  }

  // done_at kam nach den ersten Datenbanken dazu. Fehlt die Spalte, wird sie angelegt. Danach
  // gilt bei jedem Start: Erledigte Tickets ohne Datum bekommen updated_at (Altbestand, Import),
  // offene Tickets haben kein Datum (etwa nach Aenderung der Statuskategorien in der Config).
  function migrateDoneAt() {
    const columns = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
    if (!columns.includes('done_at')) db.exec('ALTER TABLE tickets ADD COLUMN done_at TEXT');
    const placeholders = doneStatuses.map(() => '?').join(',');
    if (placeholders) {
      db.prepare(`UPDATE tickets SET done_at = updated_at WHERE done_at IS NULL AND status IN (${placeholders})`)
        .run(...doneStatuses);
      db.prepare(`UPDATE tickets SET done_at = NULL WHERE done_at IS NOT NULL AND status NOT IN (${placeholders})`)
        .run(...doneStatuses);
    } else {
      db.exec('UPDATE tickets SET done_at = NULL');
    }
  }

  // Neues done_at nach einem Statuswechsel: Wechsel innerhalb von done (Done -> Cancelled)
  // behaelt das Datum, Wechsel nach done setzt es neu, Wechsel heraus loescht es.
  function nextDoneAt(row, status, stamp) {
    if (!isDone(status)) return null;
    return isDone(row.status) && row.done_at ? row.done_at : stamp;
  }

  function nextNumber() {
    const stored = db.prepare("SELECT value FROM meta WHERE key = 'next_number'").get();
    const highest = db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM tickets').get().n;
    // Der Zaehler verhindert, dass ein geloeschter Schluessel neu vergeben wird.
    const number = Math.max(Number(stored?.value ?? 1), highest + 1);
    db.prepare("INSERT INTO meta (key, value) VALUES ('next_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(number + 1));
    return number;
  }

  function maxRank() {
    return db.prepare('SELECT COALESCE(MAX(rank), 0) AS r FROM tickets').get().r;
  }

  function touch(id) {
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now(), id);
  }

  // --- Validierung ---------------------------------------------------------------------------

  function oneOf(value, list, name) {
    if (!list.includes(value)) throw invalid(`${name} „${value}“ gibt es nicht. Erlaubt: ${list.join(', ')}`);
    return value;
  }

  function text(value, name, { required = false, max = TEXT_MAX } = {}) {
    if (typeof value !== 'string') throw invalid(`${name} muss ein Text sein.`);
    const trimmed = value.trim();
    if (required && !trimmed) throw invalid(`${name} darf nicht leer sein.`);
    if (trimmed.length > max) throw invalid(`${name} ist zu lang (höchstens ${max} Zeichen).`);
    return trimmed;
  }

  function labelList(value) {
    if (!Array.isArray(value)) throw invalid('labels muss eine Liste sein.');
    const labels = [];
    for (const raw of value) {
      const label = text(raw, 'Label', { required: true, max: LABEL_MAX });
      if (/\s/.test(label)) throw invalid(`Label „${label}“ enthält Leerzeichen.`);
      if (!labels.includes(label)) labels.push(label);
    }
    if (labels.length > LABELS_MAX) throw invalid(`Höchstens ${LABELS_MAX} Labels.`);
    return labels;
  }

  const FIELDS = {
    title: (v) => text(v, 'Titel', { required: true, max: TITLE_MAX }),
    description: (v) => text(v ?? '', 'Beschreibung'),
    status: (v) => oneOf(v, statusNames, 'Status'),
    type: (v) => oneOf(v, config.types, 'Typ'),
    priority: (v) => oneOf(v, config.priorities, 'Priorität'),
    assignee: (v) => (v === null || v === '' ? null : oneOf(v, config.assignees, 'Zuständiger')),
    labels: (v) => JSON.stringify(labelList(v)),
    backlog: (v) => {
      if (typeof v !== 'boolean') throw invalid('backlog muss true oder false sein.');
      return v ? 1 : 0;
    },
  };

  // Unbekannte Felder werden abgewiesen statt still ignoriert: Ein Agent mit Tippfehler im
  // Feldnamen soll das merken.
  function cleanFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Erwartet wird ein Objekt.');
    const out = {};
    for (const [field, value] of Object.entries(input)) {
      const clean = FIELDS[field];
      if (!clean) throw invalid(`Unbekanntes Feld: ${field}`);
      out[field] = clean(value);
    }
    return out;
  }

  // --- Ausgabe -------------------------------------------------------------------------------

  // Offene Blocker: Tickets, die ein anderes blockieren und selbst noch nicht erledigt sind.
  // Liefert je blockiertem Ticket (id) die Schluessel seiner Blocker.
  function openBlockers() {
    const blockers = new Map();
    if (!linkTypes.has('blocks')) return blockers;
    const placeholders = doneStatuses.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT l.to_id AS id, f.number FROM links l JOIN tickets f ON f.id = l.from_id
         WHERE l.type = 'blocks' ${placeholders ? `AND f.status NOT IN (${placeholders})` : ''}
         ORDER BY f.number`,
      )
      .all(...doneStatuses);
    for (const { id, number } of rows) blockers.set(id, [...(blockers.get(id) ?? []), toKey(number)]);
    return blockers;
  }

  function summary(row, blockers, commentCount) {
    return {
      key: toKey(row.number),
      title: row.title,
      status: row.status,
      statusCategory: categoryOf.get(row.status) ?? 'new',
      type: row.type,
      priority: row.priority,
      assignee: row.assignee,
      labels: JSON.parse(row.labels),
      backlog: Boolean(row.backlog),
      rank: row.rank,
      blockedBy: blockers,
      commentCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at ?? null,
    };
  }

  // --- Lesen ---------------------------------------------------------------------------------

  function listTickets(filter = {}) {
    const where = [];
    const params = [];

    if (filter.q) {
      const q = String(filter.q).trim();
      const asKey = keyPattern.exec(q.toUpperCase());
      if (asKey) {
        where.push('t.number = ?');
        params.push(Number(asKey[1]));
      } else {
        where.push('(t.title LIKE ? OR t.description LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
    }
    for (const field of ['status', 'type', 'priority', 'assignee']) {
      if (filter[field]) {
        where.push(`t.${field} = ?`);
        params.push(String(filter[field]));
      }
    }
    if (filter.label) {
      where.push('EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = ?)');
      params.push(String(filter.label));
    }
    if (filter.backlog === true || filter.backlog === false) {
      where.push('t.backlog = ?');
      params.push(filter.backlog ? 1 : 0);
    }

    const rows = db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM comments c WHERE c.ticket_id = t.id) AS comment_count
         FROM tickets t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY t.rank`,
      )
      .all(...params);

    const blockers = openBlockers();
    return rows.map((row) => summary(row, blockers.get(row.id) ?? [], row.comment_count));
  }

  function getTicket(key) {
    const row = rowByKey(key);
    const comments = db
      .prepare('SELECT id, author, body, created_at, updated_at FROM comments WHERE ticket_id = ? ORDER BY created_at, id')
      .all(row.id)
      .map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.created_at, updatedAt: c.updated_at }));

    const linkRows = db
      .prepare(
        `SELECT l.id AS link_id, l.type AS link_type, 'outward' AS direction, o.number, o.title, o.status
           FROM links l JOIN tickets o ON o.id = l.to_id WHERE l.from_id = ?
         UNION ALL
         SELECT l.id AS link_id, l.type AS link_type, 'inward' AS direction, o.number, o.title, o.status
           FROM links l JOIN tickets o ON o.id = l.from_id WHERE l.to_id = ?
         ORDER BY link_id`,
      )
      .all(row.id, row.id);

    const links = linkRows.map((l) => {
      const type = linkTypes.get(l.link_type);
      return {
        id: l.link_id,
        type: l.link_type,
        direction: l.direction,
        label: type ? type[l.direction] : l.link_type,
        ticket: {
          key: toKey(l.number),
          title: l.title,
          status: l.status,
          statusCategory: categoryOf.get(l.status) ?? 'new',
        },
      };
    });

    return {
      ...summary(row, openBlockers().get(row.id) ?? [], comments.length),
      description: row.description,
      comments,
      links,
    };
  }

  // --- Schreiben -----------------------------------------------------------------------------

  function createTicket(input) {
    const fields = cleanFields(input);
    if (fields.title === undefined) throw invalid('Titel fehlt.');

    const status = fields.status ?? statusNames[0];
    return transaction(() => {
      const number = nextNumber();
      const stamp = now();
      db.prepare(
        `INSERT INTO tickets (number, title, description, status, type, priority, assignee, labels, backlog, rank, created_at, updated_at, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        number,
        fields.title,
        fields.description ?? '',
        status,
        fields.type ?? config.defaultType,
        fields.priority ?? config.defaultPriority,
        fields.assignee ?? null,
        fields.labels ?? '[]',
        fields.backlog ?? 0,
        maxRank() + 1,
        stamp,
        stamp,
        isDone(status) ? stamp : null,
      );
      return getTicket(toKey(number));
    });
  }

  function updateTicket(key, input) {
    const fields = cleanFields(input);
    return transaction(() => {
      const row = rowByKey(key);
      const stamp = now();
      const values = { ...fields };
      if (fields.status !== undefined) values.done_at = nextDoneAt(row, fields.status, stamp);
      const names = Object.keys(values);
      if (names.length) {
        const assignments = names.map((n) => `${n} = ?`).join(', ');
        db.prepare(`UPDATE tickets SET ${assignments}, updated_at = ? WHERE id = ?`)
          .run(...names.map((n) => values[n]), stamp, row.id);
      }
      return getTicket(toKey(row.number));
    });
  }

  function renumberRanks() {
    const ids = db.prepare('SELECT id FROM tickets ORDER BY rank, id').all();
    const update = db.prepare('UPDATE tickets SET rank = ? WHERE id = ?');
    ids.forEach(({ id }, index) => update.run(index + 1, id));
  }

  // Verschiebt ein Ticket in einen Status und/oder Backlog und reiht es ein: vor `beforeKey`,
  // sonst ans Ende. Die Reihenfolge gilt je Spalte (Board) bzw. fuer den ganzen Backlog.
  function moveTicket(key, { status, backlog, beforeKey } = {}) {
    return transaction(() => {
      const row = rowByKey(key);
      const target = {
        status: status === undefined ? row.status : FIELDS.status(status),
        backlog: backlog === undefined ? row.backlog : FIELDS.backlog(backlog),
      };

      let rank = maxRank() + 1;
      if (beforeKey) {
        const before = rowByKey(beforeKey);
        if (before.id === row.id) throw invalid('Ein Ticket kann nicht vor sich selbst stehen.');
        const sameGroup = target.backlog
          ? before.backlog === 1
          : before.backlog === 0 && before.status === target.status;
        if (!sameGroup) throw invalid(`${beforeKey} steht nicht in der Zielspalte.`);

        const groupFilter = target.backlog ? 'backlog = 1' : 'backlog = 0 AND status = ?';
        const groupParams = target.backlog ? [] : [target.status];
        const rankOf = (id) => db.prepare('SELECT rank FROM tickets WHERE id = ?').get(id).rank;
        const previous = (beforeRank) =>
          db.prepare(`SELECT MAX(rank) AS r FROM tickets WHERE ${groupFilter} AND rank < ? AND id != ?`)
            .get(...groupParams, beforeRank, row.id).r;

        let beforeRank = before.rank;
        let prev = previous(beforeRank);
        if (prev !== null && beforeRank - prev < RANK_EPSILON) {
          renumberRanks();
          beforeRank = rankOf(before.id);
          prev = previous(beforeRank);
        }
        rank = prev === null ? beforeRank - 1 : (prev + beforeRank) / 2;
      }

      const stamp = now();
      db.prepare('UPDATE tickets SET status = ?, backlog = ?, rank = ?, updated_at = ?, done_at = ? WHERE id = ?')
        .run(target.status, target.backlog, rank, stamp, nextDoneAt(row, target.status, stamp), row.id);
      return getTicket(toKey(row.number));
    });
  }

  function deleteTicket(key) {
    const row = rowByKey(key);
    db.prepare('DELETE FROM tickets WHERE id = ?').run(row.id);
    return { deleted: toKey(row.number) };
  }

  // --- Kommentare ----------------------------------------------------------------------------

  function author(value) {
    return oneOf(text(value ?? '', 'Autor', { required: true, max: 50 }), config.assignees, 'Autor');
  }

  function commentRow(id) {
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(id));
    if (!row) throw new StoreError(404, `Kommentar ${id} gibt es nicht.`);
    return row;
  }

  function addComment(key, input) {
    return transaction(() => {
      const row = rowByKey(key);
      const stamp = now();
      const { lastInsertRowid } = db
        .prepare('INSERT INTO comments (ticket_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(row.id, author(input?.author), text(input?.body ?? '', 'Kommentar', { required: true }), stamp, stamp);
      touch(row.id);
      return { id: Number(lastInsertRowid), key: toKey(row.number) };
    });
  }

  function updateComment(id, input) {
    return transaction(() => {
      const comment = commentRow(id);
      db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?')
        .run(text(input?.body ?? '', 'Kommentar', { required: true }), now(), comment.id);
      touch(comment.ticket_id);
      return { id: comment.id };
    });
  }

  function deleteComment(id) {
    return transaction(() => {
      const comment = commentRow(id);
      db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
      touch(comment.ticket_id);
      return { deleted: comment.id };
    });
  }

  // --- Verknuepfungen ------------------------------------------------------------------------

  // direction 'outward': key <Art> target (EMP-1 blockiert EMP-2). 'inward': umgekehrt.
  function addLink(key, input) {
    const type = linkTypes.get(input?.type);
    if (!type) throw invalid(`Verknüpfungsart „${input?.type}“ gibt es nicht. Erlaubt: ${[...linkTypes.keys()].join(', ')}`);
    const direction = input?.direction ?? 'outward';
    if (!['outward', 'inward'].includes(direction)) throw invalid('direction muss outward oder inward sein.');

    return transaction(() => {
      const self = rowByKey(key);
      const other = rowByKey(input?.target);
      if (self.id === other.id) throw invalid('Ein Ticket kann nicht mit sich selbst verknüpft werden.');
      const [from, to] = direction === 'outward' ? [self, other] : [other, self];

      const exists = db
        .prepare('SELECT 1 FROM links WHERE type = ? AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))')
        .get(type.id, from.id, to.id, to.id, from.id);
      if (exists) throw new StoreError(409, 'Diese Verknüpfung gibt es schon.');

      const { lastInsertRowid } = db
        .prepare('INSERT INTO links (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)')
        .run(from.id, to.id, type.id, now());
      touch(from.id);
      touch(to.id);
      return { id: Number(lastInsertRowid) };
    });
  }

  function deleteLink(id) {
    return transaction(() => {
      const link = db.prepare('SELECT * FROM links WHERE id = ?').get(Number(id));
      if (!link) throw new StoreError(404, `Verknüpfung ${id} gibt es nicht.`);
      db.prepare('DELETE FROM links WHERE id = ?').run(link.id);
      touch(link.from_id);
      touch(link.to_id);
      return { deleted: link.id };
    });
  }

  return {
    listTickets,
    getTicket,
    createTicket,
    updateTicket,
    moveTicket,
    deleteTicket,
    addComment,
    updateComment,
    deleteComment,
    addLink,
    deleteLink,
    close: () => db.close(),
  };
}
