import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BoardConfig, Comment, Ticket, TicketDetail, TicketFields } from '../types';
import { api, request, UI_AUTHOR } from '../api';
import { formatDateTime, relativeFromNow } from '../format';
import Markdown from './Markdown';

type Props = {
  config: BoardConfig;
  // null = neues Ticket anlegen
  ticketKey: string | null;
  tickets: Ticket[];
  defaultBacklog: boolean;
  onOpen: (key: string) => void;
  onClose: () => void;
  // Nach jeder Aenderung: Board neu laden.
  onChanged: () => void;
};

type Form = Omit<TicketFields, 'labels'> & { labels: string };

function emptyForm(config: BoardConfig, backlog: boolean): Form {
  return {
    title: '',
    description: '',
    status: config.statuses[0].name,
    type: config.defaultType,
    priority: config.defaultPriority,
    assignee: null,
    labels: '',
    backlog,
  };
}

function toForm(t: TicketDetail): Form {
  return {
    title: t.title,
    description: t.description,
    status: t.status,
    type: t.type,
    priority: t.priority,
    assignee: t.assignee,
    labels: t.labels.join(' '),
    backlog: t.backlog,
  };
}

// Labels werden im Feld durch Leerzeichen oder Komma getrennt eingegeben.
function parseLabels(text: string) {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

// Nur geaenderte Felder gehen an den Server, damit parallele Aenderungen eines Agenten an
// anderen Feldern nicht ueberschrieben werden.
function changes(form: Form, original: Form | null): Partial<TicketFields> {
  const out: Partial<TicketFields> = {};
  const next: TicketFields = { ...form, labels: parseLabels(form.labels) };
  const before = original ? { ...original, labels: parseLabels(original.labels) } : null;
  for (const field of Object.keys(next) as (keyof TicketFields)[]) {
    const value = next[field];
    if (!before || JSON.stringify(value) !== JSON.stringify(before[field])) {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  return out;
}

export default function TicketDialog({ config, ticketKey, tickets, defaultBacklog, onOpen, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [form, setForm] = useState<Form>(() => emptyForm(config, defaultBacklog));
  const [original, setOriginal] = useState<Form | null>(null);
  const [editDescription, setEditDescription] = useState(ticketKey === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(ticketKey !== null);

  const load = useCallback(
    async (key: string, resetForm: boolean) => {
      const result = await request<TicketDetail>(`/api/tickets/${key}`);
      setLoading(false);
      if (!result.data) {
        setError(result.error);
        return;
      }
      setDetail(result.data);
      if (resetForm) {
        setForm(toForm(result.data));
        setOriginal(toForm(result.data));
      }
    },
    [],
  );

  useEffect(() => {
    if (ticketKey === null) return;
    setLoading(true);
    setError(null);
    setEditDescription(false);
    load(ticketKey, true);
  }, [ticketKey, load]);

  const dirty = useMemo(
    () => (ticketKey === null ? form.title.trim() !== '' || form.description.trim() !== '' : Object.keys(changes(form, original)).length > 0),
    [form, original, ticketKey],
  );

  const close = useCallback(() => {
    if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const set = <K extends keyof Form>(field: K, value: Form[K]) => setForm((f) => ({ ...f, [field]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = changes(form, ticketKey === null ? null : original);
    const result =
      ticketKey === null
        ? await api.post<TicketDetail>('/api/tickets', body)
        : await api.patch<TicketDetail>(`/api/tickets/${ticketKey}`, body);
    setBusy(false);
    if (!result.data) {
      setError(result.error);
      return;
    }
    onChanged();
    if (ticketKey === null) {
      // Das neue Ticket gleich geoeffnet lassen, damit Kommentare und Verknuepfungen folgen koennen.
      onOpen(result.data.key);
    } else {
      setDetail(result.data);
      setForm(toForm(result.data));
      setOriginal(toForm(result.data));
      setEditDescription(false);
    }
  }

  async function remove() {
    if (!ticketKey || !window.confirm(`${ticketKey} endgültig löschen? Kommentare und Verknüpfungen gehen mit.`)) return;
    const result = await api.delete(`/api/tickets/${ticketKey}`);
    if (result.error) return setError(result.error);
    onChanged();
    onClose();
  }

  // Kommentare und Verknuepfungen wirken sofort; danach Detail neu laden, das Formular bleibt.
  const afterSideChange = async (failure: string | null) => {
    if (failure) {
      setError(failure);
      return false;
    }
    setError(null);
    if (ticketKey) await load(ticketKey, false);
    onChanged();
    return true;
  };

  const isNew = ticketKey === null;

  // Wechsel zu einem verknuepften Ticket verwirft ungespeicherte Aenderungen nur nach Rueckfrage.
  const openOther = (key: string) => {
    if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
    onOpen(key);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>{isNew ? 'Neues Ticket' : ticketKey}</h2>
          {detail && (
            <span className="stamp">
              Erstellt {formatDateTime(detail.createdAt)} · geändert {relativeFromNow(detail.updatedAt)}
            </span>
          )}
          <button type="button" className="icon-button" onClick={close} title="Schließen (Esc)">
            ×
          </button>
        </header>

        {error && <p className="notice">{error}</p>}

        {loading ? (
          <p className="muted">Lade…</p>
        ) : (
          <>
            <form className="ticket-form" onSubmit={save}>
              <input
                className="title-input"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="Titel"
                maxLength={255}
                autoFocus={isNew}
                required
              />

              <div className="field-grid">
                <label>
                  Status
                  <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                    {config.statuses.map((s) => (
                      <option key={s.name}>{s.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Typ
                  <select value={form.type} onChange={(e) => set('type', e.target.value)}>
                    {config.types.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Priorität
                  <select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                    {config.priorities.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Zuständig
                  <select value={form.assignee ?? ''} onChange={(e) => set('assignee', e.target.value || null)}>
                    <option value="">Nicht zugewiesen</option>
                    {config.assignees.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  Labels
                  <input
                    value={form.labels}
                    onChange={(e) => set('labels', e.target.value)}
                    placeholder="durch Leerzeichen getrennt"
                  />
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={form.backlog} onChange={(e) => set('backlog', e.target.checked)} />
                  Im Backlog
                </label>
              </div>

              <div className="section-head">
                <h3>Beschreibung</h3>
                <button type="button" className="link-button" onClick={() => setEditDescription((v) => !v)}>
                  {editDescription ? 'Vorschau' : 'Bearbeiten'}
                </button>
              </div>
              {editDescription ? (
                <textarea
                  className="description-input"
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="Markdown"
                  rows={10}
                />
              ) : form.description.trim() ? (
                <div onDoubleClick={() => setEditDescription(true)} title="Doppelklick zum Bearbeiten">
                  <Markdown text={form.description} className="description" />
                </div>
              ) : (
                <p className="muted small">Keine Beschreibung.</p>
              )}

              <div className="form-actions">
                {!isNew && (
                  <button type="button" className="danger" onClick={remove}>
                    Löschen
                  </button>
                )}
                <span className="spacer" />
                <button type="button" onClick={close}>
                  {dirty ? 'Verwerfen' : 'Schließen'}
                </button>
                <button type="submit" className="primary" disabled={busy || !dirty || !form.title.trim()}>
                  {busy ? 'Speichere…' : isNew ? 'Anlegen' : 'Speichern'}
                </button>
              </div>
            </form>

            {detail && ticketKey && (
              <>
                <Links config={config} detail={detail} tickets={tickets} onOpen={openOther} onDone={afterSideChange} />
                <Comments ticketKey={ticketKey} comments={detail.comments} onDone={afterSideChange} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Verknuepfungen --------------------------------------------------------------------------

type Done = (failure: string | null) => Promise<boolean>;

function Links({
  config,
  detail,
  tickets,
  onOpen,
  onDone,
}: {
  config: BoardConfig;
  detail: TicketDetail;
  tickets: Ticket[];
  onOpen: (key: string) => void;
  onDone: Done;
}) {
  // Jede Art gibt es in beiden Richtungen; symmetrische Arten (gleiche Bezeichnung) nur einmal.
  const options = config.linkTypes.flatMap((l) =>
    l.outward === l.inward
      ? [{ value: `${l.id}:outward`, label: l.outward }]
      : [
          { value: `${l.id}:outward`, label: l.outward },
          { value: `${l.id}:inward`, label: l.inward },
        ],
  );
  const [kind, setKind] = useState(options[0]?.value ?? '');
  const [target, setTarget] = useState('');

  async function add(event: FormEvent) {
    event.preventDefault();
    const [type, direction] = kind.split(':');
    const key = target.trim().split(/\s/)[0].toUpperCase();
    const result = await api.post(`/api/tickets/${detail.key}/links`, { type, direction, target: key });
    if (await onDone(result.error)) setTarget('');
  }

  const candidates = tickets.filter((t) => t.key !== detail.key);

  return (
    <section className="dialog-section">
      <h3>Verknüpfungen</h3>
      {detail.links.length > 0 && (
        <ul className="links">
          {detail.links.map((link) => (
            <li key={link.id}>
              <span className="link-label">{link.label}</span>
              <button type="button" className="link-button" onClick={() => onOpen(link.ticket.key)}>
                {link.ticket.key}
              </button>
              <span className={`link-title ${link.ticket.statusCategory === 'done' ? 'done' : ''}`}>{link.ticket.title}</span>
              <span className="muted small">{link.ticket.status}</span>
              <button
                type="button"
                className="icon-button"
                title="Verknüpfung entfernen"
                onClick={async () => onDone((await api.delete(`/api/links/${link.id}`)).error)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="inline-form" onSubmit={add}>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          list="ticket-keys"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={`${config.projectKey}-…`}
        />
        <datalist id="ticket-keys">
          {candidates.map((t) => (
            <option key={t.key} value={`${t.key} ${t.title}`} />
          ))}
        </datalist>
        <button type="submit" disabled={!target.trim()}>
          Verknüpfen
        </button>
      </form>
    </section>
  );
}

// --- Kommentare ------------------------------------------------------------------------------

function CommentItem({ comment, onDone }: { comment: Comment; onDone: Done }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (await onDone((await api.patch(`/api/comments/${comment.id}`, { body })).error)) setEditing(false);
  }

  async function remove() {
    if (!window.confirm('Kommentar löschen?')) return;
    await onDone((await api.delete(`/api/comments/${comment.id}`)).error);
  }

  return (
    <li className="comment">
      <div className="comment-head">
        <strong>{comment.author}</strong>
        <span className="muted small" title={formatDateTime(comment.createdAt)}>
          {relativeFromNow(comment.createdAt)}
          {comment.updatedAt !== comment.createdAt && ' (bearbeitet)'}
        </span>
        <span className="spacer" />
        {!editing && (
          <>
            <button type="button" className="link-button" onClick={() => setEditing(true)}>
              Bearbeiten
            </button>
            <button type="button" className="link-button danger-text" onClick={remove}>
              Löschen
            </button>
          </>
        )}
      </div>
      {editing ? (
        <form className="comment-form" onSubmit={save}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
          <div className="form-actions">
            <span className="spacer" />
            <button
              type="button"
              onClick={() => {
                setBody(comment.body);
                setEditing(false);
              }}
            >
              Abbrechen
            </button>
            <button type="submit" className="primary" disabled={!body.trim()}>
              Speichern
            </button>
          </div>
        </form>
      ) : (
        <Markdown text={comment.body} />
      )}
    </li>
  );
}

function Comments({ ticketKey, comments, onDone }: { ticketKey: string; comments: Comment[]; onDone: Done }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await api.post(`/api/tickets/${ticketKey}/comments`, { author: UI_AUTHOR, body });
    setBusy(false);
    if (await onDone(result.error)) setBody('');
  }

  return (
    <section className="dialog-section">
      <h3>Kommentare ({comments.length})</h3>
      {comments.length > 0 && (
        <ul className="comments">
          {comments.map((c) => (
            <CommentItem key={`${c.id}-${c.updatedAt}`} comment={c} onDone={onDone} />
          ))}
        </ul>
      )}
      <form className="comment-form" onSubmit={add}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Kommentar (Markdown)" rows={3} />
        <div className="form-actions">
          <span className="spacer" />
          <button type="submit" className="primary" disabled={busy || !body.trim()}>
            Kommentieren
          </button>
        </div>
      </form>
    </section>
  );
}
