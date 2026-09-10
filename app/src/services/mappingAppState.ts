import type { AppState } from 'react-native';

/** Stop motion when native focus is lost; returning never restarts the joystick. */
export function stopOnAppBlur(
  appState: Pick<AppState, 'addEventListener' | 'currentState'>,
  stop: () => void,
  android: boolean,
  onForeground?: (foreground: boolean) => void,
): () => void {
  let active = appState.currentState === 'active';
  let focused = true;
  const report = () => onForeground?.(active && focused);
  report();
  const change = appState.addEventListener('change', state => {
    active = state === 'active';
    if (!active) stop();
    report();
  });
  const blur = android ? appState.addEventListener('blur', () => { focused = false; stop(); report(); }) : undefined;
  const focus = android ? appState.addEventListener('focus', () => { focused = true; report(); }) : undefined;
  return () => { change.remove(); blur?.remove(); focus?.remove(); };
}
