import type { BleTelemetry } from './bleFrameAssembler';

/** A stationary mower still sends positions. Heading packets alone are not a live trail. */
export function watchMappingPosition(
  subscribe: (listener: (update: BleTelemetry) => void) => () => void,
  onStale: () => void,
): () => void {
  let active = true;
  let unsubscribe = () => {};
  const stop = () => { if (!active) return; active = false; clearTimeout(timer); unsubscribe(); };
  const stale = () => { if (active) { stop(); onStale(); } };
  let timer = setTimeout(stale, 6000);
  unsubscribe = subscribe(update => {
    if (!active || !update.position) return;
    clearTimeout(timer);
    timer = setTimeout(stale, 6000);
  });
  return stop;
}

/** Localization dropped during a recording. Over BLE the mower's bb packet
 *  carries a `localized` flag (no RTK quality); over the server we fall back
 *  to the localization state/quality. `undefined` (no data yet) is not "lost". */
export function isLocalizationLost(input: {
  useBle: boolean;
  bleLocalized?: boolean;
  locState?: string;
  locQuality?: number;
}): boolean {
  if (input.useBle) return input.bleLocalized === false;
  const state = input.locState ?? '';
  if (state === 'NOT_INITIALIZED') return true;
  return typeof input.locQuality === 'number' && input.locQuality > 0 && input.locQuality < 50;
}
