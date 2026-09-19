/** SQLite `datetime('now')` timestamps ('YYYY-MM-DD HH:MM:SS') are UTC but carry
 *  no zone marker; `new Date()` on that form parses as LOCAL time on Hermes, which
 *  showed the mowing history two hours early in CEST (#137). Mark them as UTC.
 *  Pure (no react-native import) so it is unit-testable. */
export function parseServerUtc(input: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(input);
  return new Date(m ? `${m[1]}T${m[2]}Z` : input);
}
