/**
 * robot_decision routes map_ids > 60000 (or 255) to its vision_test task,
 * which fails with error 125. This affects stock start_navigation and the
 * current OpenNova mow_zone implementation alike. See GH #114 and
 * research/documents/multi-map-area-bitmask-decode.md.
 *
 * Validate the outgoing selection, never truncate it to the first five maps.
 * Mowers running the build that selects by map name are exempt for mow_zone.
 * Recording/importing later slots and commands using polygons/names are
 * independent of this legacy scalar limit.
 */
/**
 * First OpenNova build whose mow orchestrator selects zones by map file name
 * instead of the decimal area code. Proven live on LFIN2230700238, 2026-09-12:
 * map5 (area 100000) undocked, mowed and finished through the normal task flow.
 */
export const MAP_NAMES_SELECTION_BUILD = 40;

/** Whether this mower can start a zone above slot 4 (needs the build above). */
export function supportsMapNamesSelection(swVersion: string | null | undefined): boolean {
  const build = swVersion?.match(/custom-(\d+)/)?.[1];
  return build !== undefined && Number(build) >= MAP_NAMES_SELECTION_BUILD;
}

export function getMowingAreaError(
  command: Record<string, unknown>,
  opts: { swVersion?: string | null } = {},
): string | null {
  for (const key of ['start_navigation', 'start_run', 'mow_zone']) {
    // mow_zone runs through our own orchestrator on the mower. From the build
    // in MAP_NAMES_SELECTION_BUILD on it sends map file names for a selection
    // the number cannot express, so the scalar limit no longer applies there.
    // The stock commands keep it: their handler in mqtt_node has no field for
    // names, so above the limit they still end in error 125.
    if (key === 'mow_zone' && supportsMapNamesSelection(opts.swVersion)) continue;
    const params = command[key];
    if (!params || typeof params !== 'object' || Array.isArray(params)) continue;
    const body = params as Record<string, unknown>;
    let area = body.area;
    // extended_commands.py derives a single-slot area when omitted or zero.
    if (key === 'mow_zone' && !area) {
      const slot = typeof body.map === 'string' ? body.map.match(/^map(\d+)$/)?.[1] : undefined;
      if (slot !== undefined) area = 10 ** Number(slot);
    }
    if (area == null) continue;
    // Python int('1e0'/'0x1') fails and mow_zone then derives 10^map; JS
    // Number() would accept those strings and let an unsupported slot through.
    const value = typeof area === 'number' ? area
      : typeof area === 'string' && /^[+-]?\d+$/.test(area.trim()) ? Number(area) : NaN;
    if (!Number.isSafeInteger(value) || value < 0) return 'Invalid mowing area code.';
    if (value > 60000 || value === 255) {
      return 'This firmware cannot mow the selected area code. Select only map0–map4 (zones 1–5); later slots trigger firmware error 125. Your saved maps are unchanged.';
    }
  }
  return null;
}
