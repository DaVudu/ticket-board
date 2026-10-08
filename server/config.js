import { readFileSync } from 'node:fs';

// Status, Typen, Prioritaeten, Zustaendige und Verknuepfungsarten stehen in board.config.json,
// damit sie sich ohne Codeaenderung anpassen lassen. Geaendert wird die Datei, danach der Server
// neu gestartet.
const file = new URL('./board.config.json', import.meta.url);

function fail(message) {
  throw new Error(`board.config.json: ${message}`);
}

function nonEmptyList(value, name) {
  if (!Array.isArray(value) || !value.length) fail(`${name} muss eine nicht leere Liste sein`);
  return value;
}

export function loadConfig() {
  const config = JSON.parse(readFileSync(file, 'utf8'));

  if (!/^[A-Z][A-Z0-9]*$/.test(config.projectKey ?? '')) fail('projectKey fehlt oder ist ungültig');
  nonEmptyList(config.statuses, 'statuses').forEach((s) => {
    if (!s.name || !['new', 'indeterminate', 'done'].includes(s.category)) {
      fail(`Status ${JSON.stringify(s)} braucht name und category (new, indeterminate, done)`);
    }
  });
  nonEmptyList(config.types, 'types');
  nonEmptyList(config.priorities, 'priorities');
  nonEmptyList(config.assignees, 'assignees');
  nonEmptyList(config.linkTypes, 'linkTypes').forEach((l) => {
    if (!l.id || !l.outward || !l.inward) fail(`Verknüpfungsart ${JSON.stringify(l)} braucht id, outward und inward`);
  });
  if (!config.types.includes(config.defaultType)) fail('defaultType steht nicht in types');
  if (!config.priorities.includes(config.defaultPriority)) fail('defaultPriority steht nicht in priorities');

  return config;
}
