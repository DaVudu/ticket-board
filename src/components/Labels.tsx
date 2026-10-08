// Labels mit eigener Farbe (siehe .label-* in styles.css); alle anderen bleiben grau.
const COLORED_LABELS = new Set(['design', 'umsetzung', 'test', 'grafik']);

export function labelClass(label: string) {
  const name = label.toLowerCase();
  return COLORED_LABELS.has(name) ? `label label-${name}` : 'label';
}

export function Labels({ labels }: { labels: string[] }) {
  return (
    <>
      {labels.map((label) => (
        <span key={label} className={labelClass(label)}>
          {label}
        </span>
      ))}
    </>
  );
}

// Die Ticketsuche im Kopf filtert nach Schluessel, Titel und Labels.
export function matches(ticket: { key: string; title: string; labels: string[] }, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    ticket.key.toLowerCase().includes(q) ||
    ticket.title.toLowerCase().includes(q) ||
    ticket.labels.some((l) => l.toLowerCase().includes(q))
  );
}
