/**
 * Hoe één maaibaan van het coverage-pad getekend wordt. De 2D-kaart (Leaflet)
 * en de 3D-render (SVG) gebruiken allebei deze regels, zodat ze niet uit
 * elkaar lopen: afgemaaid = dik groen, nu bezig = geel met groen tot het punt
 * waar de maaier is, nog niet gemaaid = dunne lichte lijn, en buiten een
 * maaisessie (statische preview) = cyaan.
 */
export interface LaneStroke {
  color: string;
  /** Leaflet `weight`; in de 3D-render de stroke-breedte. */
  weight: number;
  opacity: number;
  /** Alleen de punten 0..upTo van de baan; null = de hele baan. */
  upTo: number | null;
}

type Style = Omit<LaneStroke, 'upTo'>;
export const GREEN: Style = { color: 'rgba(34,197,94,0.9)', weight: 3.5, opacity: 1 };
export const YELLOW: Style = { color: '#fbbf24', weight: 3, opacity: 0.95 };
export const PENDING: Style = { color: 'rgba(255,255,255,0.35)', weight: 1, opacity: 0.8 };
export const PREVIEW: Style = { color: 'rgba(56,189,248,0.9)', weight: 1.5, opacity: 0.9 };

export function coverageLaneStrokes(s: {
  /** Een maaisessie loopt (ook gepauzeerd of op weg naar het dock). */
  live: boolean;
  /** Voortgang in de sensoren hoort bij een vorige sessie. */
  stale: boolean;
  finished: boolean;
  active: boolean;
  /** covering_area_points: tot hier is de actieve baan gemaaid. */
  activePoints: number;
}): LaneStroke[] {
  // Een statische preview erft nooit de voortgang van de vorige sessie.
  if (!s.live) return [{ ...PREVIEW, upTo: null }];
  if (!s.stale && s.finished) return [{ ...GREEN, upTo: null }];
  if (!s.stale && s.active) {
    return s.activePoints >= 2
      ? [{ ...YELLOW, upTo: null }, { ...GREEN, upTo: s.activePoints }]
      : [{ ...YELLOW, upTo: null }];
  }
  return [{ ...PENDING, upTo: null }];
}
