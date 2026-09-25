import { stablePosition, freshPositionState } from './positionTelemetry.js';
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
import { deviceCache } from '../mqtt/sensorData.js';
import { getPolygonAnchor } from './anchor.js';
import { checkDockedFrame, markFrameUnvalidated, type DockedFrameCheck } from './frameValidation.js';

export function settleRestoredFrame(sn: string): DockedFrameCheck {
  const sample = stablePosition(sn, { docked: true });
  const state = freshPositionState(sn);
  const anchor = getPolygonAnchor(sn, deviceCache.get(sn));
  const check = checkDockedFrame({ docked: state.docked, rtkFixed: state.fixed, pose: sample, anchor });
  // Caller must first verify the actual written origin; a pose from before the
  // restore cannot prove that the newly loaded origin is active.
  if (!check.ok) markFrameUnvalidated(sn);
  return check;
}
