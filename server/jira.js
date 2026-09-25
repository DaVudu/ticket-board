export function jiraConfigured() {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  return Boolean(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN);
}

function authHeader() {
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  return 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

export class JiraError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function jira(method, path, body) {
  return call('/rest/api/3', method, path, body);
}

// Boards und Backlog gibt es nur in der Agile-API, nicht in der Plattform-API.
export function agile(method, path, body) {
  return call('/rest/agile/1.0', method, path, body);
}

async function call(api, method, path, body) {
  const response = await fetch(`${process.env.JIRA_BASE_URL}${api}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const details = data?.errorMessages?.join('; ') || Object.values(data?.errors ?? {}).join('; ') || text.slice(0, 300);
    throw new JiraError(response.status, `Jira ${response.status}: ${details}`);
  }
  return data;
}

export function toTicket(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status?.name ?? 'Unbekannt',
    statusId: f.status?.id ?? null,
    statusCategory: f.status?.statusCategory?.key ?? 'new',
    type: f.issuetype?.name ?? '',
    priority: f.priority?.name ?? '',
    labels: f.labels ?? [],
    assignee: f.assignee?.displayName ?? null,
    updated: f.updated,
    dueDate: f.duedate,
    url: `${process.env.JIRA_BASE_URL}/browse/${issue.key}`,
  };
}

const TICKET_FIELDS = 'summary,status,issuetype,priority,labels,assignee,updated,duedate';

// Die Agile-API liefert hoechstens 50 Vorgaenge je Seite.
async function allPages(path, fields) {
  const issues = [];
  for (let startAt = 0; ; ) {
    const page = await agile('GET', `${path}?startAt=${startAt}&maxResults=50&fields=${fields}`);
    const batch = page.issues ?? [];
    issues.push(...batch);
    startAt += batch.length;
    if (!batch.length || startAt >= page.total) return issues;
  }
}

async function resolveBoardId(projectKey) {
  if (process.env.JIRA_BOARD_ID) return process.env.JIRA_BOARD_ID;
  const { values } = await agile('GET', `/board?projectKeyOrId=${encodeURIComponent(projectKey)}`);
  if (!values?.length) throw new JiraError(404, `Zum Projekt ${projectKey} gibt es kein Board.`);
  return values[0].id;
}

// Die Tickets, die auf dem Board liegen, und die Spalten des Boards. Der Backlog haengt nicht
// am Status, sondern am Board; per JQL laesst er sich nicht ausschliessen, deshalb
// Board-Vorgaenge minus Backlog. Die Spalten kommen aus der Board-Konfiguration, damit auch
// leere Spalten angezeigt werden.
export async function boardTickets(projectKey) {
  const boardId = await resolveBoardId(projectKey);
  const [issues, backlog, config] = await Promise.all([
    allPages(`/board/${boardId}/issue`, TICKET_FIELDS),
    allPages(`/board/${boardId}/backlog`, 'status'),
    agile('GET', `/board/${boardId}/configuration`),
  ]);
  const inBacklog = new Set(backlog.map((i) => i.key));
  const tickets = issues
    .filter((i) => !inBacklog.has(i.key))
    .map(toTicket)
    .sort((a, b) => b.updated.localeCompare(a.updated));

  // Die Konfiguration kennt nur Status-IDs; die Kategorie (fuer die Farbe) liefern die Tickets.
  // Ohne Ticket in der Spalte gilt die Position: erste Spalte neu, letzte erledigt.
  const columns = (config.columnConfig?.columns ?? [])
    .map((c) => ({ name: c.name, statusIds: (c.statuses ?? []).map((s) => s.id) }))
    .filter((c) => c.statusIds.length)
    .map((c, index, all) => {
      const sample = tickets.find((t) => c.statusIds.includes(t.statusId));
      const fallback = index === 0 ? 'new' : index === all.length - 1 ? 'done' : 'indeterminate';
      return { ...c, category: sample?.statusCategory ?? fallback };
    });

  return { columns, tickets };
}

// Verschiebt ein Ticket in den Status mit der ID `statusId`, ueber den passenden Jira-Uebergang.
export async function moveTicket(key, statusId) {
  const [issue, { transitions }] = await Promise.all([
    jira('GET', `/issue/${key}?fields=status`),
    jira('GET', `/issue/${key}/transitions`),
  ]);
  const status = issue.fields.status;
  if (status.id === statusId) return;

  const target = transitions.find((t) => t.to?.id === statusId);
  if (!target) throw new JiraError(409, `Kein Übergang von "${status.name}" in den Zielstatus gefunden.`);
  await jira('POST', `/issue/${key}/transitions`, { transition: { id: target.id } });
}

const STARTABLE =new Set(['To Do', 'Ready for implementation', 'In Progress']);
const READY = 'Ready for implementation';
const LABEL = 'umsetzung';

// Bringt ein Ticket in den Zustand, den der implementer-Agent des Emperor-Repos erwartet:
// dem eigenen Konto zugewiesen und mindestens in `Ready for implementation`. Das Label
// `umsetzung` wird vorausgesetzt, nicht gesetzt — es ist die Rollenzuordnung des Designers.
export async function prepareForImplementer(key) {
  const [me, issue] = await Promise.all([
    jira('GET', '/myself'),
    jira('GET', `/issue/${key}?fields=status,labels,assignee`),
  ]);

  const status = issue.fields.status.name;
  if (!STARTABLE.has(status)) {
    throw new JiraError(409, `${key} steht in "${status}" und kann nicht gestartet werden.`);
  }

  if (!issue.fields.labels.includes(LABEL)) {
    const have = issue.fields.labels.length ? issue.fields.labels.join(', ') : 'keins';
    throw new JiraError(409, `${key} trägt nicht das Label "${LABEL}" (aktuell: ${have}) und gehört damit einer anderen Rolle.`);
  }

  const steps = [];

  if (issue.fields.assignee?.accountId !== me.accountId) {
    await jira('PUT', `/issue/${key}/assignee`, { accountId: me.accountId });
    steps.push(`${me.displayName} zugewiesen`);
  }

  if (status === 'To Do') {
    const { transitions } = await jira('GET', `/issue/${key}/transitions`);
    const target = transitions.find((t) => t.to?.name === READY);
    if (!target) throw new JiraError(409, `Kein Übergang von "${status}" nach "${READY}" gefunden.`);
    await jira('POST', `/issue/${key}/transitions`, { transition: { id: target.id } });
    steps.push(`nach "${READY}" verschoben`);
  }

  return steps;
}
