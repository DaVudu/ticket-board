import { useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import type { BoardColumn, Ticket } from '../types';
import { formatDate, relativeFromNow } from '../format';

const STARTABLE = new Set(['To Do', 'Ready for implementation', 'In Progress']);
const DRAG_TYPE = 'application/x-ticket-key';
// Labels mit eigener Farbe (siehe .label-* in styles.css); alle anderen bleiben grau.
const COLORED_LABELS = new Set(['design', 'umsetzung', 'test', 'grafik']);

function labelClass(label: string) {
  const name = label.toLowerCase();
  return COLORED_LABELS.has(name) ? `label label-${name}` : 'label';
}

type Props = {
  columns: BoardColumn[];
  tickets: Ticket[];
  error: string | null;
  activeRunKey: string | null;
  onImplement: (key: string) => void;
  onMove: (key: string, column: BoardColumn) => void;
};

type CardProps = {
  ticket: Ticket;
  activeRunKey: string | null;
  dragging: boolean;
  onImplement: (key: string) => void;
  onDragStart: (key: string) => void;
  onDragEnd: () => void;
};

function ticketsIn(column: BoardColumn, tickets: Ticket[]) {
  return tickets.filter((ticket) => ticket.statusId !== null && column.statusIds.includes(ticket.statusId));
}

function implementLabel(ticket: Ticket, activeRunKey: string | null) {
  if (activeRunKey === ticket.key) return 'Läuft…';
  if (activeRunKey) return 'Warten';
  return 'An Implementierer übergeben';
}

function TicketCard({ ticket, activeRunKey, dragging, onImplement, onDragStart, onDragEnd }: CardProps) {
  // Während der Implementierer am Ticket arbeitet, gehört der Status ihm.
  const movable = activeRunKey !== ticket.key;

  const startDrag = (event: DragEvent) => {
    event.dataTransfer.setData(DRAG_TYPE, ticket.key);
    event.dataTransfer.effectAllowed = 'move';
    onDragStart(ticket.key);
  };

  return (
    <li
      className={`card ${activeRunKey === ticket.key ? 'card-active' : ''} ${dragging ? 'dragging' : ''}`}
      draggable={movable}
      onDragStart={movable ? startDrag : undefined}
      onDragEnd={onDragEnd}
    >
      <div className="card-top">
        <a className="card-key" href={ticket.url} target="_blank" rel="noreferrer" draggable={false}>
          {ticket.key}
        </a>
        {ticket.labels.map((label) => (
          <span key={label} className={labelClass(label)}>{label}</span>
        ))}
      </div>
      <p className="card-summary" title={ticket.summary}>{ticket.summary}</p>
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
  );
}

export default function TicketBoard({ columns, tickets, error, activeRunKey, onImplement, onMove }: Props) {
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  if (error) return <p className="notice">{error}</p>;
  if (!columns.length) return <p className="muted">Keine Spalten im Board.</p>;

  const dragged = tickets.find((t) => t.key === draggedKey) ?? null;
  const accepts = (column: BoardColumn) =>
    dragged !== null && dragged.statusId !== null && !column.statusIds.includes(dragged.statusId);

  const endDrag = () => {
    setDraggedKey(null);
    setDropTarget(null);
  };

  // Alle Spalten des Boards stehen immer nebeneinander, auch leere.
  return (
    <div className="board" style={{ '--cols': columns.length } as CSSProperties}>
      {columns.map((column) => {
        const items = ticketsIn(column, tickets);
        return (
          <section
            key={column.name}
            className={`column cat-${column.category} ${dropTarget === column.name ? 'drop-target' : ''}`}
            onDragOver={(event) => {
              if (!accepts(column)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTarget(column.name);
            }}
            onDragLeave={(event) => {
              // dragleave feuert auch beim Wechsel auf ein Kindelement der Spalte.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const key = event.dataTransfer.getData(DRAG_TYPE);
              if (key && accepts(column)) onMove(key, column);
              endDrag();
            }}
          >
            <header className="column-head">
              <h3 title={column.name}>{column.name}</h3>
              <span className="count">{items.length}</span>
            </header>

            {items.length ? (
              <ul className="cards">
                {items.map((ticket) => (
                  <TicketCard
                    key={ticket.key}
                    ticket={ticket}
                    activeRunKey={activeRunKey}
                    dragging={draggedKey === ticket.key}
                    onImplement={onImplement}
                    onDragStart={setDraggedKey}
                    onDragEnd={endDrag}
                  />
                ))}
              </ul>
            ) : (
              <p className="muted small">Keine Tickets</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
