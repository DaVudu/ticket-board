import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HISTORY_LIMIT = 20;

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

function finish(run, status, result, error) {
  if (run.status !== 'running') return;
  run.status = status;
  run.result = result;
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

export function startRun({ key, prompt, cwd, bin, allowedTools }) {
  if (current) {
    throw new Error(`Es läuft bereits ein Implementierer-Lauf für ${current.key}.`);
  }

  const run = {
    key,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    result: null,
    error: null,
  };
  current = run;

  const args = ['-p', '--output-format', 'json', '--allowedTools', allowedTools];
  const child = spawn(bin, args, { cwd, shell: true, env: childEnv(), windowsHide: true });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  child.on('error', (e) => finish(run, 'failed', null, `Start fehlgeschlagen: ${e.message}`));

  child.on('close', (code) => {
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Kein JSON: die CLI hat vermutlich vor dem ersten Ergebnis abgebrochen.
    }

    if (parsed && !parsed.is_error && code === 0) {
      finish(run, 'succeeded', parsed.result ?? stdout.trim(), null);
    } else {
      const detail = parsed?.result || stderr.trim() || stdout.trim() || `Exit-Code ${code}`;
      finish(run, 'failed', parsed?.result ?? null, detail.slice(0, 2000));
    }
  });

  child.stdin.end(prompt);
  return run;
}
