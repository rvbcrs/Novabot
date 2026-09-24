/**
 * Verify-first after a map restore. The restored files are in the frame the
 * bundle was exported in; on the same mower that is the live frame as long as
 * pos.json has not changed since. Instead of assuming it changed (and asking
 * for a re-anchor every time), check: docked with RTK Fixed and map_position
 * on the restored dock anchor means the frame is right and navigation can
 * stay unlocked. Anything else locks it until the re-anchor, as before.
 *
 * Why this file and not frameValidation.ts: sensorData imports
 * frameValidation, so the live-sensor reading lives one level up.
 */
import { deviceCache, translateValue } from '../mqtt/sensorData.js';
import { getPolygonAnchor } from './anchor.js';
import { checkDockedFrame, clearFrameUnvalidated, markFrameUnvalidated, type DockedFrameCheck } from './frameValidation.js';

/** Physically on the dock: same signal as the re-anchor precheck (reanchorOnDock). */
function docked(s: Map<string, string> | undefined): boolean {
  const b = (s?.get('battery_state') ?? '').toUpperCase();
  const r = String(s?.get('recharge_status') ?? '');
  return b === 'CHARGING' || r === '9' || r === '1' || r.startsWith('Charging');
}

/** RTK Fixed on the raw GGA code (4) or the display label; the bare rtk bool as fallback. */
function rtkFixed(s: Map<string, string> | undefined): boolean {
  const fq = s?.get('rtk_fix_quality');
  if (fq != null && fq !== '') return translateValue('rtk_fix_quality', fq) === 'RTK Fixed';
  return s?.get('rtk') === 'true';
}

export function settleRestoredFrame(sn: string): DockedFrameCheck {
  const s = deviceCache.get(sn);
  const x = parseFloat(s?.get('map_position_x') ?? 'NaN');
  const y = parseFloat(s?.get('map_position_y') ?? 'NaN');
  const anchor = getPolygonAnchor(sn, s);
  const check = checkDockedFrame({
    docked: docked(s),
    rtkFixed: rtkFixed(s),
    pose: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null,
    anchor: anchor ? { x: anchor.x, y: anchor.y } : null,
  });
  if (check.ok) clearFrameUnvalidated(sn);
  else markFrameUnvalidated(sn);
  return check;
}
