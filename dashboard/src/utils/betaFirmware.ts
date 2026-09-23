import i18n from '../i18n';

// Mirrors the server's BETA_FIRMWARE_WARNING (server/src/services/firmwareSafety.ts). Keep in sync.
// Translated at call time (the language can change at runtime), never at module load.
const BETA_FIRMWARE_WARNING_KEYS = [
  'firmware.betaWarning.line1',
  'firmware.betaWarning.line2',
  'firmware.betaWarning.line3',
] as const;

/** The BETA firmware warning, in the current UI language. */
export function betaFirmwareWarningLines(): string[] {
  return BETA_FIRMWARE_WARNING_KEYS.map(k => i18n.t(k));
}

