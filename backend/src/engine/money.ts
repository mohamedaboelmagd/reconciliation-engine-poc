export function formatMinor(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100).toLocaleString('en-US');
  const minor = String(abs % 100).padStart(2, '0');
  return `${sign}${currency} ${major}.${minor}`;
}

export function toleranceFor(amountMinor: number, pct: number, absMinor: number): number {
  return Math.max(Math.round(Math.abs(amountMinor) * pct), absMinor);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}
