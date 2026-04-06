/**
 * Weather service — Open-Meteo API integration voor regencheck.
 * Gratis API, geen key nodig.
 */

export interface HourlyForecast {
  time: string;
  precipitation: number;        // mm
  precipitationProbability: number; // 0-100
}

export interface WeatherForecast {
  hourly: HourlyForecast[];
  cachedAt: number;
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

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation,precipitation_probability&forecast_days=1&timezone=auto`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Open-Meteo API error: ${resp.status}`);
  }

  const data = await resp.json() as {
    hourly: {
      time: string[];
      precipitation: number[];
      precipitation_probability: number[];
    };
  };

  const hourly: HourlyForecast[] = data.hourly.time.map((t, i) => ({
    time: t,
    precipitation: data.hourly.precipitation[i] ?? 0,
    precipitationProbability: data.hourly.precipitation_probability[i] ?? 0,
  }));

  const forecast: WeatherForecast = { hourly, cachedAt: Date.now() };
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
  const now = new Date();
  const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  for (const h of forecast.hourly) {
    const t = new Date(h.time);
    if (t < now) continue;
    if (t > cutoff) break;

    if (h.precipitation >= thresholdMm || h.precipitationProbability >= thresholdProbability) {
      return true;
    }
  }
  return false;
}
