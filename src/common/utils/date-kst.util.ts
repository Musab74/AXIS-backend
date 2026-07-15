/** `2026.07.14` — KST calendar date, the format used across certificates and mail. */
export function formatDateKst(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .replace(/-/g, '.');
}

/** `2026.07.14 18:30` — KST date + 24h time, for payment receipts. */
export function formatDateTimeKst(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  // sv-SE renders `2026-07-14 18:30`
  return parts.replace(/-/g, '.');
}

/**
 * Whole days from `now` until `target`, rounded UP — a deadline 1.2 days away is
 * "2 days left", never "1". Used for the D-N reminder copy, so it must never
 * understate the time a candidate has.
 */
export function daysUntil(target: Date | string, now: Date = new Date()): number {
  const t = typeof target === 'string' ? new Date(target) : target;
  return Math.ceil((t.getTime() - now.getTime()) / 86_400_000);
}
