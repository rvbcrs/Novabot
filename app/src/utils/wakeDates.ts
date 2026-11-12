/** The next 1 March, 1 April and 1 May as YYYY-MM-DD: the winter-sleep wake
 *  dates the app offers (no date picker dependency). A date already passed
 *  this year moves to next year. */
export function nextWakeDates(now = new Date()): string[] {
  return [3, 4, 5].map((month) => {
    const thisYear = new Date(now.getFullYear(), month - 1, 1);
    const year = thisYear > now ? now.getFullYear() : now.getFullYear() + 1;
    return `${year}-${String(month).padStart(2, '0')}-01`;
  });
}

/** "1 March" in the given locale. */
export function formatWakeDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { day: 'numeric', month: 'long' });
}
