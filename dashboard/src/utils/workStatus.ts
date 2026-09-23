import i18n from '../i18n';

// Human labels for the mower's numeric work_status codes. Mirrors
// WORK_STATUS_LABELS in server/src/mqtt/sensorData.ts so the dashboard never
// shows a bare number when the socket snapshot carries the raw code.
// Decoded 1:1 from the firmware robot_status::WorkStatusString(uint8) (the
// robot_decision jump table) and kept in sync with WORK_STATUS_LABELS in
// server/src/mqtt/sensorData.ts. Authoritative for the work_status code the mower
// reports; codes not listed are not emitted by the firmware (default "State N").
const WORK_STATUS_LABELS: Record<number, string> = {
  0: 'Idle',
  1: 'Failed',
  2: 'Cancelled',
  7: 'Failed once',
  8: 'Finished once',
  9: 'Finished',
  10: 'User stopped',
  11: 'User recharge',
  12: 'Low power',
  13: 'Error stop',
  14: 'Time limit',
  15: 'Recovery error',
  49: 'Resuming',
  50: 'Start requested',
  51: 'Sensor init',
  53: 'Map init',
  54: 'UTM init',
  55: 'Localization init',
  56: 'Leaving dock',
  57: 'System check',
  59: 'Init success',
  61: 'Localization error',
  62: 'LoRa error',
  63: 'Wheels slipping',
  64: 'Out of map',
  90: 'Mowing',
  91: 'Avoiding obstacle',
  92: 'Driving',
  93: 'Edge cutting',
  94: 'Re-covering missed spots',
  130: 'Mapping work zone',
  131: 'Mapping obstacle',
  132: 'Mapping channel',
  133: 'Mapping channel to dock',
  134: 'Setting dock position',
  135: 'Deleting map',
  136: 'Deleting obstacle',
  137: 'Deleting channel',
  138: 'Auto-erasing map',
  139: 'Auto-erase failed',
  140: 'Auto-erase done',
  141: 'Auto-mapping work zone',
  142: 'Auto-mapping obstacle',
  143: 'Editing map',
  169: 'Mapping paused',
  191: 'Returning to dock',
  192: 'Searching for dock',
  193: 'Aligning dock',
};

/**
 * Turn a work_status value into a readable label. The value can arrive as a raw
 * numeric code ("100") or already translated ("Mowing" / "State 90"); both are
 * handled — a non-numeric value passes through untouched, a known code maps to
 * its label, an unknown code falls back to "State N".
 */
export function workStatusLabel(raw: string | number | null | undefined): string {
  if (raw == null || raw === '') return '';
  const s = String(raw).trim();
  const n = parseInt(s, 10);
  // Only treat it as a code when the WHOLE string is the number (so "State 90"
  // or "Idle" pass through unchanged).
  if (Number.isNaN(n) || String(n) !== s) {
    // The server may already have turned the code into its English label
    // ("Mowing"); translate that too, anything else passes through untouched.
    const code = CODE_BY_LABEL.get(s);
    return code != null ? translateCode(code) : s;
  }
  return WORK_STATUS_LABELS[n] != null ? translateCode(n) : i18n.t('workStatus.unknown', { n });
}

const CODE_BY_LABEL = new Map<string, number>(
  Object.entries(WORK_STATUS_LABELS).map(([code, label]) => [label, Number(code)]),
);

function translateCode(code: number): string {
  return i18n.t(`workStatus.${code}`, { defaultValue: WORK_STATUS_LABELS[code] });
}
