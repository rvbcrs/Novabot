/**
 * Clusters samenvoegen tot objecten voor de viewers.
 *
 * Twee soorten samenvoeging, allebei nodig door het opknippen in tegels:
 *
 *  1. OVERLAP (elke klasse): één fysiek object valt vaak in stukken uiteen die
 *     ELKAAR OVERLAPPEN met verschillende labels — het zwembad werd deels
 *     "zwembad", deels "trampoline" op overlappende cellen, waardoor twee
 *     modellen door elkaar heen stonden (les 2026-07-20-avond). Overlappende
 *     clusters horen bij hetzelfde object; de dominante klasse (meeste cellen)
 *     wint.
 *  2. GELIJKE KLASSE, aangrenzend (binnen GAP_M): een lange haag valt in
 *     tegels uiteen die niet overlappen maar wel raken; die horen als één
 *     object getekend en met één correctie bijgewerkt.
 *
 * De DB blijft per tegel; de viewers zien één object per groep en een
 * correctie geldt voor de hele groep.
 */

export interface GroupableRow {
  cluster_key: string;
  cx: number;
  cy: number;
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  cells: number;
  max_h: number;
  class_name: string | null;
  confidence: number | null;
  crop_file: string | null;
  user_override: string | null;
  model_file?: string | null;
  size_override?: number | null;
  height_override?: number | null;
  z_offset?: number | null;
  x_offset?: number | null;
  y_offset?: number | null;
}

export interface ClusterGroup {
  /** Sleutels van alle tegels in deze groep (de eerste is de vertegenwoordiger). */
  keys: string[];
  cx: number;
  cy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cells: number;
  maxH: number;
  className: string | null;
  confidence: number | null;
  cropKey: string | null;
  userOverride: string | null;
  modelFile: string | null;
  sizeOverride: number | null;
  heightOverride: number | null;
  zOffset: number | null;
  xOffset: number | null;
  yOffset: number | null;
}

/**
 * Speling waarbinnen twee tegels van DEZELFDE klasse als buren gelden. 1 m
 * overbrugt kleine gaten in een doorlopend object (een haag met één gemiste
 * tussentegel) maar merget geen losse detecties 2-3 m verderop.
 */
const GAP_M = 1.0;

/** Minimale overlap-fractie (van het KLEINSTE cluster) om twee clusters als
 *  hetzelfde fysieke object te zien. Fractie i.p.v. absolute meters, want de
 *  losse detecties op de rand van een groot object zijn vaak maar 0,2-0,3 m
 *  breed maar liggen volledig ín dat object (les 2026-07-20-avond: het
 *  trampoline-brokje 0,25 m zat helemaal in de zwembad-tegel). Rastertegels
 *  RAKEN elkaar alleen (fractie 0) en gaan hier niet op samen. */
const OVERLAP_FRAC = 0.5;

function effectiveClass(row: GroupableRow): string | null {
  return row.user_override ?? row.class_name;
}

function bboxArea(r: GroupableRow): number {
  return Math.max(r.max_x - r.min_x, 0) * Math.max(r.max_y - r.min_y, 0);
}

/** Overlappen a en b met minstens OVERLAP_FRAC van het kleinste bbox-oppervlak? */
function overlaps(a: GroupableRow, b: GroupableRow): boolean {
  const ox = Math.min(a.max_x, b.max_x) - Math.max(a.min_x, b.min_x);
  const oy = Math.min(a.max_y, b.max_y) - Math.max(a.min_y, b.min_y);
  if (ox <= 0 || oy <= 0) return false;
  const overlapArea = ox * oy;
  const kleinste = Math.min(bboxArea(a), bboxArea(b));
  return kleinste > 0 && overlapArea >= OVERLAP_FRAC * kleinste;
}

/** Bboxen a en b raken/overlappen binnen GAP_M op beide assen. */
function adjacent(a: GroupableRow, b: GroupableRow): boolean {
  const overlapX = a.min_x - GAP_M <= b.max_x && b.min_x - GAP_M <= a.max_x;
  const overlapY = a.min_y - GAP_M <= b.max_y && b.min_y - GAP_M <= a.max_y;
  return overlapX && overlapY;
}

/**
 * Groepeert clusters via union-find: overlappende clusters (elke klasse) én
 * aangrenzende clusters van dezelfde effectieve klasse komen in één groep. De
 * groep krijgt de dominante klasse (meeste cellen), zodat een fysiek object
 * dat deels verkeerd geклassificeerd is toch één label + één correctie heeft.
 */
export function groupClusters(rows: GroupableRow[]): ClusterGroup[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = k;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  for (const r of rows) parent.set(r.cluster_key, r.cluster_key);

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      // Handmatig toegevoegde objecten ('m'-prefix) blijven altijd zelfstandig:
      // de gebruiker heeft die plek en klasse expliciet gekozen, dus een
      // overlappende (mogelijk foute) detectie mag ze niet opslokken.
      if (a.cluster_key.startsWith('m') || b.cluster_key.startsWith('m')) continue;
      const sameClass = effectiveClass(a) !== null && effectiveClass(a) === effectiveClass(b);
      if (overlaps(a, b) || (sameClass && adjacent(a, b))) {
        union(a.cluster_key, b.cluster_key);
      }
    }
  }

  const groepen = new Map<string, GroupableRow[]>();
  for (const r of rows) {
    const g = find(r.cluster_key);
    (groepen.get(g) ?? groepen.set(g, []).get(g)!).push(r);
  }

  const out: ClusterGroup[] = [];
  for (const members of groepen.values()) {
    // Dominante effectieve klasse: som cellen per klasse, meeste wint.
    const perKlasse = new Map<string, number>();
    for (const m of members) {
      const k = effectiveClass(m);
      if (k) perKlasse.set(k, (perKlasse.get(k) ?? 0) + m.cells);
    }
    const className = [...perKlasse.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // Vertegenwoordiger + foto uit de tegel met de meeste cellen die de
    // dominante klasse draagt (die crop hoort bij het getoonde label).
    const sorted = [...members].sort((a, b) => b.cells - a.cells);
    const hoofd = sorted.find((m) => effectiveClass(m) === className) ?? sorted[0];
    const cellenTotaal = members.reduce((s, m) => s + m.cells, 0);
    // Override wint: als een lid handmatig gecorrigeerd is, geldt dat label.
    const override = sorted.find((m) => m.user_override)?.user_override ?? null;

    out.push({
      keys: members.map((m) => m.cluster_key),
      cx: members.reduce((s, m) => s + m.cx * m.cells, 0) / cellenTotaal,
      cy: members.reduce((s, m) => s + m.cy * m.cells, 0) / cellenTotaal,
      minX: Math.min(...members.map((m) => m.min_x)),
      minY: Math.min(...members.map((m) => m.min_y)),
      maxX: Math.max(...members.map((m) => m.max_x)),
      maxY: Math.max(...members.map((m) => m.max_y)),
      cells: cellenTotaal,
      maxH: Math.max(...members.map((m) => m.max_h)),
      className: override ?? className,
      confidence: hoofd.confidence,
      cropKey: (sorted.find((m) => effectiveClass(m) === (override ?? className) && m.crop_file)
        ?? sorted.find((m) => m.crop_file))?.cluster_key ?? null,
      userOverride: override,
      modelFile: sorted.find((m) => m.model_file)?.model_file ?? null,
      sizeOverride: sorted.find((m) => m.size_override != null)?.size_override ?? null,
      heightOverride: sorted.find((m) => m.height_override != null)?.height_override ?? null,
      zOffset: sorted.find((m) => m.z_offset != null)?.z_offset ?? null,
      xOffset: sorted.find((m) => m.x_offset != null)?.x_offset ?? null,
      yOffset: sorted.find((m) => m.y_offset != null)?.y_offset ?? null,
    });
  }

  return out.sort((a, b) => b.cells - a.cells);
}

/**
 * Alle sleutels van de groep waar `key` in zit — zodat een correctie op één
 * tegel het hele object bijwerkt.
 */
export function groupKeysFor(rows: GroupableRow[], key: string): string[] {
  const groep = groupClusters(rows).find((g) => g.keys.includes(key));
  return groep ? groep.keys : [key];
}
