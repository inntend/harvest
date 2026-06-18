import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMeteoAdaptor } from '../src/adaptors/open-meteo';

const RANGE = {
  from: new Date('2024-01-01T00:00:00Z'),
  to: new Date('2024-01-02T00:00:00Z'),
};
const values = (r: { values: Record<string, number> }[]) => r[0].values;

// ── Shared fixtures ───────────────────────────────────────────────────────────

const CURRENT = {
  time: '2024-01-15T14:00',
  interval: 900,
  temperature_2m: 12.5,
  relative_humidity_2m: 78,
  wind_speed_10m: 15.2,
  weather_code: 3,
  is_day: 1,
  shortwave_radiation: 320.5,
  uv_index: 2.1,
  soil_moisture_0_to_1cm: 0.42,
};

const DAILY_BLOCK = {
  time: ['2024-01-15'],
  temperature_2m_max: [15.1],
  temperature_2m_min: [8.3],
  apparent_temperature_max: [13.0],
  apparent_temperature_min: [5.9],
  sunrise: ['2024-01-15T08:23'],
  sunset: ['2024-01-15T16:47'],
  daylight_duration: [30240],
  precipitation_sum: [0.4],
  wind_speed_10m_max: [22.4],
  wind_direction_10m_dominant: [210],
  weather_code: [61],
};

function makeHourlyBlock(days = 1) {
  const hours = days * 24;
  return {
    time: Array.from({ length: hours }, (_, i) => {
      const d = Math.floor(i / 24);
      const h = i % 24;
      return `2024-01-${String(15 + d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`;
    }),
    temperature_2m: Array.from({ length: hours }, (_, i) => 10 + i * 0.1),
    wind_speed_10m: Array.from({ length: hours }, (_, i) => 5 + i * 0.05),
    weather_code: Array.from({ length: hours }, () => 2),
  };
}

function makeDailyBlock(days: number) {
  return {
    time: Array.from(
      { length: days },
      (_, i) => `2024-01-${String(15 + i).padStart(2, '0')}`,
    ),
    temperature_2m_max: Array.from({ length: days }, (_, i) => 15 + i),
    temperature_2m_min: Array.from({ length: days }, (_, i) => 8 + i),
    precipitation_sum: Array.from({ length: days }, (_, i) => i * 0.5),
    sunrise: Array.from(
      { length: days },
      (_, i) => `2024-01-${String(15 + i).padStart(2, '0')}T08:23`,
    ),
    sunset: Array.from(
      { length: days },
      (_, i) => `2024-01-${String(15 + i).padStart(2, '0')}T16:47`,
    ),
    weather_code: Array.from({ length: days }, () => 61),
  };
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Internal Server Error',
    json: async () => body,
  });
}

function calledUrl(): URL {
  return new URL(
    (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('openMeteoAdaptor', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('metadata', () => {
    it('has the expected id and name', () => {
      expect(openMeteoAdaptor.id).toBe('open-meteo');
      expect(openMeteoAdaptor.name).toBe('Open-Meteo Weather');
    });

    it('def has no write fields', () => {
      expect(openMeteoAdaptor.def.write).toEqual({});
    });

    it('def.read covers current and daily_ fields', () => {
      const keys = Object.keys(openMeteoAdaptor.def.read);
      expect(keys).toContain('temperature_2m');
      expect(keys).toContain('soil_moisture_0_to_1cm');
      expect(keys).toContain('daily_temperature_2m_max');
      expect(keys).toContain('daily_sunrise');
    });
  });

  describe('config schema', () => {
    it('rejects latitude out of range', () => {
      expect(() =>
        openMeteoAdaptor.config.parse({ latitude: 91, longitude: 0 }),
      ).toThrow();
      expect(() =>
        openMeteoAdaptor.config.parse({ latitude: -91, longitude: 0 }),
      ).toThrow();
    });

    it('rejects longitude out of range', () => {
      expect(() =>
        openMeteoAdaptor.config.parse({ latitude: 0, longitude: 181 }),
      ).toThrow();
    });

    it('defaults timezone to "auto" and resolution to "current"', () => {
      const cfg = openMeteoAdaptor.config.parse({
        latitude: 52.52,
        longitude: 13.41,
      });
      expect(cfg.timezone).toBe('auto');
      expect(cfg.resolution).toBe('current');
    });

    it('accepts valid date strings', () => {
      const cfg = openMeteoAdaptor.config.parse({
        latitude: 52.52,
        longitude: 13.41,
        resolution: 'daily',
        startDate: '2023-06-01',
        endDate: '2023-06-30',
      });
      expect(cfg.startDate).toBe('2023-06-01');
      expect(cfg.endDate).toBe('2023-06-30');
    });

    it('rejects malformed dates', () => {
      expect(() =>
        openMeteoAdaptor.config.parse({
          latitude: 0,
          longitude: 0,
          startDate: '15/06/2023',
        }),
      ).toThrow();
    });

    it('rejects unknown resolution values', () => {
      expect(() =>
        openMeteoAdaptor.config.parse({
          latitude: 0,
          longitude: 0,
          resolution: 'minutely',
        }),
      ).toThrow();
    });
  });

  // ── current ─────────────────────────────────────────────────────────────────

  describe('fetch() — current', () => {
    const cfg = {
      latitude: 52.52,
      longitude: 13.41,
      timezone: 'Europe/Berlin',
      resolution: 'current' as const,
    };

    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ current: CURRENT, daily: DAILY_BLOCK }),
      );
    });

    it('calls the forecast API URL with current and daily params', async () => {
      await openMeteoAdaptor.fetch(cfg, RANGE);

      const url = calledUrl();
      expect(url.origin + url.pathname).toBe(
        'https://api.open-meteo.com/v1/forecast',
      );
      expect(url.searchParams.get('latitude')).toBe('52.52');
      expect(url.searchParams.get('forecast_days')).toBe('1');
      expect(url.searchParams.get('current')).toBeTruthy();
      expect(url.searchParams.get('daily')).toBeTruthy();
    });

    it('returns current values as flat keys', async () => {
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(result.temperature_2m).toBe(12.5);
      expect(result.wind_speed_10m).toBe(15.2);
      expect(result.is_day).toBe(1);
      expect(result.shortwave_radiation).toBe(320.5);
    });

    it('strips the API envelope fields (time, interval)', async () => {
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(result).not.toHaveProperty('time');
      expect(result).not.toHaveProperty('interval');
    });

    it("returns today's daily aggregates prefixed with daily_", async () => {
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(result.daily_temperature_2m_max).toBe(15.1);
      expect(result.daily_precipitation_sum).toBe(0.4);
      expect(result.daily_weather_code).toBe(61);
      expect(result).not.toHaveProperty('daily_time');
    });

    it('converts sunrise/sunset to Unix timestamps', async () => {
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(result.daily_sunrise).toBe(
        Math.floor(new Date('2024-01-15T08:23:00Z').getTime() / 1000),
      );
      expect(result.daily_sunset).toBe(
        Math.floor(new Date('2024-01-15T16:47:00Z').getTime() / 1000),
      );
    });

    it('skips null values', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          current: { ...CURRENT, cape: null, convective_inhibition: null },
          daily: DAILY_BLOCK,
        }),
      );

      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(result).not.toHaveProperty('cape');
      expect(result.temperature_2m).toBe(12.5);
    });

    it('throws on non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 500));

      await expect(openMeteoAdaptor.fetch(cfg, RANGE)).rejects.toThrow('500');
    });

    it('handles a response with no current block', async () => {
      vi.stubGlobal('fetch', mockFetch({ daily: DAILY_BLOCK }));
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));
      expect(result).not.toHaveProperty('temperature_2m');
      expect(result.daily_temperature_2m_max).toBe(15.1);
    });

    it('handles a response with no daily block', async () => {
      vi.stubGlobal('fetch', mockFetch({ current: CURRENT }));
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));
      expect(result.temperature_2m).toBe(12.5);
      expect(result).not.toHaveProperty('daily_temperature_2m_max');
    });

    it('falls back to dayCount=1 when daily block has no time array', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          current: CURRENT,
          daily: { temperature_2m_max: [15.1], precipitation_sum: [0.4] },
        }),
      );
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));
      expect(result.daily_temperature_2m_max).toBe(15.1);
      expect(result.daily_precipitation_sum).toBe(0.4);
    });

    it('skips null sunrise and sunset values', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          current: CURRENT,
          daily: { ...DAILY_BLOCK, sunrise: [null], sunset: [null] },
        }),
      );
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));
      expect(result).not.toHaveProperty('daily_sunrise');
      expect(result).not.toHaveProperty('daily_sunset');
      expect(result.daily_temperature_2m_max).toBe(15.1);
    });
  });

  // ── daily (historical) ───────────────────────────────────────────────────────

  describe('fetch() — daily resolution', () => {
    const cfg = {
      latitude: 42.7,
      longitude: 23.32,
      timezone: 'Europe/Sofia',
      resolution: 'daily' as const,
      startDate: '2024-01-15',
      endDate: '2024-01-17',
    };

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch({ daily: makeDailyBlock(3) }));
    });

    it('calls the archive API with start_date and end_date', async () => {
      await openMeteoAdaptor.fetch(cfg, RANGE);

      const url = calledUrl();
      expect(url.origin + url.pathname).toBe(
        'https://archive-api.open-meteo.com/v1/archive',
      );
      expect(url.searchParams.get('start_date')).toBe('2024-01-15');
      expect(url.searchParams.get('end_date')).toBe('2024-01-17');
      expect(url.searchParams.get('daily')).toBeTruthy();
      expect(url.searchParams.get('current')).toBeNull();
      expect(url.searchParams.get('forecast_days')).toBeNull();
    });

    it('returns each day as a d{N}_ prefixed group', async () => {
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      // d0 = first day
      expect(result.d0_temperature_2m_max).toBe(15);
      expect(result.d0_temperature_2m_min).toBe(8);
      expect(result.d0_precipitation_sum).toBe(0);

      // d1 = second day
      expect(result.d1_temperature_2m_max).toBe(16);
      expect(result.d1_precipitation_sum).toBe(0.5);

      // d2 = third day
      expect(result.d2_temperature_2m_max).toBe(17);
    });

    it('converts sunrise/sunset per day to Unix timestamps', async () => {
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(result.d0_sunrise).toBe(
        Math.floor(new Date('2024-01-15T08:23:00Z').getTime() / 1000),
      );
      expect(result.d1_sunrise).toBe(
        Math.floor(new Date('2024-01-16T08:23:00Z').getTime() / 1000),
      );
    });

    it('does not produce a d{N}_time key', async () => {
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(Object.keys(result).some((k) => k.endsWith('_time'))).toBe(false);
    });

    it('skips null daily values', async () => {
      const dailyWithNulls = { ...makeDailyBlock(1), cape: [null] };
      vi.stubGlobal('fetch', mockFetch({ daily: dailyWithNulls }));

      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(result).not.toHaveProperty('d0_cape');
    });

    it('handles a response with no daily block', async () => {
      vi.stubGlobal('fetch', mockFetch({}));
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));
      expect(result).toEqual({});
    });

    it('throws when startDate is missing', async () => {
      await expect(
        openMeteoAdaptor.fetch({ ...cfg, startDate: undefined }, RANGE),
      ).rejects.toThrow('startDate');
    });

    it('throws on non-ok archive HTTP response', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 404));

      await expect(openMeteoAdaptor.fetch(cfg, RANGE)).rejects.toThrow('404');
    });
  });

  // ── hourly (historical) ──────────────────────────────────────────────────────

  describe('fetch() — hourly resolution', () => {
    const cfg = {
      latitude: 42.7,
      longitude: 23.32,
      timezone: 'Europe/Sofia',
      resolution: 'hourly' as const,
      startDate: '2024-01-15',
      endDate: '2024-01-16',
    };

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch({ hourly: makeHourlyBlock(2) }));
    });

    it('calls the archive API with hourly param and no current/daily', async () => {
      await openMeteoAdaptor.fetch(cfg, RANGE);

      const url = calledUrl();
      expect(url.origin + url.pathname).toBe(
        'https://archive-api.open-meteo.com/v1/archive',
      );
      expect(url.searchParams.get('hourly')).toBeTruthy();
      expect(url.searchParams.get('current')).toBeNull();
      expect(url.searchParams.get('daily')).toBeNull();
    });

    it('returns each hour as an h{N}_ prefixed group', async () => {
      const hourly = makeHourlyBlock(2);
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      // 2 days = 48 hours
      expect(result.h0_temperature_2m).toBe(hourly.temperature_2m[0]);
      expect(result.h12_temperature_2m).toBe(hourly.temperature_2m[12]);
      expect(result.h47_temperature_2m).toBe(hourly.temperature_2m[47]);
      expect(result.h0_wind_speed_10m).toBe(hourly.wind_speed_10m[0]);
    });

    it('does not produce an h{N}_time key', async () => {
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(Object.keys(result).some((k) => k.endsWith('_time'))).toBe(false);
    });

    it('skips null hourly values', async () => {
      const hourlyWithNulls = {
        ...makeHourlyBlock(1),
        cape: Array(24).fill(null),
      };
      vi.stubGlobal('fetch', mockFetch({ hourly: hourlyWithNulls }));

      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));

      expect(
        Object.keys(result).some(
          (k) => k.startsWith('h') && k.endsWith('_cape'),
        ),
      ).toBe(false);
    });

    it('throws when endDate is missing', async () => {
      await expect(
        openMeteoAdaptor.fetch({ ...cfg, endDate: undefined }, RANGE),
      ).rejects.toThrow('endDate');
    });

    it('handles a response with no hourly block', async () => {
      vi.stubGlobal('fetch', mockFetch({}));
      const result = values(await openMeteoAdaptor.fetch(cfg, RANGE));
      expect(result).toEqual({});
    });

    it('throws on non-ok archive HTTP response', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 422));

      await expect(openMeteoAdaptor.fetch(cfg, RANGE)).rejects.toThrow('422');
    });
  });
});
