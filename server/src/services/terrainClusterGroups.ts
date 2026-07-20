/**
 * Aangrenzende tegels met dezelfde klasse samenvoegen tot één object.
 *
 * Sinds grote componenten in tegels van 2 m worden opgeknipt bestaat één
 * fysiek object (zwembad, haag) uit meerdere tegels. Elk kreeg een eigen
 * classificatie én een eigen correctie — corrigeer je er één, dan blijven de
 * buren op de oude klasse staan (les 2026-07-20: zwembad bleef als vijf
 * trampolines op de kaart liggen). De DB blijft per tegel; de viewers zien
 * één object per groep en een correctie geldt voor de hele groep.
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
}

/**
 * Speling waarbinnen twee tegels als buren gelden. Ruim genomen (3 m, meer
 * dan een tegel breed) omdat één fysiek object vaak in stukken uiteenvalt:
 * het zwembad lag als twee groepen 2,5 m uit elkaar doordat de tussentegels
 * niet herkend werden (les 2026-07-20). Alleen tegels met DEZELFDE klasse
 * worden samengevoegd, dus twee losse struiken van dezelfde soort binnen 3 m
 * worden bewust ook één object — dat is de prijs van deze keuze.
 */
const GAP_M = 3.0;

function effectiveClass(row: GroupableRow): string | null {
  return row.user_override ?? row.class_name;
}

/** Raken/overlappen de bboxen van a en b binnen GAP_M? */
function adjacent(a: GroupableRow, b: GroupableRow): boolean {
  const overlapX = a.min_x - GAP_M <= b.max_x && b.min_x - GAP_M <= a.max_x;
  const overlapY = a.min_y - GAP_M <= b.max_y && b.min_y - GAP_M <= a.max_y;
  return overlapX && overlapY;
}

/**
 * Groepeert rijen: tegels met dezelfde effectieve klasse die aan elkaar
 * grenzen worden één groep. Rijen zonder klasse blijven altijd los (die
 * worden toch als voxels getoond en hebben geen correctie).
 */
export function groupClusters(rows: GroupableRow[]): ClusterGroup[] {
  const out: ClusterGroup[] = [];
  const seen = new Set<string>();

  for (const start of rows) {
    if (seen.has(start.cluster_key)) continue;
    const klasse = effectiveClass(start);
    seen.add(start.cluster_key);

    let members = [start];
    if (klasse !== null) {
      // Kettingreactie: buren van buren horen er ook bij (zodat een lange
      // haag één object wordt en niet per tegelpaar uiteenvalt).
      const wachtrij = [start];
      while (wachtrij.length) {
        const huidig = wachtrij.pop()!;
        for (const kandidaat of rows) {
          if (seen.has(kandidaat.cluster_key)) continue;
          if (effectiveClass(kandidaat) !== klasse) continue;
          if (!adjacent(huidig, kandidaat)) continue;
          seen.add(kandidaat.cluster_key);
          members.push(kandidaat);
          wachtrij.push(kandidaat);
        }
      }
    }

    // Vertegenwoordiger = tegel met de meeste cellen: die heeft de beste
    // foto en de betrouwbaarste classificatie van de groep.
    members = members.sort((a, b) => b.cells - a.cells);
    const hoofd = members[0];
    const cellenTotaal = members.reduce((s, m) => s + m.cells, 0);

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
      className: klasse,
      confidence: hoofd.confidence,
      cropKey: members.find((m) => m.crop_file)?.cluster_key ?? null,
      userOverride: hoofd.user_override,
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
