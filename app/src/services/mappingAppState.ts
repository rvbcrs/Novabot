import type { AppState } from 'react-native';

/** Stop motion when native focus is lost; returning never restarts the joystick. */
export function stopOnAppBlur(appState: Pick<AppState, 'addEventListener'>, stop: () => void, android: boolean): () => void {
  const change = appState.addEventListener('change', state => { if (state !== 'active') stop(); });
  const blur = android ? appState.addEventListener('blur', stop) : undefined;
  return () => { change.remove(); blur?.remove(); };
}
