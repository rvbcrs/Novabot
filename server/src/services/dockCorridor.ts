/**
 * Waarschuwing bij tekenen/bewerken: obstakel in de uitrijbaan van het dock.
 *
 * Veldmelding (Novabot-25m): bij het uitwijken reed een maaier deels over een
 * los obstakel van 0,1 m² vlak bij de dockuitgang. Dat gedrag zit in de
 * firmware; wij kunnen alleen vooraf waarschuwen. Zelfde 1,4 m-baan als zone
 * kopiëren en kanaalreparatie gebruiken (channelCorridorBlocked), langs:
 *   1. het rechte stuk achteruit van het dock, tegen de dockrichting in
 *      (zoals dockChannelPoints), alleen met een opgeslagen dockrichting;
 *   2. elk opgeslagen dockkanaal (mapNtocharge_unicom), het pad van en naar het dock.
 * Alles in het frame dat de maaier krijgt: de polygoonverschuiving geldt voor
 * obstakels en kanaalpunten, nooit voor het dockpunt zelf (zoals de ZIP).
 */
import { mapRepo } from '../db/repositories/index.js';
import type { XY } from '../maps/editGeometry.js';
import { getPolygonAnchor } from './anchor.js';
import { shiftPoints } from './polygonOffset.js';
import { channelCorridorBlocked } from './zoneCopy.js';
import { translator, type Translate } from './serverText.js';

/** Recht stuk achteruit van het dock; gelijk aan dockChannelPoints (firmware QUIT_PILE rijdt 1,0 m). */
export const DOCK_EXIT_M = 1.2;

export interface DockCorridor {
  /** Dock in maaierframe; orientation alleen als die opgeslagen (bevestigd) is. */
  dock: XY & { orientation?: number };
  /** Dockkanalen, dockpunt eerst, in maaierframe. */
  channels: XY[][];
}

export interface DockCorridorWarning { canonical: string; code: 'dock_corridor'; message: string }

/** Zuiver: ligt dit obstakel (maaierframe) in de uitrijbaan of in de baan van een dockkanaal? */
export function obstacleInDockCorridor(obstacle: XY[], corridor: DockCorridor): boolean {
  if (obstacle.length < 3) return false;
  const { dock, channels } = corridor;
  if (Number.isFinite(dock.orientation)) {
    const exit = { x: dock.x - DOCK_EXIT_M * Math.cos(dock.orientation!), y: dock.y - DOCK_EXIT_M * Math.sin(dock.orientation!) };
    if (channelCorridorBlocked(dock, exit, [obstacle])) return true;
  }
  return channels.some(ch => ch.slice(1).some((p, i) => channelCorridorBlocked(ch[i], p, [obstacle])));
}

function parsePoints(raw: string | null): XY[] {
  try {
    const pts = JSON.parse(raw ?? 'null');
    return Array.isArray(pts) && pts.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)) ? pts : [];
  } catch { return []; }
}

/** Uitrijbaan uit de DB, of null zonder eenduidig dockanker (dan valt er niets te waarschuwen). */
export function dockCorridorFor(sn: string): DockCorridor | null {
  const anchor = getPolygonAnchor(sn);
  if (!anchor) return null;
  const offset = mapRepo.getPolygonOffset(sn);
  const channels = mapRepo.findAllByMowerSnAndType(sn, 'unicom')
    .filter(m => /^map\d+tocharge_unicom$/.test(m.canonical_name ?? ''))
    .map(m => shiftPoints(parsePoints(m.map_area), offset.x, offset.y, true))
    .filter(pts => pts.length >= 2);
  // Een standaardrichting (1,5 rad) is een gok, geen dock; dan alleen de kanalen.
  const orientation = anchor.orientationSource === 'saved' ? anchor.orientation : undefined;
  return { dock: { x: anchor.x, y: anchor.y, orientation }, channels };
}

/** Waarschuwingen voor obstakels (DB-frame, zoals opgeslagen) in de uitrijbaan van het dock. */
export function dockCorridorWarnings(
  sn: string,
  obstacles: { canonical: string; points: XY[] }[],
  T: Translate = translator('en'),
): DockCorridorWarning[] {
  if (obstacles.length === 0) return [];
  const corridor = dockCorridorFor(sn);
  if (!corridor) return [];
  const offset = mapRepo.getPolygonOffset(sn);
  return obstacles
    .filter(o => obstacleInDockCorridor(shiftPoints(o.points, offset.x, offset.y, false), corridor))
    .map(o => ({
      canonical: o.canonical,
      code: 'dock_corridor' as const,
      message: T`Dit obstakel ligt in de uitrijbaan van het dock (1,4 m breed, ook langs het dockkanaal). Bij het uitrijden of uitwijken kan de maaier er deels overheen rijden; houd die baan vrij of verplaats het obstakel.`,
    }));
}
