import { z } from 'zod';
import type { Adaptor } from '../types';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

// Variables available as "current" in the forecast API
const CURRENT_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'apparent_temperature',
  'is_day',
  'precipitation_probability',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'snow_depth',
  'weather_code',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'pressure_msl',
  'surface_pressure',
  'visibility',
  'evapotranspiration',
  'et0_fao_evapotranspiration',
  'vapour_pressure_deficit',
  'wind_speed_10m',
  'wind_speed_80m',
  'wind_speed_120m',
  'wind_speed_180m',
  'wind_direction_10m',
  'wind_direction_80m',
  'wind_direction_120m',
  'wind_direction_180m',
  'wind_gusts_10m',
  'temperature_80m',
  'temperature_120m',
  'temperature_180m',
  'shortwave_radiation',
  'shortwave_radiation_instant',
  'direct_radiation',
  'direct_radiation_instant',
  'diffuse_radiation',
  'diffuse_radiation_instant',
  'direct_normal_irradiance',
  'direct_normal_irradiance_instant',
  'terrestrial_radiation',
  'terrestrial_radiation_instant',
  'sunshine_duration',
  'cape',
  'convective_inhibition',
  'freezing_level_height',
  'uv_index',
  'uv_index_clear_sky',
  'soil_temperature_0cm',
  'soil_temperature_6cm',
  'soil_temperature_18cm',
  'soil_temperature_54cm',
  'soil_moisture_0_to_1cm',
  'soil_moisture_1_to_3cm',
  'soil_moisture_3_to_9cm',
  'soil_moisture_9_to_27cm',
  'soil_moisture_27_to_81cm',
] as const;

// Daily variables available from the forecast API (includes probability forecasts)
const FORECAST_DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'sunrise',
  'sunset',
  'daylight_duration',
  'sunshine_duration',
  'uv_index_max',
  'uv_index_clear_sky_max',
  'precipitation_sum',
  'rain_sum',
  'showers_sum',
  'snowfall_sum',
  'precipitation_hours',
  'precipitation_probability_max',
  'precipitation_probability_min',
  'precipitation_probability_mean',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'shortwave_radiation_sum',
  'et0_fao_evapotranspiration',
] as const;

// ERA5/ERA5-Land hourly variables available from the archive API
// (excludes forecast-only fields: precipitation_probability, upper-level wind/temperature)
const ARCHIVE_HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'snow_depth',
  'weather_code',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'pressure_msl',
  'surface_pressure',
  'visibility',
  'evapotranspiration',
  'et0_fao_evapotranspiration',
  'vapour_pressure_deficit',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'shortwave_radiation',
  'shortwave_radiation_instant',
  'direct_radiation',
  'direct_radiation_instant',
  'diffuse_radiation',
  'diffuse_radiation_instant',
  'direct_normal_irradiance',
  'direct_normal_irradiance_instant',
  'terrestrial_radiation',
  'terrestrial_radiation_instant',
  'sunshine_duration',
  'cape',
  'convective_inhibition',
  'freezing_level_height',
  'uv_index',
  'uv_index_clear_sky',
  'soil_temperature_0cm',
  'soil_temperature_6cm',
  'soil_temperature_18cm',
  'soil_temperature_54cm',
  'soil_moisture_0_to_1cm',
  'soil_moisture_1_to_3cm',
  'soil_moisture_3_to_9cm',
  'soil_moisture_9_to_27cm',
  'soil_moisture_27_to_81cm',
] as const;

// Daily variables available from the archive API (excludes probability forecasts)
const ARCHIVE_DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'sunrise',
  'sunset',
  'daylight_duration',
  'sunshine_duration',
  'uv_index_max',
  'uv_index_clear_sky_max',
  'precipitation_sum',
  'rain_sum',
  'showers_sum',
  'snowfall_sum',
  'precipitation_hours',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'shortwave_radiation_sum',
  'et0_fao_evapotranspiration',
] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const config = z.object({
  latitude: z.number().min(-90).max(90).describe('Location latitude'),
  longitude: z.number().min(-180).max(180).describe('Location longitude'),
  timezone: z
    .string()
    .default('auto')
    .describe('Timezone (e.g. "Europe/Berlin" or "auto")'),
  resolution: z
    .enum(['current', 'daily', 'hourly'])
    .default('current')
    .describe(
      '"current" = live conditions; "daily" = one aggregate per day in range; "hourly" = one reading per hour in range',
    ),
  startDate: z
    .string()
    .regex(DATE_PATTERN, 'Must be YYYY-MM-DD')
    .optional()
    .describe(
      'Range start date (YYYY-MM-DD) — required for daily and hourly resolution',
    ),
  endDate: z
    .string()
    .regex(DATE_PATTERN, 'Must be YYYY-MM-DD')
    .optional()
    .describe(
      'Range end date (YYYY-MM-DD) — required for daily and hourly resolution',
    ),
});

export const openMeteoAdaptor: Adaptor<typeof config.shape> = {
  id: 'open-meteo',
  name: 'Open-Meteo Weather',
  schedule: '0 * * * *', // every hour
  config,

  def: {
    properties: {},
    read: {
      // ── Current conditions (resolution: "current") ───────────────────────
      // Surface atmosphere
      temperature_2m: { unit: 'C', min: -80, max: 60 },
      relative_humidity_2m: { unit: '%', min: 0, max: 100 },
      dew_point_2m: { unit: 'C', min: -80, max: 60 },
      apparent_temperature: { unit: 'C', min: -80, max: 60 },
      is_day: { unit: '', min: 0, max: 1 },
      weather_code: { unit: '', min: 0, max: 99 },
      // Precipitation
      precipitation_probability: { unit: '%', min: 0, max: 100 },
      precipitation: { unit: 'mm', min: 0 },
      rain: { unit: 'mm', min: 0 },
      showers: { unit: 'mm', min: 0 },
      snowfall: { unit: 'cm', min: 0 },
      snow_depth: { unit: 'm', min: 0 },
      evapotranspiration: { unit: 'mm', min: 0 },
      et0_fao_evapotranspiration: { unit: 'mm', min: 0 },
      // Clouds & pressure
      cloud_cover: { unit: '%', min: 0, max: 100 },
      cloud_cover_low: { unit: '%', min: 0, max: 100 },
      cloud_cover_mid: { unit: '%', min: 0, max: 100 },
      cloud_cover_high: { unit: '%', min: 0, max: 100 },
      pressure_msl: { unit: 'hPa', min: 870, max: 1090 },
      surface_pressure: { unit: 'hPa', min: 870, max: 1090 },
      vapour_pressure_deficit: { unit: 'kPa', min: 0 },
      // Visibility
      visibility: { unit: 'm', min: 0 },
      // Wind at multiple levels
      wind_speed_10m: { unit: 'km/h', min: 0 },
      wind_speed_80m: { unit: 'km/h', min: 0 },
      wind_speed_120m: { unit: 'km/h', min: 0 },
      wind_speed_180m: { unit: 'km/h', min: 0 },
      wind_direction_10m: { unit: 'deg', min: 0, max: 360 },
      wind_direction_80m: { unit: 'deg', min: 0, max: 360 },
      wind_direction_120m: { unit: 'deg', min: 0, max: 360 },
      wind_direction_180m: { unit: 'deg', min: 0, max: 360 },
      wind_gusts_10m: { unit: 'km/h', min: 0 },
      // Temperature at altitude
      temperature_80m: { unit: 'C', min: -80, max: 60 },
      temperature_120m: { unit: 'C', min: -80, max: 60 },
      temperature_180m: { unit: 'C', min: -80, max: 60 },
      // Solar radiation
      shortwave_radiation: { unit: 'W/m2', min: 0 },
      shortwave_radiation_instant: { unit: 'W/m2', min: 0 },
      direct_radiation: { unit: 'W/m2', min: 0 },
      direct_radiation_instant: { unit: 'W/m2', min: 0 },
      diffuse_radiation: { unit: 'W/m2', min: 0 },
      diffuse_radiation_instant: { unit: 'W/m2', min: 0 },
      direct_normal_irradiance: { unit: 'W/m2', min: 0 },
      direct_normal_irradiance_instant: { unit: 'W/m2', min: 0 },
      terrestrial_radiation: { unit: 'W/m2', min: 0 },
      terrestrial_radiation_instant: { unit: 'W/m2', min: 0 },
      sunshine_duration: { unit: 's', min: 0 },
      uv_index: { unit: '', min: 0 },
      uv_index_clear_sky: { unit: '', min: 0 },
      // Atmospheric instability
      cape: { unit: 'J/kg', min: 0 },
      convective_inhibition: { unit: 'J/kg' },
      freezing_level_height: { unit: 'm', min: 0 },
      // Soil
      soil_temperature_0cm: { unit: 'C', min: -80, max: 60 },
      soil_temperature_6cm: { unit: 'C', min: -80, max: 60 },
      soil_temperature_18cm: { unit: 'C', min: -80, max: 60 },
      soil_temperature_54cm: { unit: 'C', min: -80, max: 60 },
      soil_moisture_0_to_1cm: { unit: 'm3/m3', min: 0, max: 1 },
      soil_moisture_1_to_3cm: { unit: 'm3/m3', min: 0, max: 1 },
      soil_moisture_3_to_9cm: { unit: 'm3/m3', min: 0, max: 1 },
      soil_moisture_9_to_27cm: { unit: 'm3/m3', min: 0, max: 1 },
      soil_moisture_27_to_81cm: { unit: 'm3/m3', min: 0, max: 1 },
      // Today's daily aggregates (daily_ prefix, only populated in "current" mode)
      daily_weather_code: { unit: '', min: 0, max: 99 },
      daily_temperature_2m_max: { unit: 'C', min: -80, max: 60 },
      daily_temperature_2m_min: { unit: 'C', min: -80, max: 60 },
      daily_apparent_temperature_max: { unit: 'C', min: -80, max: 60 },
      daily_apparent_temperature_min: { unit: 'C', min: -80, max: 60 },
      daily_sunrise: { unit: 'unixtime', min: 0 },
      daily_sunset: { unit: 'unixtime', min: 0 },
      daily_daylight_duration: { unit: 's', min: 0 },
      daily_sunshine_duration: { unit: 's', min: 0 },
      daily_uv_index_max: { unit: '', min: 0 },
      daily_uv_index_clear_sky_max: { unit: '', min: 0 },
      daily_precipitation_sum: { unit: 'mm', min: 0 },
      daily_rain_sum: { unit: 'mm', min: 0 },
      daily_showers_sum: { unit: 'mm', min: 0 },
      daily_snowfall_sum: { unit: 'cm', min: 0 },
      daily_precipitation_hours: { unit: 'h', min: 0 },
      daily_precipitation_probability_max: { unit: '%', min: 0, max: 100 },
      daily_precipitation_probability_min: { unit: '%', min: 0, max: 100 },
      daily_precipitation_probability_mean: { unit: '%', min: 0, max: 100 },
      daily_wind_speed_10m_max: { unit: 'km/h', min: 0 },
      daily_wind_gusts_10m_max: { unit: 'km/h', min: 0 },
      daily_wind_direction_10m_dominant: { unit: 'deg', min: 0, max: 360 },
      daily_shortwave_radiation_sum: { unit: 'MJ/m2', min: 0 },
      daily_et0_fao_evapotranspiration: { unit: 'mm', min: 0 },
      // ── Historical period keys (d{N}_ / h{N}_) are not enumerated here
      // because the count is dynamic. The scheduler transform strips unknown
      // keys; use fetch() directly to consume period data.
    },
    write: {},
  },

  async fetch(cfg) {
    switch (cfg.resolution) {
      case 'daily':
        if (!cfg.startDate || !cfg.endDate)
          throw new Error(
            'startDate and endDate are required for daily resolution',
          );
        return fetchHistoricalDaily(
          cfg.latitude,
          cfg.longitude,
          cfg.timezone,
          cfg.startDate,
          cfg.endDate,
        );
      case 'hourly':
        if (!cfg.startDate || !cfg.endDate)
          throw new Error(
            'startDate and endDate are required for hourly resolution',
          );
        return fetchHistoricalHourly(
          cfg.latitude,
          cfg.longitude,
          cfg.timezone,
          cfg.startDate,
          cfg.endDate,
        );
      default:
        return fetchCurrent(cfg.latitude, cfg.longitude, cfg.timezone);
    }
  },
};

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchCurrent(
  latitude: number,
  longitude: number,
  timezone: string,
): Promise<Record<string, number>> {
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    timezone,
    current: CURRENT_VARS.join(','),
    daily: FORECAST_DAILY_VARS.join(','),
    forecast_days: '1',
  });

  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok)
    throw new Error(`open-meteo HTTP ${res.status}: ${res.statusText}`);

  const json = (await res.json()) as {
    current?: Record<string, number | null>;
    daily?: Record<string, Array<number | string | null>>;
    utc_offset_seconds?: number;
  };

  const result: Record<string, number> = {};

  if (json.current) {
    for (const [key, value] of Object.entries(json.current)) {
      if (key === 'time' || key === 'interval') continue;
      if (typeof value === 'number') result[key] = value;
    }
  }

  // Today's daily aggregates prefixed with "daily_"
  parseDailyBlock(json.daily, json.utc_offset_seconds ?? 0, (key, value) => {
    result[`daily_${key}`] = value;
  });

  return result;
}

async function fetchHistoricalDaily(
  latitude: number,
  longitude: number,
  timezone: string,
  startDate: string,
  endDate: string,
): Promise<Record<string, number>> {
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    timezone,
    start_date: startDate,
    end_date: endDate,
    daily: ARCHIVE_DAILY_VARS.join(','),
  });

  const res = await fetch(`${ARCHIVE_URL}?${params}`);
  if (!res.ok)
    throw new Error(`open-meteo archive HTTP ${res.status}: ${res.statusText}`);

  const json = (await res.json()) as {
    daily?: Record<string, Array<number | string | null>>;
    utc_offset_seconds?: number;
  };

  const result: Record<string, number> = {};

  // Each day in the range becomes a d{N}_ prefixed group
  parseDailyBlock(
    json.daily,
    json.utc_offset_seconds ?? 0,
    (key, value, dayIndex) => {
      result[`d${dayIndex}_${key}`] = value;
    },
  );

  return result;
}

async function fetchHistoricalHourly(
  latitude: number,
  longitude: number,
  timezone: string,
  startDate: string,
  endDate: string,
): Promise<Record<string, number>> {
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    timezone,
    start_date: startDate,
    end_date: endDate,
    hourly: ARCHIVE_HOURLY_VARS.join(','),
  });

  const res = await fetch(`${ARCHIVE_URL}?${params}`);
  if (!res.ok)
    throw new Error(`open-meteo archive HTTP ${res.status}: ${res.statusText}`);

  const json = (await res.json()) as {
    hourly?: Record<string, Array<number | null>>;
  };

  const result: Record<string, number> = {};

  if (json.hourly) {
    for (const [key, values] of Object.entries(json.hourly)) {
      if (key === 'time') continue;
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (typeof value === 'number') result[`h${i}_${key}`] = value;
      }
    }
  }

  return result;
}

// ── Shared parsing ────────────────────────────────────────────────────────────

type DailyCallback = (key: string, value: number, dayIndex: number) => void;

function parseDailyBlock(
  daily: Record<string, Array<number | string | null>> | undefined,
  utcOffsetSeconds: number,
  emit: DailyCallback,
): void {
  if (!daily) return;

  // Use the time array length as the authoritative day count; fall back to
  // each array's own length so no data is lost when time is absent.
  const dayCount = Array.isArray(daily.time) ? daily.time.length : undefined;

  for (const [key, values] of Object.entries(daily)) {
    if (key === 'time') continue;
    const count = dayCount ?? values.length;
    for (let i = 0; i < count; i++) {
      const value = values[i];
      if (key === 'sunrise' || key === 'sunset') {
        // API returns local-timezone strings without offset info (e.g. "2024-01-15T08:23").
        // Append ":00Z" to form a valid UTC ISO string, then subtract utc_offset_seconds
        // to recover the true UTC instant.
        if (typeof value === 'string') {
          const localAsUtcMs = new Date(value + ':00Z').getTime();
          emit(
            key,
            Math.floor((localAsUtcMs - utcOffsetSeconds * 1000) / 1000),
            i,
          );
        }
      } else if (typeof value === 'number') {
        emit(key, value, i);
      }
    }
  }
}
