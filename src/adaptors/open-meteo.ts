import { z } from 'zod';
import type { Adaptor, Range, Reading } from '../types';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// Daily aggregate variables fetched for a range. The forecast endpoint serves
// daily data for roughly the past ~92 days plus the forecast window, which
// covers the typical chart range (a month or so back, including today).
const DAILY_VARS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'precipitation_sum',
  'rain_sum',
  'snowfall_sum',
  'precipitation_hours',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'shortwave_radiation_sum',
  'uv_index_max',
  'weather_code',
  'sunshine_duration',
  'daylight_duration',
] as const;

const config = z.object({
  latitude: z.number().min(-90).max(90).describe('Location latitude'),
  longitude: z.number().min(-180).max(180).describe('Location longitude'),
  timezone: z
    .string()
    .default('auto')
    .describe('Timezone (e.g. "Europe/Berlin" or "auto")'),
});

export const openMeteoAdaptor: Adaptor<typeof config.shape> = {
  id: 'open-meteo',
  name: 'Open-Meteo Weather',
  config,

  def: {
    properties: {},
    read: {
      temperature_2m_max: { unit: 'C', min: -80, max: 60 },
      temperature_2m_min: { unit: 'C', min: -80, max: 60 },
      apparent_temperature_max: { unit: 'C', min: -80, max: 60 },
      apparent_temperature_min: { unit: 'C', min: -80, max: 60 },
      precipitation_sum: { unit: 'mm', min: 0 },
      rain_sum: { unit: 'mm', min: 0 },
      snowfall_sum: { unit: 'cm', min: 0 },
      precipitation_hours: { unit: 'h', min: 0 },
      wind_speed_10m_max: { unit: 'km/h', min: 0 },
      wind_gusts_10m_max: { unit: 'km/h', min: 0 },
      wind_direction_10m_dominant: { unit: 'deg', min: 0, max: 360 },
      shortwave_radiation_sum: { unit: 'MJ/m2', min: 0 },
      uv_index_max: { unit: '', min: 0 },
      weather_code: { unit: '', min: 0, max: 99 },
      sunshine_duration: { unit: 's', min: 0 },
      daylight_duration: { unit: 's', min: 0 },
    },
    write: {},
  },

  async fetch(cfg, range) {
    return fetchDaily(cfg.latitude, cfg.longitude, cfg.timezone, range);
  },
};

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchDaily(
  latitude: number,
  longitude: number,
  timezone: string,
  range: Range,
): Promise<Reading[]> {
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    timezone,
    start_date: isoDate(range.from),
    end_date: isoDate(range.to),
    daily: DAILY_VARS.join(','),
  });

  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok)
    throw new Error(`open-meteo HTTP ${res.status}: ${res.statusText}`);

  const json = (await res.json()) as {
    daily?: Record<string, Array<number | string | null>>;
  };
  const daily = json.daily;
  const times = Array.isArray(daily?.time) ? (daily.time as string[]) : [];

  const readings: Reading[] = [];
  for (let i = 0; i < times.length; i++) {
    const values: Record<string, number> = {};
    for (const key of DAILY_VARS) {
      const v = daily?.[key]?.[i];
      if (typeof v === 'number') values[key] = v;
    }
    // Stamp at local noon of the calendar day so day-bucketing is stable
    // regardless of timezone.
    readings.push({
      timestamp: new Date(`${times[i]}T12:00:00`).toISOString(),
      values,
    });
  }
  return readings;
}

// Local YYYY-MM-DD for the open-meteo date params.
function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
