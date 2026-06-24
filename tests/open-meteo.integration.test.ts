import { describe, expect, it } from 'vitest';
import { openMeteoAdaptor } from '../src/adaptors/open-meteo';

// Integration test: hits the live Open-Meteo archive (ERA5 reanalysis) API.
// A fixed historical period is used because ERA5 data for past dates is final
// and reproducible, so the retrieved values can be asserted exactly. The range
// is well beyond the ~5-day archive lag, so fetch() always routes to the
// archive endpoint.
//
// Berlin (52.52, 13.41), 2024-01-01 .. 2024-01-03, timezone Europe/Berlin.
const cfg = { latitude: 52.52, longitude: 13.41, timezone: 'Europe/Berlin' };
const RANGE = {
  from: new Date('2024-01-01T00:00:00Z'),
  to: new Date('2024-01-03T23:59:59Z'),
};

// Known-good daily values captured from the live archive API. uv_index_max is
// absent because ERA5 returns null for it (the adaptor drops non-numeric values).
const EXPECTED: Array<{ date: string; values: Record<string, number> }> = [
  {
    date: '2024-01-01',
    values: {
      temperature_2m_max: 7.3,
      temperature_2m_min: 3.4,
      temperature_2m_mean: 5.3,
      apparent_temperature_max: 4.0,
      apparent_temperature_min: -0.4,
      apparent_temperature_mean: 1.4,
      precipitation_sum: 1.8,
      rain_sum: 1.8,
      snowfall_sum: 0.0,
      precipitation_hours: 6.0,
      wind_speed_10m_max: 19.7,
      wind_gusts_10m_max: 36.0,
      wind_direction_10m_dominant: 218,
      shortwave_radiation_sum: 2.29,
      weather_code: 53,
      sunshine_duration: 18462.21,
      daylight_duration: 27883.96,
    },
  },
  {
    date: '2024-01-02',
    values: {
      temperature_2m_max: 6.9,
      temperature_2m_min: 2.5,
      temperature_2m_mean: 4.4,
      apparent_temperature_max: 4.1,
      apparent_temperature_min: -1.3,
      apparent_temperature_mean: 0.7,
      precipitation_sum: 7.2,
      rain_sum: 6.8,
      snowfall_sum: 0.28,
      precipitation_hours: 14.0,
      wind_speed_10m_max: 20.2,
      wind_gusts_10m_max: 35.6,
      wind_direction_10m_dominant: 167,
      shortwave_radiation_sum: 0.59,
      weather_code: 73,
      sunshine_duration: 0.0,
      daylight_duration: 27957.78,
    },
  },
  {
    date: '2024-01-03',
    values: {
      temperature_2m_max: 10.6,
      temperature_2m_min: 7.2,
      temperature_2m_mean: 8.7,
      apparent_temperature_max: 6.2,
      apparent_temperature_min: 3.3,
      apparent_temperature_mean: 4.4,
      precipitation_sum: 12.1,
      rain_sum: 12.1,
      snowfall_sum: 0.0,
      precipitation_hours: 13.0,
      wind_speed_10m_max: 27.8,
      wind_gusts_10m_max: 47.9,
      wind_direction_10m_dominant: 227,
      shortwave_radiation_sum: 1.7,
      weather_code: 63,
      sunshine_duration: 3789.2,
      daylight_duration: 28037.71,
    },
  },
];

// Hits the live API. Lives in the "integration" Vitest project, so it's skipped
// by the default `npm test` and run with `npm run test:integration`.
describe('openMeteoAdaptor (integration)', () => {
  it('retrieves correct daily data for a fixed historical period from the live archive API', async () => {
    const readings = await openMeteoAdaptor.fetch(cfg, RANGE);

    // One reading per calendar day in the range.
    expect(readings).toHaveLength(EXPECTED.length);

    readings.forEach((reading, i) => {
      const expected = EXPECTED[i];
      // Stamped at noon UTC of the expected calendar day.
      expect(reading.timestamp).toBe(`${expected.date}T12:00:00.000Z`);
      // Every retrieved value matches the known-good archive data exactly.
      expect(reading.values).toEqual(expected.values);
    });
  }, 30_000);
});
