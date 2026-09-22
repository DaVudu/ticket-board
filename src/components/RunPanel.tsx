import { useEffect, useRef } from 'react';
import type { Run, RunState } from '../types';
import { relativeFromNow } from '../format';

const STATUS_LABEL: Record<Run['status'], string> = {
  running: 'läuft',
  succeeded: 'abgeschlossen',
  failed: 'fehlgeschlagen',
};

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

function RunRow({ run }: { run: Run }) {
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

      {steps.length > 0 && <Steps steps={steps} live={live} />}
      {live && steps.length === 0 && <p className="muted small">Startet…</p>}

      {run.result && <pre className="run-output">{run.result}</pre>}
      {run.error && <pre className="run-output run-error">{run.error}</pre>}
    </li>
  );
}

type Props = {
  state: RunState | null;
  error: string | null;
};

export default function RunPanel({ state, error }: Props) {
  if (error) {
    return (
      <section className="panel">
        <h2>Implementierer</h2>
        <p className="notice">{error}</p>
      </section>
    );
  }

  const runs = state ? [state.current, ...state.history].filter((r): r is Run => r !== null).slice(0, 5) : [];

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
            <RunRow key={run.startedAt} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}
