import { useCallback, useEffect, useState } from 'react';
import UsagePanel from './components/UsagePanel';
import TicketBoard from './components/TicketBoard';
import RunPanel from './components/RunPanel';
import { relativeFromNow } from './format';
import type { ApiError, BoardColumn, RunState, Ticket, TicketResponse, UsageSnapshot } from './types';

const REFRESH_MS = 60_000;
const REFRESH_WHILE_RUNNING_MS = 10_000;

async function request<T>(url: string, init?: RequestInit): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url, init);
    const body = await response.json();
    if (!response.ok) return { data: null, error: (body as ApiError).message };
    return { data: body as T, error: null };
  } catch (error) {
    return { data: null, error: (error as Error).message };
  }
}

export default function App() {
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunState | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [ticketResult, usageResult, runResult] = await Promise.all([
      request<TicketResponse>('/api/tickets'),
      request<UsageSnapshot>('/api/usage'),
      request<RunState>('/api/runs'),
    ]);

    if (ticketResult.data) {
      setColumns(ticketResult.data.columns);
      setTickets(ticketResult.data.tickets);
      setFetchedAt(ticketResult.data.fetchedAt);
    }
    setTicketError(ticketResult.error);

    if (usageResult.data) setUsage(usageResult.data);
    setUsageError(usageResult.error);

    if (runResult.data) setRuns(runResult.data);
    setRunError(runResult.error);
  }, []);

  const running = runs?.current !== null && runs?.current !== undefined;

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, running ? REFRESH_WHILE_RUNNING_MS : REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, running]);

  // Browser drosseln Timer in Hintergrund-Tabs; ohne das hier stehen nach längerer
  // Abwesenheit bis zum nächsten Tick alte Zahlen da.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const implement = useCallback(
    async (key: string) => {
      setActionError(null);
      const result = await request<{ steps: string[] }>(`/api/tickets/${key}/implement`, { method: 'POST' });
      if (result.error) setActionError(`${key}: ${result.error}`);
      await refresh();
    },
    [refresh],
  );

  // Die Karte wandert sofort; der anschließende Refresh holt bei einem Fehler den echten Stand zurück.
  const move = useCallback(
    async (key: string, column: BoardColumn) => {
      const statusId = column.statusIds[0];
      setActionError(null);
      setTickets((current) =>
        current.map((t) =>
          t.key === key ? { ...t, statusId, status: column.name, statusCategory: column.category } : t,
        ),
      );
      const result = await request<{ key: string }>(`/api/tickets/${key}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusId }),
      });
      if (result.error) setActionError(`${key}: ${result.error}`);
      await refresh();
    },
    [refresh],
  );

  const reply = useCallback(
    async (sessionId: string, text: string) => {
      const result = await request<{ run: unknown }>(`/api/runs/${sessionId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      await refresh();
      return result.error;
    },
    [refresh],
  );

  const removeRun = useCallback(
    async (startedAt: string) => {
      const result = await request<{ removed: string }>(`/api/runs/${encodeURIComponent(startedAt)}`, {
        method: 'DELETE',
      });
      await refresh();
      return result.error;
    },
    [refresh],
  );

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Ticket Board</h1>
          <p className="muted">Projekt Emperor (EMP)</p>
        </div>
        <button type="button" onClick={refresh}>
          Aktualisieren
        </button>
      </header>

      <UsagePanel snapshot={usage} error={usageError} />

      <RunPanel state={runs} error={runError} onReply={reply} onRemove={removeRun} />

      <section className="panel">
        <div className="panel-head">
          <h2>Tickets</h2>
          {fetchedAt && <span className="stamp">Abgerufen {relativeFromNow(fetchedAt)}</span>}
        </div>
        {actionError && <p className="notice">{actionError}</p>}
        <TicketBoard
          columns={columns}
          tickets={tickets}
          error={ticketError}
          activeRunKey={runs?.current?.key ?? null}
          onImplement={implement}
          onMove={move}
        />
      </section>
    </main>
  );
}
