import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

// Der Endpunkt drosselt schon wenige Sekunden nach einer Abfrage. Die Sperrzeit gilt fuer
// JEDEN Versuch, auch fuer fehlgeschlagene: sofort nachzufassen erzeugt nur einen 429 und
// verdeckt den eigentlichen Fehler.
const MIN_INTERVAL_MS = 60_000;

const LABELS = {
  session: '5-Stunden-Limit',
  weekly_all: 'Wochenlimit · alle Modelle',
  weekly_opus: 'Wochenlimit · Opus',
  weekly_sonnet: 'Wochenlimit · Sonnet',
};

let cache = null;
let lastAttemptAt = 0;
let lastError = null;

// Bei jedem Abruf frisch gelesen, nie zwischengespeichert: Claude Code rotiert den Token, und
// eine gehaltene Kopie waere irgendwann abgelaufen. Einen eigenen Token aus `claude setup-token`
// weist der Endpunkt mit 403 ab — der Anmeldespeicher ist die einzige Quelle, die traegt.
// Der Wert darf nirgends protokolliert oder an den Browser gegeben werden.
async function readToken() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const raw = await readFile(path.join(dir, '.credentials.json'), 'utf8');
  const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
  if (!token) throw new Error('accessToken fehlt in .credentials.json');
  return token;
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

// Ein alter Wert ist eine Auskunft, solange dabeisteht, wann er galt — aber keine Erlaubnis,
// ihn fuer aktuell zu halten. Ohne Cache gibt es gar keine Auskunft.
function degraded(message) {
  lastError = message;
  if (cache) return { ...cache, stale: true, warning: message };
  throw new Error(message);
}

export async function getUsage() {
  if (cache && Date.now() - new Date(cache.validAt).getTime() < MIN_INTERVAL_MS) {
    return { ...cache, stale: false };
  }

  if (Date.now() - lastAttemptAt < MIN_INTERVAL_MS) {
    return degraded(lastError ?? 'Abfrage in Sperrzeit');
  }
  lastAttemptAt = Date.now();

  let token;
  try {
    token = await readToken();
  } catch (error) {
    return degraded(`Anmeldung nicht lesbar: ${error.message}`);
  }

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

  if (response.status === 429) return degraded('Abfrage gedrosselt (429)');
  // Den Token nicht selbst erneuern: Claude Code haelt ihn frisch, ein zweiter Erneuerer
  // stritte sich mit ihm um denselben Refresh-Token.
  if (response.status === 401) return degraded('Anmeldung abgelaufen (401) — der nächste Claude-Code-Start erneuert sie');
  if (response.status === 403) return degraded('Anmeldung ohne Berechtigung für diesen Endpunkt (403)');
  if (!response.ok) return degraded(`Endpunkt antwortete mit HTTP ${response.status}`);

  cache = { validAt: new Date().toISOString(), ...shape(await response.json()) };
  lastError = null;
  return { ...cache, stale: false };
}
