import { useCallback, useEffect, useMemo, useState } from 'react';
import UsagePanel from './components/UsagePanel';
import TicketBoard, { type Drop } from './components/TicketBoard';
import Backlog from './components/Backlog';
import TicketDialog from './components/TicketDialog';
import { matches } from './components/Labels';
import { api, request } from './api';
import { relativeFromNow } from './format';
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
  const [dialog, setDialog] = useState<Dialog>(keyFromHash);

  const loadTickets = useCallback(async () => {
    const result = await request<TicketList>('/api/tickets');
    if (result.data) {
      setTickets(result.data.tickets);
      setFetchedAt(result.data.fetchedAt);
    }
    setTicketError(result.error);
  }, []);

  const refresh = useCallback(async () => {
    const [, usageResult] = await Promise.all([loadTickets(), request<UsageSnapshot>('/api/usage')]);
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
      setTickets((current) => current.map((t) => (t.key === key ? { ...t, status: drop.status } : t)));
      move(key, { status: drop.status, beforeKey: drop.beforeKey });
    },
    [move],
  );

  const visible = useMemo(() => tickets.filter((t) => matches(t, query)), [tickets, query]);
  const onBoard = visible.filter((t) => !t.backlog);
  const inBacklog = visible.filter((t) => t.backlog);

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
          <button type="button" onClick={refresh}>
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
            <TicketBoard config={config} tickets={onBoard} onOpen={openTicket} onMove={moveOnBoard} />
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
