import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import 'dotenv/config';
import { jira, jiraConfigured, prepareForImplementer, toTicket, JiraError } from './jira.js';
import { initRuns, runState, startRun } from './runs.js';
import { getUsage } from './usage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.API_PORT ?? 8787;
const projectKey = process.env.JIRA_PROJECT_KEY ?? 'EMP';

const DEFAULT_ALLOWED_TOOLS =
  'Read,Edit,Write,Glob,Grep,Bash,PowerShell,Agent,Artifact,mcp__atlassian';

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
      allowedTools: process.env.IMPLEMENTER_ALLOWED_TOOLS ?? DEFAULT_ALLOWED_TOOLS,
      prompt:
        `Setze das Jira-Ticket ${key} im Projekt Emperor um. Delegiere die gesamte Arbeit an den ` +
        `Subagenten "implementer" (Agent-Tool, subagent_type "implementer") und nenne ihm ${key} ` +
        `ausdrücklich als sein Ticket; er darf kein anderes Ticket anfassen. Antworte am Ende in ` +
        `zwei Sätzen: was umgesetzt wurde und in welchem Jira-Status ${key} jetzt steht.`,
    });
    res.status(202).json({ run, steps });
  } catch (error) {
    sendError(res, error);
  }
});

await initRuns(path.join(root, 'data', 'runs.json'));

app.listen(port, () => {
  console.log(`API auf http://localhost:${port}`);
});
