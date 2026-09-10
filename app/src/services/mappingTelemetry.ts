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
