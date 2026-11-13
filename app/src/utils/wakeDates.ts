/** The first of the month 4, 5 and 6 months from now as YYYY-MM-DD: the
 *  winter-sleep wake dates the app offers (no date picker dependency).
 *  Relative, not fixed months: winter is June-August in the southern hemisphere. */
export function nextWakeDates(now = new Date()): string[] {
  return [4, 5, 6].map((ahead) => {
    const d = new Date(now.getFullYear(), now.getMonth() + ahead, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
}

/** "1 March" in the given locale. */
export function formatWakeDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { day: 'numeric', month: 'long' });
}
