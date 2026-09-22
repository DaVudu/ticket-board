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

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
