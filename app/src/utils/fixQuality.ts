/** Map an RTK fix quality to a display label + color.
 * Accepts either the raw NMEA GGA code (4=Fixed, 5=Float, 2=DGPS, 1=GPS, 0=no fix)
 * OR the server-translated label string ("RTK Fixed", "RTK Float", "DGPS",
 * "GPS", "No fix") - the app receives the translated label over the socket
 * (forwardToDashboard sends translateValue output), while other paths may carry
 * the raw code. undefined/null/unknown -> "No data". */
export interface FixQualityDisplay {
  label: string;
  color: string;
  /** i18n key for labels that are words (not technical terms like "RTK Fixed"). */
  labelKey?: string;
}

const FIXED: FixQualityDisplay = { label: 'RTK Fixed', color: '#22c55e' };
const FLOAT: FixQualityDisplay = { label: 'RTK Float', color: '#f59e0b' };
const DGPS: FixQualityDisplay = { label: 'DGPS', color: '#eab308' };
const GPS: FixQualityDisplay = { label: 'GPS', color: '#9ca3af' };
const NOFIX: FixQualityDisplay = { label: 'No fix', color: '#ef4444', labelKey: 'fixQualityNoFix' };
const NO_DATA: FixQualityDisplay = { label: 'No data', color: '#6b7280', labelKey: 'fixQualityNoData' };

/** Pass `t` to get the label in the user's language (without it: English). */
export function fixQualityLabel(
  q: number | string | null | undefined,
  t?: (key: string) => string,
): FixQualityDisplay {
  const d = resolveFixQuality(q);
  return t && d.labelKey ? { ...d, label: t(d.labelKey) } : d;
}

function resolveFixQuality(q: number | string | null | undefined): FixQualityDisplay {
  if (q == null) return NO_DATA;
  const raw = typeof q === 'string' ? q.trim() : q;

  // Numeric code path (raw GGA quality).
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  switch (n) {
    case 4: return FIXED;
    case 5: return FLOAT;
    case 2: return DGPS;
    case 1: return GPS;
    case 0: return NOFIX;
  }

  // Translated-label path (server translateValue output).
  if (typeof raw === 'string') {
    switch (raw) {
      case 'RTK Fixed': return FIXED;
      case 'RTK Float': return FLOAT;
      case 'DGPS': return DGPS;
      case 'GPS': return GPS;
      case 'No fix': return NOFIX;
    }
  }

  return NO_DATA;
}
