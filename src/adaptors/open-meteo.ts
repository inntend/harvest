import { z } from 'zod';
import type { Adaptor, Range, Reading } from '../types';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

// ERA5 archive has a ~5-day processing delay. Dates within that lag are served
// by the forecast endpoint (which has live NWP data); older dates use the
// archive endpoint (ERA5 reanalysis, no nulls, goes back to 1940).
const ARCHIVE_LAG_DAYS = 5;

// Daily aggregate variables fetched for a range.
const DAILY_VARS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'temperature_2m_mean',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'apparent_temperature_mean',
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
    description:
      'Daily weather for a location (fixed coordinates or a GPS history) from Open-Meteo.',
    read: {
      temperature_2m_max: {
        unit: 'C',
        label: 'Max Temperature',
        min: -100,
        max: 80,
      },
      temperature_2m_min: {
        unit: 'C',
        label: 'Min Temperature',
        min: -100,
        max: 80,
      },
      temperature_2m_mean: {
        unit: 'C',
        label: 'Average Temperature',
        min: -100,
        max: 80,
      },
      apparent_temperature_max: {
        unit: 'C',
        label: 'Max Feels-like Temperature',
        min: -100,
        max: 80,
      },
      apparent_temperature_min: {
        unit: 'C',
        label: 'Min Feels-like Temperature',
        min: -100,
        max: 80,
      },
      apparent_temperature_mean: {
        unit: 'C',
        label: 'Feels-like Temperature',
        min: -100,
        max: 80,
      },
      precipitation_sum: { unit: 'mm', label: 'Precipitation', min: 0 },
      rain_sum: { unit: 'mm', label: 'Rain', min: 0 },
      snowfall_sum: { unit: 'cm', label: 'Snowfall', min: 0 },
      precipitation_hours: { unit: 'h', label: 'Precipitation Hours', min: 0 },
      wind_speed_10m_max: { unit: 'km/h', label: 'Max Wind Speed', min: 0 },
      wind_gusts_10m_max: { unit: 'km/h', label: 'Max Wind Gusts', min: 0 },
      wind_direction_10m_dominant: {
        unit: 'deg',
        label: 'Wind Direction',
        min: 0,
        max: 360,
      },
      shortwave_radiation_sum: {
        unit: 'MJ/m2',
        label: 'Shortwave Radiation',
        min: 0,
      },
      uv_index_max: { unit: '', label: 'UV Index', min: 0 },
      weather_code: { unit: '', label: 'Weather Code', min: 0, max: 99 },
      sunshine_duration: { unit: 's', label: 'Sunshine Duration', min: 0 },
      daylight_duration: { unit: 's', label: 'Daylight Duration', min: 0 },
    },
    write: {},
    // Coordinates may be fixed (bootstrap) or driven by a GPS history series.
    inputs: {
      latitude: { unit: 'deg', label: 'Latitude', min: -90, max: 90 },
      longitude: { unit: 'deg', label: 'Longitude', min: -180, max: 180 },
    },
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
  // Split at the archive lag boundary to avoid nulls from the forecast endpoint
  // for dates older than ~ARCHIVE_LAG_DAYS. String comparison is safe here
  // since both sides produce YYYY-MM-DD.
  const today = new Date();
  const cutoff = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - ARCHIVE_LAG_DAYS,
    ),
  );
  const cutoffStr = isoDate(cutoff);
  const dayAfterCutoffStr = isoDate(new Date(cutoff.getTime() + 86_400_000));

  const fromStr = isoDate(range.from);
  const toStr = isoDate(range.to);

  const fetches: Promise<Reading[]>[] = [];

  if (fromStr <= cutoffStr) {
    const archiveTo = toStr <= cutoffStr ? toStr : cutoffStr;
    fetches.push(
      fetchEndpoint(
        ARCHIVE_URL,
        latitude,
        longitude,
        timezone,
        fromStr,
        archiveTo,
      ),
    );
  }

  if (toStr > cutoffStr) {
    const forecastFrom = fromStr > cutoffStr ? fromStr : dayAfterCutoffStr;
    fetches.push(
      fetchEndpoint(
        FORECAST_URL,
        latitude,
        longitude,
        timezone,
        forecastFrom,
        toStr,
      ),
    );
  }

  return (await Promise.all(fetches)).flat();
}

async function fetchEndpoint(
  url: string,
  latitude: number,
  longitude: number,
  timezone: string,
  startDate: string,
  endDate: string,
): Promise<Reading[]> {
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    timezone,
    start_date: startDate,
    end_date: endDate,
    daily: DAILY_VARS.join(','),
  });

  const res = await fetch(`${url}?${params}`);
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
