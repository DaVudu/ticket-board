import { useCallback, useEffect, useMemo, useState } from 'react';
import UsagePanel from './components/UsagePanel';
import TicketBoard, { type Drop } from './components/TicketBoard';
import Backlog from './components/Backlog';
import TicketDialog from './components/TicketDialog';
import { matches } from './components/Labels';
import { api, request } from './api';
import { calendarDaysBetween, relativeFromNow } from './format';
import type { BoardConfig, Ticket, TicketList, UsageSnapshot } from './types';

const REFRESH_MS = 60_000;

type View = 'board' | 'backlog';
// undefined = kein Dialog, null = neues Ticket, sonst Schluessel des geoeffneten Tickets
type Dialog = string | null | undefined;

// Das geoeffnete Ticket steht im Hash (#EMP-12), damit sich ein Link darauf teilen laesst.
function keyFromHash() {
  const key = decodeURIComponent(window.location.hash.slice(1)).toUpperCase();
  return /^[A-Z][A-Z0-9]*-\d+$/.test(key) ? key : undefined;
}

export default function App() {
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<View>('board');
  const [query, setQuery] = useState('');
  // Absichtlich nicht gespeichert: nach dem Neuladen sind alte erledigte Tickets wieder weg.
  const [showAllDone, setShowAllDone] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(keyFromHash);

  const loadTickets = useCallback(async () => {
    const result = await request<TicketList>('/api/tickets');
    if (result.data) {
      setTickets(result.data.tickets);
      setFetchedAt(result.data.fetchedAt);
    }
    setTicketError(result.error);
  }, []);

  // `renew` nur ueber den Knopf: dann darf der Server einen abgelaufenen Token erneuern.
  const refresh = useCallback(async (renew = false) => {
    const usageUrl = renew ? '/api/usage?renew=1' : '/api/usage';
    const [, usageResult] = await Promise.all([loadTickets(), request<UsageSnapshot>(usageUrl)]);
    if (usageResult.data) setUsage(usageResult.data);
    setUsageError(usageResult.error);
  }, [loadTickets]);

  useEffect(() => {
    request<BoardConfig>('/api/config').then((r) => {
      setConfig(r.data);
      setConfigError(r.error);
    });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Browser drosseln Timer in Hintergrund-Tabs; ohne das hier stehen nach längerer
  // Abwesenheit bis zum nächsten Tick alte Daten da.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  useEffect(() => {
    const onHash = () => setDialog(keyFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openTicket = useCallback((key: string) => {
    window.location.hash = key;
    setDialog(key);
  }, []);

  const closeDialog = useCallback(() => {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    setDialog(undefined);
  }, []);

  const move = useCallback(
    async (key: string, body: { status?: string; backlog?: boolean; beforeKey?: string | null }) => {
      setActionError(null);
      const result = await api.post(`/api/tickets/${key}/move`, { ...body, beforeKey: body.beforeKey ?? undefined });
      if (result.error) setActionError(`${key}: ${result.error}`);
      await loadTickets();
    },
    [loadTickets],
  );

  // Die Karte wandert sofort; der anschließende Abruf holt bei einem Fehler den echten Stand zurück.
  const moveOnBoard = useCallback(
    (key: string, drop: Drop) => {
      const category = config?.statuses.find((s) => s.name === drop.status)?.category;
      setTickets((current) =>
        current.map((t) => {
          if (t.key !== key) return t;
          const done = category === 'done';
          // Wie der Server: innerhalb von done bleibt das Datum, nach done beginnt es neu.
          const doneAt = done ? (t.statusCategory === 'done' && t.doneAt ? t.doneAt : new Date().toISOString()) : null;
          return { ...t, status: drop.status, statusCategory: category ?? t.statusCategory, doneAt };
        }),
      );
      move(key, { status: drop.status, beforeKey: drop.beforeKey });
    },
    [move, config],
  );

  const visible = useMemo(() => tickets.filter((t) => matches(t, query)), [tickets, query]);
  const allOnBoard = visible.filter((t) => !t.backlog);
  const inBacklog = visible.filter((t) => t.backlog);

  // Erledigte Tickets, deren done_at mehr als hideDoneAfterDays Kalendertage zurueckliegt, fehlen
  // in der Spalte. Eine Suche zeigt sie trotzdem, damit sie auffindbar bleiben.
  const hideAfter = config?.hideDoneAfterDays;
  const isOld = (t: Ticket) =>
    hideAfter !== undefined && t.statusCategory === 'done' && t.doneAt !== null && calendarDaysBetween(t.doneAt) > hideAfter;
  const hideOld = !showAllDone && !query.trim();
  const oldByStatus: Record<string, number> = {};
  if (!query.trim()) {
    for (const t of allOnBoard) if (isOld(t)) oldByStatus[t.status] = (oldByStatus[t.status] ?? 0) + 1;
  }
  const onBoard = hideOld ? allOnBoard.filter((t) => !isOld(t)) : allOnBoard;

  // Tickets mit einem Status, den board.config.json nicht (mehr) kennt, haetten keine Spalte.
  const orphaned = config
    ? onBoard.filter((t) => !config.statuses.some((s) => s.name === t.status)).map((t) => `${t.key} (${t.status})`)
    : [];

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Ticket Board</h1>
          <p className="muted">{config ? `Projekt ${config.projectName} (${config.projectKey})` : ' '}</p>
        </div>
        <div className="head-actions">
          <input
            type="search"
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Suchen: Schlüssel, Titel, Label"
          />
          <button type="button" className="primary" onClick={() => setDialog(null)} disabled={!config}>
            Neues Ticket
          </button>
          <button type="button" onClick={() => refresh(true)}>
            Aktualisieren
          </button>
        </div>
      </header>

      <UsagePanel snapshot={usage} error={usageError} />

      <section className="panel">
        <div className="panel-head">
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'tab active' : 'tab'} onClick={() => setView('board')}>
              Board <span className="count">{onBoard.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={view === 'backlog'} className={view === 'backlog' ? 'tab active' : 'tab'} onClick={() => setView('backlog')}>
              Backlog <span className="count">{inBacklog.length}</span>
            </button>
          </div>
          {fetchedAt && <span className="stamp">Abgerufen {relativeFromNow(fetchedAt)}</span>}
        </div>

        {configError && <p className="notice">Konfiguration nicht geladen: {configError}</p>}
        {ticketError && <p className="notice">{ticketError}</p>}
        {actionError && <p className="notice">{actionError}</p>}
        {view === 'board' && orphaned.length > 0 && (
          <p className="notice">Ohne Spalte, Status fehlt in board.config.json: {orphaned.join(', ')}</p>
        )}

        {config &&
          (view === 'board' ? (
            <TicketBoard
              config={config}
              tickets={onBoard}
              oldByStatus={oldByStatus}
              showingOld={!hideOld}
              onToggleOld={() => setShowAllDone((v) => !v)}
              onOpen={openTicket}
              onMove={moveOnBoard}
            />
          ) : (
            <Backlog
              tickets={inBacklog}
              onOpen={openTicket}
              onReorder={(key, beforeKey) => move(key, { backlog: true, beforeKey })}
              onToBoard={(key) => move(key, { backlog: false })}
            />
          ))}
      </section>

      {config && dialog !== undefined && (
        <TicketDialog
          key={dialog ?? 'new'}
          config={config}
          ticketKey={dialog}
          tickets={tickets}
          defaultBacklog={view === 'backlog'}
          onOpen={openTicket}
          onClose={closeDialog}
          onChanged={loadTickets}
        />
      )}
    </main>
  );
}
