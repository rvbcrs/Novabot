// Per-browser default mowing settings, used to pre-fill the Start sheet so the
// operator doesn't reset cutting height / direction on every mow. Stored in
// localStorage; the Settings tab writes them, MowerControls reads them.

export interface MowDefaults {
  /** Cutting height in millimetres (wire-ish), 20–90 (= 2–9 cm). */
  cuttingHeight: number;
  /** Mowing direction in degrees, 0–180. */
  pathDirection: number;
}

export const DEFAULT_MOW: MowDefaults = { cuttingHeight: 40, pathDirection: 0 };

const KEY = 'novabot.mowDefaults';

export function readMowDefaults(): MowDefaults {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<MowDefaults>;
      const ch = Number(d.cuttingHeight);
      const pd = Number(d.pathDirection);
      return {
        cuttingHeight: Number.isFinite(ch) ? Math.max(20, Math.min(90, ch)) : DEFAULT_MOW.cuttingHeight,
        pathDirection: Number.isFinite(pd) ? Math.max(0, Math.min(180, pd)) : DEFAULT_MOW.pathDirection,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_MOW };
}

export function writeMowDefaults(d: MowDefaults): void {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* ignore */ }
}

/**
 * The operator's CONFIGURED cutting height in mm, read from the mower's own
 * para/status frame. Returns null until a frame carrying it arrives.
 *
 * `defaultCuttingHeight` comes back in three different units depending on
 * firmware and on who last wrote it, so sniff by range:
 *   >= 20  already mm (20..90)
 *   <= 7   wire enum (cutterhigh), mm = (n + 2) * 10
 *   <= 9   user cm,               mm = n * 10
 * Falls back to `target_height`, which echoes the accepted wire enum.
 *
 * Shared by the Settings tab and the Start sheet so the Start sheet can't
 * drift back to the localStorage default while Settings shows the real value
 * (GH #105).
 */
export function configuredHeightMm(sensors: Record<string, string | undefined>): number | null {
  const int = (raw: string | undefined, lo: number, hi: number): number | null => {
    if (raw == null || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };

  const hh = int(sensors.defaultCuttingHeight, 0, 90);
  if (hh != null) {
    if (hh >= 20) return hh;
    if (hh <= 7) return (hh + 2) * 10;
    if (hh <= 9) return hh * 10;
  }
  const th = int(sensors.target_height, 0, 7);
  return th != null ? (th + 2) * 10 : null;
}
