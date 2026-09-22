import type { Ticket } from '../types';
import { formatDate, relativeFromNow } from '../format';

const CATEGORY_ORDER: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
const STARTABLE = new Set(['To Do', 'Ready for implementation', 'In Progress']);

type Props = {
  tickets: Ticket[];
  error: string | null;
  activeRunKey: string | null;
  onImplement: (key: string) => void;
};

function groupByStatus(tickets: Ticket[]) {
  const groups = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    const existing = groups.get(ticket.status);
    if (existing) existing.push(ticket);
    else groups.set(ticket.status, [ticket]);
  }

  return [...groups.entries()].sort(([, a], [, b]) => {
    const rankA = CATEGORY_ORDER[a[0].statusCategory] ?? 1;
    const rankB = CATEGORY_ORDER[b[0].statusCategory] ?? 1;
    return rankA - rankB;
  });
}

function implementLabel(ticket: Ticket, activeRunKey: string | null) {
  if (activeRunKey === ticket.key) return 'Läuft…';
  if (activeRunKey) return 'Warten';
  return 'An Implementierer übergeben';
}

export default function TicketBoard({ tickets, error, activeRunKey, onImplement }: Props) {
  if (error) return <p className="notice">{error}</p>;
  if (!tickets.length) return <p className="muted">Keine Tickets im Projekt.</p>;

  return (
    <div className="board">
      {groupByStatus(tickets).map(([status, items]) => (
        <section key={status} className={`column cat-${items[0].statusCategory}`}>
          <header className="column-head">
            <h3>{status}</h3>
            <span className="count">{items.length}</span>
          </header>

          <ul className="cards">
            {items.map((ticket) => (
              <li key={ticket.key} className={`card ${activeRunKey === ticket.key ? 'card-active' : ''}`}>
                <div className="card-top">
                  <a className="card-key" href={ticket.url} target="_blank" rel="noreferrer">
                    {ticket.key}
                  </a>
                  {ticket.labels.map((label) => (
                    <span key={label} className="label">{label}</span>
                  ))}
                </div>
                <p className="card-summary">{ticket.summary}</p>
                <div className="card-meta">
                  <span>{ticket.type}</span>
                  <span>{ticket.priority}</span>
                  <span>{ticket.assignee ?? 'Nicht zugewiesen'}</span>
                </div>
                <div className="card-meta muted small">
                  <span>Aktualisiert {relativeFromNow(ticket.updated)}</span>
                  {ticket.dueDate && <span>Fällig {formatDate(ticket.dueDate)}</span>}
                </div>
                {STARTABLE.has(ticket.status) && ticket.labels.includes('umsetzung') && (
                  <button
                    type="button"
                    className="card-action"
                    disabled={activeRunKey !== null}
                    onClick={() => onImplement(ticket.key)}
                  >
                    {implementLabel(ticket, activeRunKey)}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
