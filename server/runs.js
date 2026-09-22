import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HISTORY_LIMIT = 20;
const STEP_LIMIT = 60;

let current = null;
let history = [];
let historyFile = null;

export async function initRuns(file) {
  historyFile = file;
  // data/ ist im Repo leer und wird daher nicht mitgeklont.
  await mkdir(path.dirname(file), { recursive: true });
  try {
    history = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    history = [];
  }
}

export function runState() {
  return { current, history };
}

async function persist() {
  if (!historyFile) return;
  await writeFile(historyFile, JSON.stringify(history, null, 2));
}

function clip(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeTool(name, input = {}) {
  if (name.startsWith('mcp__atlassian__')) return `Jira: ${name.slice(16)}`;
  if (input.file_path) return `${name} ${path.basename(input.file_path)}`;
  if (input.command) return `${name}: ${clip(input.command, 70)}`;
  if (input.pattern) return `${name}: ${clip(input.pattern, 40)}`;
  return name;
}

function addStep(run, kind, label) {
  run.steps.push({ at: new Date().toISOString(), kind, label });
  if (run.steps.length > STEP_LIMIT) run.steps.splice(0, run.steps.length - STEP_LIMIT);
}

// Die CLI gibt mit --output-format stream-json eine JSON-Zeile je Ereignis aus, waehrend sie
// arbeitet. Daraus wird der Fortschritt, den das Panel zeigt.
function handleEvent(run, event) {
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') addStep(run, 'tool', describeTool(block.name, block.input));
      else if (block.type === 'text' && block.text.trim()) addStep(run, 'text', clip(block.text, 160));
    }
  } else if (event.type === 'result') {
    run.result = event.result ?? null;
    run.resultIsError = Boolean(event.is_error);
  }
}

function finish(run, status, error) {
  if (run.status !== 'running') return;
  run.status = status;
  run.error = error;
  run.finishedAt = new Date().toISOString();
  current = null;
  history = [run, ...history].slice(0, HISTORY_LIMIT);
  persist().catch((e) => console.error('runs.json konnte nicht geschrieben werden:', e.message));
}

// Weder das Jira- noch das Konto-Token gehören in die Umgebung eines Agenten mit Shell-Zugriff;
// der Agent meldet sich über seine eigene gespeicherte Anmeldung an.
const SECRET_PREFIXES = ['JIRA_', 'CLAUDE_CODE_OAUTH_TOKEN'];

function childEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !SECRET_PREFIXES.some((p) => k.startsWith(p))),
  );
}

export function startRun({ key, prompt, cwd, bin, agent, allowedTools }) {
  if (current) {
    throw new Error(`Es läuft bereits ein Implementierer-Lauf für ${current.key}.`);
  }

  const run = {
    key,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    steps: [],
    result: null,
    resultIsError: false,
    error: null,
  };
  current = run;

  const args = [
    '-p',
    '--agent', agent,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', allowedTools,
  ];
  const child = spawn(bin, args, { cwd, shell: true, env: childEnv(), windowsHide: true });

  let buffer = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleEvent(run, JSON.parse(line));
      } catch {
        // Eine Zeile, die kein Ereignis ist, wird uebergangen — der Lauf haengt nicht daran.
      }
    }
  });

  child.stderr.on('data', (d) => (stderr += d));
  child.on('error', (e) => finish(run, 'failed', `Start fehlgeschlagen: ${e.message}`));

  child.on('close', (code) => {
    if (code === 0 && run.result !== null && !run.resultIsError) {
      finish(run, 'succeeded', null);
    } else {
      const detail = run.result || stderr.trim() || `Exit-Code ${code}`;
      finish(run, 'failed', clip(detail, 2000));
    }
  });

  child.stdin.end(prompt);
  return run;
}
