export function relativeFromNow(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60000);

  if (minutes < 1) return 'gerade eben';

  let value: string;
  if (minutes < 60) value = `${minutes} Min.`;
  else if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    value = rest ? `${hours} Std. ${rest} Min.` : `${hours} Std.`;
  } else {
    const days = Math.floor(minutes / (60 * 24));
    const hours = Math.floor((minutes % (60 * 24)) / 60);
    value = hours ? `${days} T. ${hours} Std.` : `${days} T.`;
  }

  return diffMs >= 0 ? `in ${value}` : `vor ${value}`;
}

// Kalendertage zwischen zwei Zeitpunkten in Ortszeit (erledigt Montag, heute Donnerstag = 3).
export function calendarDaysBetween(fromIso: string, to: Date = new Date()): number {
  const from = new Date(fromIso);
  const startFrom = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const startTo = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  // Runden gleicht Sommer-/Winterzeit aus (23 oder 25 Stunden am Umstellungstag).
  return Math.round((startTo.getTime() - startFrom.getTime()) / 86_400_000);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
