import type { UsageSnapshot } from '../types';
import { relativeFromNow } from '../format';

// Die Warnstufen des Dienstes (`severity`) bleiben ungenutzt, solange das Vokabular
// dahinter unbekannt ist — Prozentwerte sind die belastbarere Grundlage.
function level(percent: number): string {
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warning';
  return 'ok';
}

type Props = {
  snapshot: UsageSnapshot | null;
  error: string | null;
};

export default function UsagePanel({ snapshot, error }: Props) {
  if (error) {
    return (
      <section className="panel">
        <h2>Nutzungslimit</h2>
        <p className="notice">{error}</p>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section className="panel">
        <h2>Nutzungslimit</h2>
        <p className="muted">Lade…</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Nutzungslimit</h2>
        <span className={`stamp ${snapshot.stale ? 'stale' : ''}`}>
          Stand {relativeFromNow(snapshot.validAt)}
        </span>
      </div>

      {snapshot.warning && <p className="notice">{snapshot.warning} — angezeigt wird der letzte bekannte Wert.</p>}

      <div className="gauges">
        {snapshot.windows.map((window) => (
          <div key={window.label} className="gauge">
            <div className="gauge-head">
              <span className="gauge-label">{window.label}</span>
              <span className="gauge-value">{window.percentUsed}%</span>
            </div>
            <div className="bar">
              <div
                className={`bar-fill ${level(window.percentUsed)}`}
                style={{ width: `${Math.min(window.percentUsed, 100)}%` }}
              />
            </div>
            <span className="muted small">
              {window.resetsAt
                ? `Zurücksetzung ${relativeFromNow(window.resetsAt)}`
                : 'Kein aktives Fenster'}
            </span>
          </div>
        ))}
      </div>

      {snapshot.breakdown && (
        <div className="breakdown">
          <span className="gauge-label">Wochenfenster nach Quelle</span>
          <ul>
            {snapshot.breakdown.map((row) => (
              <li key={row.name}>
                <span>{row.name}</span>
                <span className="breakdown-bar">
                  <span style={{ width: `${row.percent}%` }} />
                </span>
                <span className="breakdown-value">{row.percent}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
