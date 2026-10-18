import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

// Der Endpunkt drosselt schon wenige Sekunden nach einer Abfrage. Die Sperrzeit gilt fuer
// JEDEN Versuch, auch fuer fehlgeschlagene: sofort nachzufassen erzeugt nur einen 429 und
// verdeckt den eigentlichen Fehler.
const MIN_INTERVAL_MS = 120_000;

// Nach einem 429 nicht im 2-Minuten-Takt nachfassen: jedes Nachfassen scheint die Sperre zu
// verlaengern. Wartezeit 5 min nach dem ersten 429, je weiterem 429 um 5 min laenger, hoechstens
// 15 min (die Sperre lief zuletzt nach wenigen Minuten ab). Der naechste Erfolg setzt sie zurueck.
const BACKOFF_STEP_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

const LABELS = {
  session: '5-Stunden-Limit',
  weekly_all: 'Wochenlimit · alle Modelle',
  weekly_opus: 'Wochenlimit · Opus',
  weekly_sonnet: 'Wochenlimit · Sonnet',
};

let cache = null;
let lastAttemptAt = 0;
let lastError = null;
let cacheFile = null;
let throttledCount = 0;

function waitMs() {
  if (throttledCount === 0) return MIN_INTERVAL_MS;
  return Math.min(throttledCount * BACKOFF_STEP_MS, BACKOFF_MAX_MS);
}

// Ohne diesen Speicher fragt jeder Serverneustart sofort neu an — bei mehreren Neustarts
// kurz hintereinander laeuft das zuverlaessig in die Drosselung.
export async function initUsage(file) {
  cacheFile = file;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const stored = JSON.parse(await readFile(file, 'utf8'));
    lastAttemptAt = stored.lastAttemptAt ?? 0;
    cache = stored.cache ?? null;
    throttledCount = stored.throttledCount ?? 0;
  } catch {
    // Kein Speicher vorhanden: der erste Abruf fuellt ihn.
  }
}

async function persist() {
  if (!cacheFile) return;
  try {
    await writeFile(cacheFile, JSON.stringify({ cache, lastAttemptAt, throttledCount }, null, 2));
  } catch (error) {
    console.error('usage-cache.json konnte nicht geschrieben werden:', error.message);
  }
}

// Bei jedem Abruf frisch gelesen, nie zwischengespeichert: Claude Code rotiert den Token, und
// eine gehaltene Kopie waere irgendwann abgelaufen. Einen eigenen Token aus `claude setup-token`
// weist der Endpunkt mit 403 ab — der Anmeldespeicher ist die einzige Quelle, die traegt.
// Der Wert darf nirgends protokolliert oder an den Browser gegeben werden.
async function readCredentials() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const raw = await readFile(path.join(dir, '.credentials.json'), 'utf8');
  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('accessToken fehlt in .credentials.json');
  return { token: oauth.accessToken, expiresAt: oauth.expiresAt ?? 0 };
}

// Der Token auf dem Pi wird nur erneuert, wenn hier etwas Claude nutzt (Hermes). Arbeit am PC
// laeuft ueber eine eigene Anmeldung — ohne Hermes-Nutzung war der Token schon tagelang
// abgelaufen. Abgelaufen = weniger als 60 s Rest (wie Hermes), erneuert wird ab 5 min Rest.
const EXPIRED_MARGIN_MS = 60_000;
const RENEW_MARGIN_MS = 5 * 60_000;
const RENEW_MIN_INTERVAL_MS = 30_000;
const RENEW_TIMEOUT_MS = 60_000;

function isExpired(expiresAt, margin = EXPIRED_MARGIN_MS) {
  return Boolean(expiresAt) && Date.now() > expiresAt - margin;
}

function clock(ms) {
  return new Date(ms).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Nicht selbst erneuern: Refresh-Tokens gelten genau einmal. Hermes erneuert unter einer
// prozessuebergreifenden Sperre auf .credentials.json und liest die Datei vorher neu ein —
// eine eigene Erneuerung hier stritte sich mit Hermes um denselben Refresh-Token. Deshalb
// erledigt das die oeffentliche Hermes-CLI (`hermes auth refresh anthropic`).
let renewing = null;
let lastRenewAt = 0;

function runRenew() {
  const bin = process.env.HERMES_BIN || path.join(os.homedir(), '.local', 'bin', 'hermes');
  return new Promise((resolve, reject) => {
    execFile(bin, ['auth', 'refresh', 'anthropic'], { timeout: RENEW_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      // Nur die letzte Zeile, gekuerzt: die CLI gibt keine Tokens aus, aber sicher ist sicher.
      const last = String(stderr || error.message).trim().split('\n').pop() ?? '';
      reject(new Error(last.replace(/sk-ant-[\w-]+/g, '***').slice(0, 200) || 'unbekannter Fehler'));
    });
  });
}

async function renewToken() {
  if (renewing) return renewing;
  if (Date.now() - lastRenewAt < RENEW_MIN_INTERVAL_MS) {
    throw new Error('Erneuerung eben erst versucht — bitte kurz warten');
  }
  lastRenewAt = Date.now();
  renewing = runRenew().finally(() => {
    renewing = null;
  });
  return renewing;
}

function shape(payload) {
  const windows = (payload.limits ?? [])
    .filter((l) => l.percent !== null && l.percent !== undefined)
    // `is_active` bleibt ungenutzt: Es wechselt zwischen den Fenstern, ohne dass klar waere,
    // was es aussagt — ein Fenster mit 10 % Fuellung stand damit schon auf `false`.
    .map((l) => ({
      label: LABELS[l.kind] ?? l.kind,
      percentUsed: l.percent,
      resetsAt: l.resets_at,
    }));

  const rows = payload.seven_day_breakdown?.rows ?? [];
  const breakdown = rows
    .filter((r) => r.percent > 0)
    .map((r) => ({ name: r.display_name, percent: r.percent }));

  return { windows, breakdown: breakdown.length ? breakdown : null };
}

// `retry-after` wird nur angezeigt, nicht befolgt: Der Endpunkt nannte schon 51 Minuten und
// antwortete nach 11 Minuten wieder.
async function throttled(response) {
  const header = response.headers.get('retry-after');
  const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);

  const parts = [`retry-after: ${header ?? 'keine Angabe'}`];
  if (body) parts.push(`Antwort: ${body}`);
  return `Abfrage gedrosselt (429) — ${parts.join(', ')}`;
}

// Ein alter Wert ist eine Auskunft, solange dabeisteht, wann er galt — aber keine Erlaubnis,
// ihn fuer aktuell zu halten. Ohne Cache gibt es gar keine Auskunft.
function degraded(message) {
  lastError = message;
  if (cache) return { ...cache, stale: true, warning: message };
  throw new Error(message);
}

// `renew`: nur beim Knopf „Aktualisieren“ — ein abgelaufener Token wird dann ueber Hermes
// erneuert. Seitenaufrufe und der Minutentakt erneuern nie.
export async function getUsage({ renew = false } = {}) {
  if (cache && Date.now() - new Date(cache.validAt).getTime() < MIN_INTERVAL_MS) {
    return { ...cache, stale: false };
  }

  // Ablauf lokal pruefen, bevor Anthropic gefragt wird: ein abgelaufener Token kostet sonst
  // nur einen Fehlversuch und eine Sperrzeit.
  let creds;
  try {
    creds = await readCredentials();
  } catch (error) {
    return degraded(`Anmeldung nicht lesbar: ${error.message}`);
  }

  let renewed = false;
  if (renew && isExpired(creds.expiresAt, RENEW_MARGIN_MS)) {
    try {
      await renewToken();
      creds = await readCredentials();
      renewed = !isExpired(creds.expiresAt);
    } catch (error) {
      return degraded(`Token-Erneuerung fehlgeschlagen: ${error.message}`);
    }
    if (!renewed) return degraded('Token-Erneuerung lief durch, der Token ist aber weiter abgelaufen');
  }

  if (isExpired(creds.expiresAt)) {
    return degraded(`Token abgelaufen seit ${clock(creds.expiresAt)} — „Aktualisieren“ erneuert ihn`);
  }

  // Nach frischer Erneuerung sofort fragen; die Sperrzeit nach einem 429 gilt trotzdem.
  if (!(renewed && throttledCount === 0) && Date.now() - lastAttemptAt < waitMs()) {
    return degraded(lastError ?? 'Abfrage in Sperrzeit');
  }
  lastAttemptAt = Date.now();
  persist();

  const { token } = creds;

  let response;
  try {
    response = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'Zeitüberschreitung' : error.message;
    return degraded(`Endpunkt nicht erreichbar: ${reason}`);
  }

  if (response.status === 429) {
    throttledCount += 1;
    persist();
    const next = Math.round(waitMs() / 60_000);
    return degraded(`${await throttled(response)} — nächster Versuch in ${next} min`);
  }
  throttledCount = 0;
  // Den Token nicht selbst erneuern (siehe renewToken): das macht Hermes auf Knopfdruck.
  if (response.status === 401) return degraded('Anmeldung abgelaufen (401) — „Aktualisieren“ erneuert sie');
  if (response.status === 403) return degraded('Anmeldung ohne Berechtigung für diesen Endpunkt (403)');
  if (!response.ok) return degraded(`Endpunkt antwortete mit HTTP ${response.status}`);

  cache = { validAt: new Date().toISOString(), ...shape(await response.json()) };
  lastError = null;
  persist();
  return { ...cache, stale: false };
}
