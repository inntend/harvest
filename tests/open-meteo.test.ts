import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMeteoAdaptor } from '../src/adaptors/open-meteo';

const cfg = { latitude: 52.52, longitude: 13.41, timezone: 'Europe/Berlin' };
const RANGE = {
  from: new Date('2024-01-01T00:00:00Z'),
  to: new Date('2024-01-03T23:59:59Z'),
};

const DAILY_RESPONSE = {
  daily: {
    time: ['2024-01-01', '2024-01-02', '2024-01-03'],
    temperature_2m_max: [5.2, 6.1, 4.8],
    temperature_2m_min: [-1.0, 0.4, -2.3],
    precipitation_sum: [0, 2.4, 0.1],
    wind_speed_10m_max: [12.0, 18.5, 9.2],
  },
};

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  });
}

function calledUrl(): string {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
}

function calledUrls(): string[] {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => c[0] as string,
  );
}

const isForecast = (url: string) => url.includes('/v1/forecast');
const isArchive = (url: string) => url.includes('/v1/archive');

describe('openMeteoAdaptor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('has the expected id and name', () => {
    expect(openMeteoAdaptor.id).toBe('open-meteo');
    expect(openMeteoAdaptor.name).toBe('Open-Meteo Weather');
  });

  describe('fetch (daily range)', () => {
    beforeEach(() => vi.stubGlobal('fetch', mockFetch(DAILY_RESPONSE)));

    it('requests the daily forecast for the range', async () => {
      await openMeteoAdaptor.fetch(cfg, RANGE);
      const url = calledUrl();
      expect(url).toContain('start_date=2024-01-01');
      expect(url).toContain('end_date=2024-01-03');
      expect(url).toContain('daily=');
      expect(url).toContain('temperature_2m_max');
    });

    it('returns one reading per day with that day values', async () => {
      const readings = await openMeteoAdaptor.fetch(cfg, RANGE);
      expect(readings).toHaveLength(3);
      expect(readings[0].values).toMatchObject({
        temperature_2m_max: 5.2,
        temperature_2m_min: -1.0,
        precipitation_sum: 0,
        wind_speed_10m_max: 12.0,
      });
      // Timestamps fall on the right calendar day (stamped at noon UTC).
      expect(new Date(readings[0].timestamp).getUTCDate()).toBe(1);
      expect(new Date(readings[2].timestamp).getUTCDate()).toBe(3);
    });

    it('requests and returns the daily pressure aggregates', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          daily: {
            time: ['2024-01-01'],
            pressure_msl_min: [1000],
            pressure_msl_max: [1010],
            pressure_msl_mean: [1005],
            surface_pressure_min: [990],
            surface_pressure_max: [998],
            surface_pressure_mean: [994],
          },
        }),
      );
      const readings = await openMeteoAdaptor.fetch(cfg, RANGE);
      expect(calledUrl()).toContain('pressure_msl_mean');
      expect(calledUrl()).toContain('surface_pressure_mean');
      expect(readings[0].values).toMatchObject({
        pressure_msl_min: 1000,
        pressure_msl_max: 1010,
        pressure_msl_mean: 1005,
        surface_pressure_min: 990,
        surface_pressure_max: 998,
        surface_pressure_mean: 994,
      });
    });

    it('skips non-numeric / missing values', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          daily: {
            time: ['2024-01-01'],
            temperature_2m_max: [null],
            precipitation_sum: [1.5],
          },
        }),
      );
      const readings = await openMeteoAdaptor.fetch(cfg, RANGE);
      expect(readings).toHaveLength(1);
      expect(readings[0].values).not.toHaveProperty('temperature_2m_max');
      expect(readings[0].values.precipitation_sum).toBe(1.5);
    });

    it('treats the range end as exclusive, not fetching the to-day', async () => {
      // Half-open [Jan 1 00:00, Jan 2 00:00) is just Jan 1 — end_date must be
      // Jan 1, not Jan 2 (which would re-fetch the next gap's first day).
      await openMeteoAdaptor.fetch(cfg, {
        from: new Date('2024-01-01T00:00:00Z'),
        to: new Date('2024-01-02T00:00:00Z'),
      });
      const url = calledUrl();
      expect(url).toContain('start_date=2024-01-01');
      expect(url).toContain('end_date=2024-01-01');
    });

    it('returns an empty array when daily data is absent', async () => {
      vi.stubGlobal('fetch', mockFetch({}));
      expect(await openMeteoAdaptor.fetch(cfg, RANGE)).toEqual([]);
    });

    it('throws on a non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 429));
      await expect(openMeteoAdaptor.fetch(cfg, RANGE)).rejects.toThrow('429');
    });
  });

  // The archive (ERA5) endpoint lags ~5 days; recent dates come from the forecast
  // endpoint instead. The split is relative to "today", so time is pinned here.
  describe('archive / forecast split', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T00:00:00Z')); // cutoff = 2024-06-10
      vi.stubGlobal('fetch', mockFetch(DAILY_RESPONSE));
    });
    afterEach(() => vi.useRealTimers());

    it('uses only the forecast endpoint for a range within the archive lag', async () => {
      await openMeteoAdaptor.fetch(cfg, {
        from: new Date('2024-06-12T00:00:00Z'),
        to: new Date('2024-06-14T23:59:59Z'),
      });
      const urls = calledUrls();
      expect(urls).toHaveLength(1);
      expect(isForecast(urls[0])).toBe(true);
      expect(urls[0]).toContain('start_date=2024-06-12');
      expect(urls[0]).toContain('end_date=2024-06-14');
    });

    it('uses only the archive endpoint for a range older than the lag', async () => {
      await openMeteoAdaptor.fetch(cfg, {
        from: new Date('2024-06-01T00:00:00Z'),
        to: new Date('2024-06-03T23:59:59Z'),
      });
      const urls = calledUrls();
      expect(urls).toHaveLength(1);
      expect(isArchive(urls[0])).toBe(true);
      expect(urls[0]).toContain('start_date=2024-06-01');
      expect(urls[0]).toContain('end_date=2024-06-03');
    });

    it('splits a range spanning the cutoff across both endpoints', async () => {
      await openMeteoAdaptor.fetch(cfg, {
        from: new Date('2024-06-08T00:00:00Z'),
        to: new Date('2024-06-14T23:59:59Z'),
      });
      const urls = calledUrls();
      expect(urls).toHaveLength(2);

      const archive = urls.find(isArchive);
      const forecast = urls.find(isForecast);
      // Archive covers up to and including the cutoff day...
      expect(archive).toContain('start_date=2024-06-08');
      expect(archive).toContain('end_date=2024-06-10');
      // ...and the forecast picks up the day after, with no overlap.
      expect(forecast).toContain('start_date=2024-06-11');
      expect(forecast).toContain('end_date=2024-06-14');
    });

    it('merges readings from both endpoints into one list', async () => {
      const readings = await openMeteoAdaptor.fetch(cfg, {
        from: new Date('2024-06-08T00:00:00Z'),
        to: new Date('2024-06-14T23:59:59Z'),
      });
      // Both endpoints return the 3-day mock, so the flattened result is 6.
      expect(readings).toHaveLength(6);
    });
  });

  describe('stableBefore', () => {
    it('returns midnight UTC of the day after the archive cutoff', () => {
      // cutoff = 2024-06-15 − 5d = 2024-06-10; boundary = day after = 06-11.
      const now = new Date('2024-06-15T08:00:00Z');
      expect(openMeteoAdaptor.stableBefore?.(now)).toEqual(
        new Date('2024-06-11T00:00:00Z'),
      );
    });
  });
});
