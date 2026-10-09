// MCP-Server fuer das Ticket-Board (stdio). Die Agenten auf dem PC starten ihn per
//   ssh vudu@<pi> /home/vudu/.local/bin/node /home/vudu/apps/ticket-board/server/mcp.js
// Er schreibt nicht selbst in die Datenbank, sondern geht ueber die REST-API: Die API bleibt der
// einzige Schreiber, ihre Pruefungen (Status, Zustaendige, unbekannte Felder) gelten auch hier.
// Loeschen ist absichtlich nicht dabei; das macht Viktor in der Oberflaeche.
//
// Wichtig: stdout gehoert dem MCP-Protokoll. Diagnose nur auf stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';

const api = (process.env.BOARD_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 8787}`).replace(/\/$/, '');
const config = loadConfig();

const statusNames = config.statuses.map((s) => s.name);
const linkTypeIds = config.linkTypes.map((l) => l.id);
const ticketKey = z
  .string()
  .regex(new RegExp(`^${config.projectKey}-\\d+$`, 'i'), `Schlüssel im Format ${config.projectKey}-123`)
  .transform((key) => key.toUpperCase())
  .describe(`Ticketschlüssel, z. B. ${config.projectKey}-12`);

class ApiError extends Error {}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(api + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new ApiError(`Board-API unter ${api} nicht erreichbar (${error.cause?.code ?? error.message}). Läuft der Board-Server auf dem Pi?`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`Board-API antwortet mit ${res.status} und ohne JSON.`);
  }
  if (!res.ok) throw new ApiError(data?.message ?? `Board-API antwortet mit ${res.status}.`);
  return data;
}

// Ergebnis als JSON-Text; Fehler der API als Werkzeugfehler, damit der Agent den Grund sieht.
function tool(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
}

// Nur gesetzte Felder weitergeben; die API weist unbekannte Felder ab.
function defined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const ticketFields = {
  description: z.string().optional().describe('Beschreibung in Markdown'),
  type: z.enum(config.types).optional(),
  priority: z.enum(config.priorities).optional(),
  assignee: z.enum(config.assignees).nullable().optional().describe('Zuständiger; null = niemand'),
  labels: z.array(z.string()).optional().describe('Labels ohne Leerzeichen; ersetzt die bisherige Liste'),
  backlog: z.boolean().optional().describe('true = im Backlog statt auf dem Board'),
};

const server = new McpServer({ name: 'ticket-board', version: '0.1.0' });

server.registerTool(
  'board_get_config',
  {
    title: 'Board-Konfiguration',
    description: 'Gültige Status (mit Kategorie new/indeterminate/done), Typen, Prioritäten, Zuständige und Verknüpfungsarten.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(() => call('GET', '/api/config')),
);

server.registerTool(
  'board_search_tickets',
  {
    title: 'Tickets suchen',
    description:
      'Sucht Tickets. Alle Filter sind optional und werden UND-verknüpft. q durchsucht Titel und Beschreibung ' +
      'oder findet ein Ticket über seinen Schlüssel. Liefert eine kompakte Liste in Board-Reihenfolge; ' +
      'Beschreibung und Kommentare liefert board_get_ticket.',
    inputSchema: {
      q: z.string().optional().describe('Suchtext oder Ticketschlüssel'),
      status: z.enum(statusNames).optional(),
      type: z.enum(config.types).optional(),
      priority: z.enum(config.priorities).optional(),
      assignee: z.enum(config.assignees).optional(),
      label: z.string().optional(),
      backlog: z.boolean().optional().describe('true = nur Backlog, false = nur Board'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (args) => {
    const query = new URLSearchParams(
      Object.entries(defined(args)).map(([k, v]) => [k, String(v)]),
    ).toString();
    const { tickets } = await call('GET', `/api/tickets${query ? `?${query}` : ''}`);
    return {
      count: tickets.length,
      tickets: tickets.map((t) => ({
        key: t.key,
        title: t.title,
        status: t.status,
        type: t.type,
        priority: t.priority,
        assignee: t.assignee,
        labels: t.labels,
        backlog: t.backlog,
        blockedBy: t.blockedBy,
        commentCount: t.commentCount,
        updatedAt: t.updatedAt,
      })),
    };
  }),
);

server.registerTool(
  'board_get_ticket',
  {
    title: 'Ticket lesen',
    description: 'Ein Ticket mit Beschreibung, Kommentaren, Verknüpfungen und offenen Blockern.',
    inputSchema: { key: ticketKey },
    annotations: { readOnlyHint: true },
  },
  tool(({ key }) => call('GET', `/api/tickets/${key}`)),
);

server.registerTool(
  'board_create_ticket',
  {
    title: 'Ticket anlegen',
    description: `Legt ein Ticket an. Ohne Angaben: Status „${statusNames[0]}“, Typ ${config.defaultType}, Priorität ${config.defaultPriority}, niemand zuständig.`,
    inputSchema: {
      title: z.string().describe('Titel (Pflicht)'),
      status: z.enum(statusNames).optional(),
      ...ticketFields,
    },
  },
  tool((args) => call('POST', '/api/tickets', defined(args))),
);

server.registerTool(
  'board_update_ticket',
  {
    title: 'Ticket ändern',
    description:
      'Ändert nur die übergebenen Felder. Für Statuswechsel und Reihenfolge board_transition_ticket verwenden.',
    inputSchema: {
      key: ticketKey,
      title: z.string().optional(),
      ...ticketFields,
    },
  },
  tool(({ key, ...fields }) => {
    const body = defined(fields);
    if (!Object.keys(body).length) throw new ApiError('Keine Felder zum Ändern angegeben.');
    return call('PATCH', `/api/tickets/${key}`, body);
  }),
);

server.registerTool(
  'board_transition_ticket',
  {
    title: 'Status ändern / verschieben',
    description:
      'Setzt den Status und/oder holt das Ticket aus dem Backlog bzw. legt es dorthin. Ohne beforeKey ' +
      'landet es am Ende der Zielspalte, mit beforeKey direkt vor diesem Ticket (das in der Zielspalte stehen muss).',
    inputSchema: {
      key: ticketKey,
      status: z.enum(statusNames).optional(),
      backlog: z.boolean().optional().describe('true = in den Backlog, false = aufs Board'),
      beforeKey: ticketKey.optional().describe('Vor dieses Ticket einreihen'),
    },
  },
  tool(({ key, ...move }) => {
    const body = defined(move);
    if (body.status === undefined && body.backlog === undefined && body.beforeKey === undefined) {
      throw new ApiError('Angeben: status, backlog und/oder beforeKey.');
    }
    return call('POST', `/api/tickets/${key}/move`, body);
  }),
);

server.registerTool(
  'board_add_comment',
  {
    title: 'Kommentar schreiben',
    description: 'Hängt einen Kommentar (Markdown) an ein Ticket. author ist der eigene Agentenname.',
    inputSchema: {
      key: ticketKey,
      author: z.enum(config.assignees).describe('Wer schreibt, z. B. der eigene Agentenname'),
      body: z.string().describe('Kommentartext in Markdown'),
    },
  },
  tool(({ key, author, body }) => call('POST', `/api/tickets/${key}/comments`, { author, body })),
);

server.registerTool(
  'board_link_tickets',
  {
    title: 'Tickets verknüpfen',
    description:
      'Verknüpft zwei Tickets. ' +
      config.linkTypes.map((l) => `${l.id}: key ${l.outward} target`).join('; ') +
      '. direction inward dreht die Richtung um (target … key).',
    inputSchema: {
      key: ticketKey,
      type: z.enum(linkTypeIds),
      target: ticketKey,
      direction: z.enum(['outward', 'inward']).optional().describe('Standard: outward'),
    },
  },
  tool(({ key, ...link }) => call('POST', `/api/tickets/${key}/links`, defined(link))),
);

await server.connect(new StdioServerTransport());
