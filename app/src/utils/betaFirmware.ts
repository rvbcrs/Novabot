// Mirrors the server's BETA_FIRMWARE_WARNING (server/src/services/firmwareSafety.ts). Keep in sync.
// Translated at call time (not at module load) so the lines follow the chosen language.
export const BETA_FIRMWARE_WARNING_KEYS = ['betaFwExperimental', 'betaFwBrick', 'betaFwMaps'] as const;

export function betaFirmwareWarningLines(t: (key: string) => string): string[] {
  return BETA_FIRMWARE_WARNING_KEYS.map((k) => t(k));
}
