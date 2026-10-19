/**
 * Patrol runs grouped per night. A night is the evening's date: a run started
 * before noon belongs to the night that began the day before, so the rounds of
 * one window (23:00 until 06:00) stay together.
 */
export interface NightGroup<R> { night: string; runs: R[] }

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * YYYY-MM-DD of the night a run belongs to, in the browser's zone. Noon is read
 * off the wall clock instead of counting twelve hours back: on the two days a
 * year the clocks change, that count puts a run in the hour next to noon on the
 * wrong night.
 */
export function nightKey(startedAt: number | string): string {
  const d = new Date(typeof startedAt === 'number' ? startedAt : Date.parse(startedAt));
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * The evening's calendar day of a night key, as a local date to format. Not
 * `new Date(night)`: a date-only string is read as UTC midnight, which west of
 * Greenwich is still the evening before.
 */
export function nightDate(night: string): Date {
  const [y, m, d] = night.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** The runs, newest first, in groups per night (newest night first), keeping the order within a night. */
export function groupByNight<R extends { startedAt: number | string }>(runs: readonly R[]): NightGroup<R>[] {
  const groups: NightGroup<R>[] = [];
  for (const r of runs) {
    const night = nightKey(r.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.night === night) last.runs.push(r);
    else groups.push({ night, runs: [r] });
  }
  return groups;
}
