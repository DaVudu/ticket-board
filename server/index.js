import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { openStore, StoreError } from './store.js';
import { getUsage, initUsage } from './usage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.API_PORT ?? 8787;

const config = loadConfig();
const store = openStore(process.env.BOARD_DB ?? path.join(root, 'data', 'board.db'), config);

const app = express();
app.use(express.json({ limit: '1mb' }));

// Wandelt Fehler der Ablage in HTTP-Antworten; alles andere ist ein Serverfehler.
function handle(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result !== undefined) res.json(result);
    } catch (error) {
      if (error instanceof StoreError) {
        res.status(error.status).json({ error: 'request_failed', message: error.message });
      } else {
        console.error(error);
        res.status(500).json({ error: 'internal_error', message: error.message });
      }
    }
  };
}

// "true"/"false" aus der Query, alles andere heisst: nicht filtern.
function flag(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function created(res, body) {
  res.status(201).json(body);
}

app.get('/api/config', handle(() => config));

app.get(
  '/api/tickets',
  handle((req) => {
    const { q, status, type, priority, assignee, label, backlog } = req.query;
    return {
      fetchedAt: new Date().toISOString(),
      tickets: store.listTickets({ q, status, type, priority, assignee, label, backlog: flag(backlog) }),
    };
  }),
);

app.post('/api/tickets', handle((req, res) => created(res, store.createTicket(req.body))));
app.get('/api/tickets/:key', handle((req) => store.getTicket(req.params.key)));
app.patch('/api/tickets/:key', handle((req) => store.updateTicket(req.params.key, req.body)));
app.delete('/api/tickets/:key', handle((req) => store.deleteTicket(req.params.key)));

// Status, Backlog und Reihenfolge: { status?, backlog?, beforeKey? }
app.post('/api/tickets/:key/move', handle((req) => store.moveTicket(req.params.key, req.body ?? {})));

// { author, body }
app.post('/api/tickets/:key/comments', handle((req, res) => created(res, store.addComment(req.params.key, req.body))));
app.patch('/api/comments/:id', handle((req) => store.updateComment(req.params.id, req.body)));
app.delete('/api/comments/:id', handle((req) => store.deleteComment(req.params.id)));

// { type, target, direction?: 'outward' | 'inward' }
app.post('/api/tickets/:key/links', handle((req, res) => created(res, store.addLink(req.params.key, req.body))));
app.delete('/api/links/:id', handle((req) => store.deleteLink(req.params.id)));

app.get('/api/usage', async (_req, res) => {
  try {
    res.json(await getUsage());
  } catch (error) {
    res.status(503).json({ error: 'usage_unavailable', message: error.message });
  }
});

// Ungueltiges JSON im Request-Body: als 400 melden statt als HTML-Fehlerseite.
app.use((error, _req, res, next) => {
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: 'Der Request-Body ist kein gültiges JSON.' });
  }
  next(error);
});

await initUsage(path.join(root, 'data', 'usage-cache.json'));

// Nur lokal: Die API hat keine Authentifizierung. Zugriff von aussen per SSH-Tunnel.
app.listen(port, '127.0.0.1', () => {
  console.log(`API auf http://localhost:${port}`);
});
