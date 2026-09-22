import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import 'dotenv/config';
import { jira, jiraConfigured, prepareForImplementer, toTicket, JiraError } from './jira.js';
import { initRuns, runState, startRun } from './runs.js';
import { getUsage, initUsage } from './usage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.API_PORT ?? 8787;
const projectKey = process.env.JIRA_PROJECT_KEY ?? 'EMP';

// Die Sitzung laeuft selbst als implementer-Agent (--agent), damit seine Schritte im
// Ereignisstrom sichtbar sind; als Unteragent waere dazwischen minutenlang Stille.
const DEFAULT_ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash,PowerShell,Artifact,mcp__atlassian';

const app = express();
app.use(express.json());

function notConfigured(res) {
  return res.status(503).json({
    error: 'jira_not_configured',
    message: 'JIRA_BASE_URL, JIRA_EMAIL und JIRA_API_TOKEN fehlen in .env',
  });
}

function sendError(res, error) {
  const status = error instanceof JiraError ? error.status : 500;
  res.status(status).json({ error: 'request_failed', message: error.message });
}

app.get('/api/tickets', async (_req, res) => {
  if (!jiraConfigured()) return notConfigured(res);
  try {
    const data = await jira('POST', '/search/jql', {
      jql: `project = ${projectKey} ORDER BY updated DESC`,
      maxResults: 100,
      fields: ['summary', 'status', 'issuetype', 'priority', 'labels', 'assignee', 'updated', 'duedate'],
    });
    res.json({ fetchedAt: new Date().toISOString(), tickets: (data.issues ?? []).map(toTicket) });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/usage', async (_req, res) => {
  try {
    res.json(await getUsage());
  } catch (error) {
    res.status(503).json({ error: 'usage_unavailable', message: error.message });
  }
});

app.get('/api/runs', (_req, res) => {
  res.json(runState());
});

app.post('/api/tickets/:key/implement', async (req, res) => {
  if (!jiraConfigured()) return notConfigured(res);

  const emperorDir = process.env.EMPEROR_DIR;
  if (!emperorDir) {
    return res.status(503).json({ error: 'not_configured', message: 'EMPEROR_DIR fehlt in .env' });
  }

  const key = req.params.key.toUpperCase();
  if (!new RegExp(`^${projectKey}-\\d+$`).test(key)) {
    return res.status(400).json({ error: 'bad_key', message: `Ungültiger Vorgangsschlüssel: ${key}` });
  }

  if (runState().current) {
    return res.status(409).json({
      error: 'run_active',
      message: `Es läuft bereits ein Lauf für ${runState().current.key}.`,
    });
  }

  try {
    const steps = await prepareForImplementer(key);
    const run = startRun({
      key,
      cwd: emperorDir,
      bin: process.env.CLAUDE_BIN ?? 'claude',
      agent: process.env.IMPLEMENTER_AGENT ?? 'implementer',
      allowedTools: process.env.IMPLEMENTER_ALLOWED_TOOLS ?? DEFAULT_ALLOWED_TOOLS,
      prompt:
        `Dein Ticket ist ${key}. Setze ausschließlich dieses Ticket um und such dir kein anderes, ` +
        `auch wenn es älter oder passender wirkt. Antworte am Ende in zwei Sätzen: was umgesetzt ` +
        `wurde und in welchem Jira-Status ${key} jetzt steht.`,
    });
    res.status(202).json({ run, steps });
  } catch (error) {
    sendError(res, error);
  }
});

await initRuns(path.join(root, 'data', 'runs.json'));
await initUsage(path.join(root, 'data', 'usage-cache.json'));

// Nur lokal: /api/tickets/:key/implement startet einen Claude-Prozess mit Shell-Zugriff und
// hat keine Authentifizierung. Ohne Host-Angabe lauscht Express auf allen Schnittstellen.
app.listen(port, '127.0.0.1', () => {
  console.log(`API auf http://localhost:${port}`);
});
