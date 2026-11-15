/**
 * Sunrise and sunset without a network call: the NOAA/Wikipedia "sunrise
 * equation" (accurate to about a minute at mid latitudes, which is plenty for
 * starting a mowing session). Used by schedules that start relative to the sun
 * ("every day at sunset", "30 min after sunrise"), so the start follows the
 * seasons instead of a fixed clock time.
 */

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
/** Julian day of the Unix epoch. */
const JD_UNIX_EPOCH = 2440587.5;
/** Julian day of J2000.0 (2000-01-01 12:00 TT). */
const J2000 = 2451545.0;

export type SunEvent = 'sunrise' | 'sunset';

export interface SunTimes {
  /** Epoch ms, or null when the sun does not rise/set that day (polar day/night). */
  sunrise: number | null;
  sunset: number | null;
}

/**
 * Sunrise and sunset of a local calendar day at a position.
 *
 * `year`, `month` (1-12) and `day` are the calendar day where the mower is (the
 * schedule's zone); the solar day used is the one whose noon falls on that
 * date at this longitude, so the result belongs to that day for any sane zone.
 */
export function sunTimes(year: number, month: number, day: number, lat: number, lng: number): SunTimes {
  // Days since J2000 at noon UTC of the date, then shifted to local mean solar noon.
  const jdNoonUtc = Date.UTC(year, month - 1, day, 12) / MS_PER_DAY + JD_UNIX_EPOCH;
  const n = Math.round(jdNoonUtc - J2000);
  const jStar = n - lng / 360;

  const M = ((357.5291 + 0.98560028 * jStar) % 360 + 360) % 360;
  const C = 1.9148 * Math.sin(M * DEG) + 0.02 * Math.sin(2 * M * DEG) + 0.0003 * Math.sin(3 * M * DEG);
  const lambda = ((M + C + 180 + 102.9372) % 360 + 360) % 360;
  const jTransit = J2000 + jStar + 0.0053 * Math.sin(M * DEG) - 0.0069 * Math.sin(2 * lambda * DEG);

  const sinDecl = Math.sin(lambda * DEG) * Math.sin(23.4397 * DEG);
  const cosDecl = Math.cos(Math.asin(sinDecl));
  // -0.833°: refraction plus the sun's radius (the moment the top edge touches the horizon).
  const cosOmega = (Math.sin(-0.833 * DEG) - Math.sin(lat * DEG) * sinDecl) / (Math.cos(lat * DEG) * cosDecl);
  if (!Number.isFinite(cosOmega) || cosOmega < -1 || cosOmega > 1) {
    return { sunrise: null, sunset: null };
  }
  const omega = Math.acos(cosOmega) / DEG;
  const toMs = (jd: number) => Math.round((jd - JD_UNIX_EPOCH) * MS_PER_DAY);
  return {
    sunrise: toMs(jTransit - omega / 360),
    sunset: toMs(jTransit + omega / 360),
  };
}

/** Largest offset (minutes, either way) a schedule may keep from the sun event:
 *  keeps the start on the same calendar day for every sunrise and sunset. */
export const MAX_SUN_OFFSET_MIN = 180;

export function isSunEvent(v: unknown): v is SunEvent {
  return v === 'sunrise' || v === 'sunset';
}
