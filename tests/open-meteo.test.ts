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

    it('returns an empty array when daily data is absent', async () => {
      vi.stubGlobal('fetch', mockFetch({}));
      expect(await openMeteoAdaptor.fetch(cfg, RANGE)).toEqual([]);
    });

    it('throws on a non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 429));
      await expect(openMeteoAdaptor.fetch(cfg, RANGE)).rejects.toThrow('429');
    });
  });
});
