/**
 * Weather service — Open-Meteo API integration voor regencheck.
 * Gratis API, geen key nodig.
 */

export interface HourlyForecast {
  time: string;                 // lokale ISO-tijd van de locatie (Open-Meteo timezone=auto)
  epochMs: number;              // absolute tijd; onafhankelijk van de server-TZ
  precipitation: number;        // mm
  precipitationProbability: number; // 0-100
  temperatureC: number;
}

export interface WeatherForecast {
  hourly: HourlyForecast[];
  sunriseMs: number;            // vandaag, op de locatie
  sunsetMs: number;
  cachedAt: number;
}

/** Open-Meteo geeft met timezone=auto lokale tijden zonder offset ("2026-09-19T07:22").
 *  `new Date()` zou die in de server-TZ parsen; hier expliciet via utc_offset_seconds. */
function localIsoToEpochMs(iso: string, utcOffsetSeconds: number): number {
  const [d, t = '00:00'] = iso.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, day, hh, mm) - utcOffsetSeconds * 1000;
}

// In-memory cache per locatie (afgerond op 0.01°)
const cache = new Map<string, WeatherForecast>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minuten

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)}_${lng.toFixed(2)}`;
}

export async function getWeatherForecast(lat: number, lng: number): Promise<WeatherForecast> {
  const key = cacheKey(lat, lng);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached;
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation,precipitation_probability,temperature_2m&daily=sunrise,sunset&forecast_days=1&timezone=auto`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Open-Meteo API error: ${resp.status}`);
  }

  const data = await resp.json() as {
    utc_offset_seconds: number;
    hourly: {
      time: string[];
      precipitation: number[];
      precipitation_probability: number[];
      temperature_2m: number[];
    };
    daily: { sunrise: string[]; sunset: string[] };
  };
  const off = data.utc_offset_seconds ?? 0;

  const hourly: HourlyForecast[] = data.hourly.time.map((t, i) => ({
    time: t,
    epochMs: localIsoToEpochMs(t, off),
    precipitation: data.hourly.precipitation[i] ?? 0,
    precipitationProbability: data.hourly.precipitation_probability[i] ?? 0,
    temperatureC: data.hourly.temperature_2m?.[i] ?? NaN,
  }));

  const forecast: WeatherForecast = {
    hourly,
    sunriseMs: localIsoToEpochMs(data.daily.sunrise[0], off),
    sunsetMs: localIsoToEpochMs(data.daily.sunset[0], off),
    cachedAt: Date.now(),
  };
  cache.set(key, forecast);
  return forecast;
}

/**
 * Bepaal of maaien gepauzeerd moet worden op basis van weersvoorspelling.
 * Kijkt naar de komende `hoursAhead` uren.
 */
export function shouldPauseForRain(
  forecast: WeatherForecast,
  thresholdMm: number,
  thresholdProbability: number,
  hoursAhead: number,
): boolean {
  const now = Date.now();
  const cutoff = now + hoursAhead * 60 * 60 * 1000;

  for (const h of forecast.hourly) {
    if (h.epochMs < now) continue;
    if (h.epochMs > cutoff) break;

    if (h.precipitation >= thresholdMm || h.precipitationProbability >= thresholdProbability) {
      return true;
    }
  }
  return false;
}

/** Nachtbewaking: `nowMs` valt vóór zonsopkomst of ná zonsondergang van vandaag.
 *  Bedoeld voor egels en ander nachtdieren; wij ondersteunen nachtmaaien juist,
 *  dus dit is een expliciete gebruikerskeuze. */
export function isNight(forecast: WeatherForecast, nowMs: number): boolean {
  return nowMs < forecast.sunriseMs || nowMs > forecast.sunsetMs;
}

/** Vorstbewaking: het koudste uur rond `nowMs` (±1 u, dus het lopende en het
 *  volgende uur) ligt onder de drempel. Ontbrekende temperatuur telt niet mee. */
export function isFrostExpected(forecast: WeatherForecast, thresholdC: number, nowMs: number): boolean {
  const HOUR = 60 * 60 * 1000;
  return forecast.hourly.some(h =>
    h.epochMs >= nowMs - HOUR && h.epochMs <= nowMs + HOUR
    && Number.isFinite(h.temperatureC) && h.temperatureC < thresholdC);
}
