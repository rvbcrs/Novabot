/**
 * Portable bundle file classifier — splits the verbatim `mower/csv_file/`
 * payload into the four logical categories the operator can independently
 * select on the import wizard:
 *
 *   work     map<N>.csv                  (parent: itself)
 *   obstacle map<N>_<sub>_obstacle.csv   (parent: map<N>)
 *   unicom   map<N>to<X>_unicom.csv      (parent: map<N>)
 *   meta     map_info.json + anything else under csv_file/
 *
 * Plus separate categories for `charging_station.yaml` (`dock`) and the
 * rendered `map.yaml`/`map.pgm`/`map.png` set (`render`) — these are NOT
 * inside csv_file/ in the bundle but are surfaced here so the inventory
 * endpoint can present a single uniform list to the UI.
 *
 * Every entry carries the `parent` map slot (e.g. `map3`) so the import
 * wizard can present a remap dropdown when an obstacle's parent doesn't
 * exist on the destination mower.
 */
export type BundleCategory = 'work' | 'obstacle' | 'unicom' | 'meta' | 'dock' | 'render';

export interface BundleEntry {
  /** Filename as it appears in `mower/csv_file/` or as a top-level mower file. */
  filename: string;
  category: BundleCategory;
  /** Parent work-map slot (e.g. `map3`), null for files that don't reference one. */
  parent: string | null;
  /** For unicom: the target the channel connects to (`charge` or another `map<N>`). */
  unicomTarget?: string | null;
  /** Sub-index for obstacles (`0`, `1`, ...) — preserved for collision-safe rename. */
  obstacleSub?: number | null;
  /** Byte length so the UI can show how big each component is. */
  bytes: number;
}

const WORK_RE = /^(map\d+)(?:_work)?\.csv$/;
const OBSTACLE_RE = /^(map\d+)_(\d+)_obstacle\.csv$/;
const UNICOM_RE = /^(map\d+)to([a-z0-9]+)(?:_\d+)?_unicom\.csv$/i;

/**
 * Classify a single CSV filename. Returns null for filenames we don't
 * recognise (caller falls back to `meta` category).
 */
export function classifyCsv(filename: string): Omit<BundleEntry, 'bytes'> | null {
  let m = WORK_RE.exec(filename);
  if (m) return { filename, category: 'work', parent: m[1] };

  m = OBSTACLE_RE.exec(filename);
  if (m) {
    return {
      filename,
      category: 'obstacle',
      parent: m[1],
      obstacleSub: parseInt(m[2], 10),
    };
  }

  m = UNICOM_RE.exec(filename);
  if (m) {
    return {
      filename,
      category: 'unicom',
      parent: m[1],
      unicomTarget: m[2].toLowerCase(),
    };
  }

  return null;
}

export interface ClassifyResult {
  entries: BundleEntry[];
  byCategory: Record<BundleCategory, BundleEntry[]>;
  /** Distinct work-map slots present in the bundle (sorted). */
  workMaps: string[];
}

/**
 * Classify every file the bundle parser surfaced. Adds synthetic entries
 * for the dock yaml and the rendered map artifacts so the wizard can
 * toggle them as first-class categories alongside the CSVs.
 */
export function classifyBundle(input: {
  csvFiles: Record<string, string>;
  chargingStationYaml: string | null;
  /** Optional rendered map files captured at export time. Bundle parser
   *  does not surface these today; once added, pass them through here. */
  renderFiles?: Record<string, string>;
}): ClassifyResult {
  const entries: BundleEntry[] = [];

  for (const [filename, content] of Object.entries(input.csvFiles)) {
    const bytes = Buffer.byteLength(content, 'utf8');
    const cls = classifyCsv(filename);
    if (cls) {
      entries.push({ ...cls, bytes });
    } else {
      // map_info.json + anything else under csv_file/ — operator-set
      // metadata that travels with the polygons but isn't itself a polygon.
      entries.push({ filename, category: 'meta', parent: null, bytes });
    }
  }

  if (input.chargingStationYaml != null) {
    entries.push({
      filename: 'charging_station.yaml',
      category: 'dock',
      parent: null,
      bytes: Buffer.byteLength(input.chargingStationYaml, 'utf8'),
    });
  }

  if (input.renderFiles) {
    for (const [filename, content] of Object.entries(input.renderFiles)) {
      entries.push({
        filename,
        category: 'render',
        parent: null,
        bytes: Buffer.byteLength(content, 'utf8'),
      });
    }
  }

  const byCategory: ClassifyResult['byCategory'] = {
    work: [], obstacle: [], unicom: [], meta: [], dock: [], render: [],
  };
  for (const e of entries) byCategory[e.category].push(e);

  const workMaps = Array.from(new Set(
    entries.filter(e => e.category === 'work').map(e => e.parent!).filter(Boolean),
  )).sort();

  return { entries, byCategory, workMaps };
}
