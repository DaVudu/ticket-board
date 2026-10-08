import { useState } from 'react';
import type { Ticket } from '../types';
import { Labels } from './Labels';
import { DRAG_TYPE } from './TicketBoard';

type Props = {
  tickets: Ticket[];
  onOpen: (key: string) => void;
  // beforeKey null = ans Ende des Backlogs
  onReorder: (key: string, beforeKey: string | null) => void;
  onToBoard: (key: string) => void;
};

// Der Backlog ist eine Liste in Prioritaetsreihenfolge, unabhaengig vom Status.
export default function Backlog({ tickets, onOpen, onReorder, onToBoard }: Props) {
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [beforeKey, setBeforeKey] = useState<string | null | undefined>(undefined);

  const endDrag = () => {
    setDraggedKey(null);
    setBeforeKey(undefined);
  };

  if (!tickets.length) return <p className="muted">Der Backlog ist leer.</p>;

  return (
    <ul
      className="backlog"
      onDragOver={(event) => {
        if (!draggedKey) return;
        event.preventDefault();
        if (!(event.target as HTMLElement).closest('.backlog-row')) setBeforeKey(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const key = event.dataTransfer.getData(DRAG_TYPE);
        if (key && beforeKey !== undefined && beforeKey !== key) onReorder(key, beforeKey);
        endDrag();
      }}
    >
      {tickets.map((ticket) => (
        <li
          key={ticket.key}
          className={`backlog-row ${draggedKey === ticket.key ? 'dragging' : ''} ${
            beforeKey === ticket.key && draggedKey !== ticket.key ? 'insert-before' : ''
          }`}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(DRAG_TYPE, ticket.key);
            event.dataTransfer.effectAllowed = 'move';
            setDraggedKey(ticket.key);
          }}
          onDragEnd={endDrag}
          onDragOver={() => setBeforeKey(ticket.key)}
          onClick={() => onOpen(ticket.key)}
        >
          <span className="card-key">{ticket.key}</span>
          <span className="backlog-title" title={ticket.title}>
            {ticket.title}
          </span>
          <span className="backlog-labels">
            <Labels labels={ticket.labels} />
          </span>
          <span className="muted small">{ticket.type}</span>
          <span className="muted small">{ticket.priority}</span>
          <span className="muted small">{ticket.assignee ?? '–'}</span>
          <span className="muted small">{ticket.status}</span>
          <button
            type="button"
            className="small-button"
            onClick={(event) => {
              event.stopPropagation();
              onToBoard(ticket.key);
            }}
          >
            Aufs Board
          </button>
        </li>
      ))}
    </ul>
  );
}
