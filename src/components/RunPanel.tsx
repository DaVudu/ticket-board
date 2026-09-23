import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Run, RunState } from '../types';
import { relativeFromNow } from '../format';

const STATUS_LABEL: Record<Run['status'], string> = {
  running: 'läuft',
  succeeded: 'abgeschlossen',
  failed: 'fehlgeschlagen',
};

type ReplyHandler = (sessionId: string, text: string) => Promise<string | null>;

function Steps({ steps, live }: { steps: NonNullable<Run['steps']>; live: boolean }) {
  const end = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (live) end.current?.scrollIntoView({ block: 'nearest' });
  }, [live, steps.length]);

  return (
    <ol className="steps">
      {steps.map((step, i) => (
        <li
          key={`${step.at}-${i}`}
          className={`step step-${step.kind}`}
          ref={i === steps.length - 1 ? end : undefined}
        >
          {step.label}
        </li>
      ))}
    </ol>
  );
}

function ReplyForm({ sessionId, onReply }: { sessionId: string; onReply: ReplyHandler }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const failure = await onReply(sessionId, text);
    setBusy(false);
    if (failure) setError(failure);
    else setText('');
  }

  return (
    <form className="reply-form" onSubmit={submit}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Antworten oder weiterführen …"
        rows={2}
        disabled={busy}
      />
      <div className="reply-actions">
        {error && <span className="reply-error">{error}</span>}
        <button type="submit" disabled={busy || !text.trim()}>
          {busy ? 'Sende …' : 'Antworten'}
        </button>
      </div>
    </form>
  );
}

function RunRow({ run, canReply, onReply }: { run: Run; canReply: boolean; onReply: ReplyHandler }) {
  const live = run.status === 'running';
  const when = live
    ? `seit ${relativeFromNow(run.startedAt).replace('vor ', '')}`
    : relativeFromNow(run.finishedAt ?? run.startedAt);
  const steps = run.steps ?? [];

  return (
    <li className={`run run-${run.status}`}>
      <div className="run-head">
        <span className="run-key">{run.key}</span>
        <span className="run-status">{STATUS_LABEL[run.status]}</span>
        <span className="muted small">{when}</span>
      </div>

      {run.reply && (
        <p className="run-reply">
          <span className="run-reply-label">Deine Antwort</span>
          {run.reply}
        </p>
      )}

      {steps.length > 0 && <Steps steps={steps} live={live} />}
      {live && steps.length === 0 && <p className="muted small">Startet…</p>}

      {run.result && <pre className="run-output">{run.result}</pre>}
      {run.error && <pre className="run-output run-error">{run.error}</pre>}

      {canReply && run.sessionId && <ReplyForm sessionId={run.sessionId} onReply={onReply} />}
    </li>
  );
}

type Props = {
  state: RunState | null;
  error: string | null;
  onReply: ReplyHandler;
};

export default function RunPanel({ state, error, onReply }: Props) {
  if (error) {
    return (
      <section className="panel">
        <h2>Implementierer</h2>
        <p className="notice">{error}</p>
      </section>
    );
  }

  const all = state ? [state.current, ...state.history].filter((r): r is Run => r !== null) : [];

  // Weiterfuehren nur am neuesten Lauf jeder Sitzung: --resume setzt ohnehin am Ende der Sitzung
  // an, ein Antwortfeld unter einem aelteren Lauf wuerde etwas anderes versprechen.
  const newestOfSession = new Set<Run>();
  const seen = new Set<string>();
  for (const run of all) {
    if (run.sessionId && !seen.has(run.sessionId)) {
      seen.add(run.sessionId);
      newestOfSession.add(run);
    }
  }

  const idle = !state?.current;
  const runs = all.slice(0, 5);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Implementierer</h2>
        {state?.current && <span className="stamp live">arbeitet an {state.current.key}</span>}
      </div>
      {runs.length === 0 ? (
        <p className="muted">Noch kein Lauf gestartet. Übergib ein Ticket über den Knopf auf seiner Karte.</p>
      ) : (
        <ul className="runs">
          {runs.map((run) => (
            <RunRow
              key={run.startedAt}
              run={run}
              canReply={idle && run.status !== 'running' && newestOfSession.has(run)}
              onReply={onReply}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
