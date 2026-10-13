import { describe, it, expect } from 'vitest';
import { isNight, isFrostExpected, shouldPauseForRain, type WeatherForecast } from '../../services/weatherService.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 19, 5, 0); // 05:00 UTC

function forecast(temps: number[]): WeatherForecast {
  return {
    hourly: temps.map((t, i) => ({
      time: '', epochMs: T0 + i * HOUR, precipitation: 0, precipitationProbability: 0, temperatureC: t,
    })),
    sunriseMs: T0 + 2 * HOUR,   // 07:00
    sunsetMs: T0 + 14 * HOUR,   // 19:00
    cachedAt: 0,
  };
}

describe('night guard', () => {
  it('is night before sunrise and after sunset, day in between', () => {
    const f = forecast([]);
    expect(isNight(f, T0 + 1 * HOUR)).toBe(true);
    expect(isNight(f, T0 + 2 * HOUR)).toBe(false);
    expect(isNight(f, T0 + 10 * HOUR)).toBe(false);
    expect(isNight(f, T0 + 15 * HOUR)).toBe(true);
  });
});

describe('frost guard', () => {
  it('looks at the current and next hour only', () => {
    const f = forecast([1, 5, 5, 5, 1]); // 05:00 cold, 09:00 cold
    expect(isFrostExpected(f, 3, T0 + 0.5 * HOUR)).toBe(true);   // 05:30: uur 05:00 telt mee
    expect(isFrostExpected(f, 3, T0 + 2 * HOUR)).toBe(false);    // 07:00: 06/07/08 zijn 5°C
    expect(isFrostExpected(f, 3, T0 + 3.5 * HOUR)).toBe(true);   // 08:30: 09:00 telt mee
  });
  it('ignores missing temperatures', () => {
    expect(isFrostExpected(forecast([NaN, NaN]), 3, T0)).toBe(false);
  });
});

describe('rain check (#156)', () => {
  // Open-Meteo: the 06:00 slot is the rain of 05:00-06:00.
  const rain = (mm: number[]): WeatherForecast => ({
    hourly: mm.map((p, i) => ({ time: '', epochMs: T0 + i * HOUR, precipitation: p, precipitationProbability: 0, temperatureC: 10 })),
    sunriseMs: 0, sunsetMs: 0, cachedAt: 0,
  });
  it('sees rain in the current hour, also in its first half', () => {
    const f = rain([0, 2, 0, 0]); // raining 05:00-06:00
    expect(shouldPauseForRain(f, 0.1, 50, 0.5, T0 + 0.25 * HOUR)).toBe(true);  // 05:15
    expect(shouldPauseForRain(f, 0.1, 50, 0.5, T0 + 0.75 * HOUR)).toBe(true);  // 05:45
  });
  it('looks no further than the window', () => {
    const f = rain([0, 0, 0, 2]); // rain 07:00-08:00
    expect(shouldPauseForRain(f, 0.1, 50, 0.5, T0 + 0.25 * HOUR)).toBe(false); // 05:15
    expect(shouldPauseForRain(f, 0.1, 50, 0.5, T0 + 1.75 * HOUR)).toBe(true);  // 06:45: within 0.5 h
    expect(shouldPauseForRain(rain([0, 0, 0, 0]), 0.1, 50, 2, T0)).toBe(false);
  });
});
