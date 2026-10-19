import { useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import type { BoardConfig, Ticket } from '../types';
import { relativeFromNow } from '../format';
import { Labels } from './Labels';

export const DRAG_TYPE = 'application/x-ticket-key';

// Ziel eines Drops: Spalte (Status) und optional das Ticket, vor dem eingereiht wird.
export type Drop = { status: string; beforeKey: string | null };

type Props = {
  config: BoardConfig;
  tickets: Ticket[];
  // Je Status: wie viele alte erledigte Tickets ausgeblendet sind bzw. waeren.
  oldByStatus: Record<string, number>;
  showingOld: boolean;
  onToggleOld: () => void;
  onOpen: (key: string) => void;
  onMove: (key: string, drop: Drop) => void;
};

type CardProps = {
  ticket: Ticket;
  dragging: boolean;
  insertBefore: boolean;
  onOpen: (key: string) => void;
  onDragStart: (key: string) => void;
  onDragEnd: () => void;
  onDragOverCard: (key: string) => void;
};

function TicketCard({ ticket, dragging, insertBefore, onOpen, onDragStart, onDragEnd, onDragOverCard }: CardProps) {
  const startDrag = (event: DragEvent) => {
    event.dataTransfer.setData(DRAG_TYPE, ticket.key);
    event.dataTransfer.effectAllowed = 'move';
    onDragStart(ticket.key);
  };

  return (
    <li
      className={`card ${dragging ? 'dragging' : ''} ${insertBefore ? 'insert-before' : ''} ${ticket.blockedBy.length ? 'card-blocked' : ''}`}
      draggable
      onDragStart={startDrag}
      onDragEnd={onDragEnd}
      onDragOver={() => onDragOverCard(ticket.key)}
      onClick={() => onOpen(ticket.key)}
    >
      <div className="card-top">
        <span className="card-key">{ticket.key}</span>
        <Labels labels={ticket.labels} />
      </div>
      <p className="card-summary" title={ticket.title}>
        {ticket.title}
      </p>
      <div className="card-meta">
        <span>{ticket.type}</span>
        <span>{ticket.priority}</span>
        <span>{ticket.assignee ?? 'Nicht zugewiesen'}</span>
      </div>
      {ticket.blockedBy.length > 0 && (
        <p className="blocked-note">Blockiert von {ticket.blockedBy.join(', ')}</p>
      )}
      <div className="card-meta muted small">
        <span>Aktualisiert {relativeFromNow(ticket.updatedAt)}</span>
        {ticket.commentCount > 0 && (
          <span>
            {ticket.commentCount} {ticket.commentCount === 1 ? 'Kommentar' : 'Kommentare'}
          </span>
        )}
      </div>
    </li>
  );
}

export default function TicketBoard({ config, tickets, oldByStatus, showingOld, onToggleOld, onOpen, onMove }: Props) {
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const endDrag = () => {
    setDraggedKey(null);
    setDrop(null);
  };

  // Alle Spalten aus board.config.json stehen immer nebeneinander, auch leere.
  return (
    <div className="board" style={{ '--cols': config.statuses.length } as CSSProperties}>
      {config.statuses.map((status) => {
        const items = tickets.filter((t) => t.status === status.name);
        const isTarget = drop?.status === status.name;
        const old = oldByStatus[status.name] ?? 0;

        return (
          <section
            key={status.name}
            className={`column cat-${status.category} ${isTarget ? 'drop-target' : ''}`}
            onDragOver={(event) => {
              if (!draggedKey) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              // Ueber einer Karte setzt die Karte beforeKey; ueber leerer Flaeche ans Ende.
              const overCard = (event.target as HTMLElement).closest('.card');
              if (!overCard) setDrop({ status: status.name, beforeKey: null });
            }}
            onDragLeave={(event) => {
              // dragleave feuert auch beim Wechsel auf ein Kindelement der Spalte.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const key = event.dataTransfer.getData(DRAG_TYPE);
              const target = drop ?? { status: status.name, beforeKey: null };
              if (key && target.beforeKey !== key) onMove(key, target);
              endDrag();
            }}
          >
            <header className="column-head">
              <h3 title={status.name}>{status.name}</h3>
              <span className="count">{items.length}</span>
            </header>
            {old > 0 && (
              <button
                type="button"
                className="link-button old-toggle"
                onClick={onToggleOld}
                title={showingOld ? 'Ältere erledigte Tickets wieder ausblenden' : 'Ältere erledigte Tickets einblenden'}
              >
                {showingOld ? `${old} ältere ausblenden` : `+${old} ausgeblendet`}
              </button>
            )}

            <ul className="cards">
              {items.map((ticket) => (
                <TicketCard
                  key={ticket.key}
                  ticket={ticket}
                  dragging={draggedKey === ticket.key}
                  insertBefore={isTarget && drop?.beforeKey === ticket.key && draggedKey !== ticket.key}
                  onOpen={onOpen}
                  onDragStart={setDraggedKey}
                  onDragEnd={endDrag}
                  onDragOverCard={(key) => setDrop({ status: status.name, beforeKey: key })}
                />
              ))}
              {!items.length && <li className="muted small empty">Keine Tickets</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
