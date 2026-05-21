import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { skyhintsAdaptor } from '../src/adaptors/skyhints';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const BASE = 'https://api.skyhints.example';

const MOON_RESPONSE = {
  phases: [
    {
      new: '2022-01-02T18:33:30.390116+00:00',
      waxing_crescent: '2022-01-06T01:27:02.760541+00:00',
      first_quarter: null,
      waxing_gibbous: null,
      full: '2022-01-17T23:48:26.384505+00:00',
      waning_gibbous: null,
      last_quarter: null,
      waning_crescent: null,
    },
    {
      new: '2022-02-01T05:46:01.346265+00:00',
      waxing_crescent: null,
      first_quarter: null,
      waxing_gibbous: null,
      full: '2022-02-16T16:56:31.415723+00:00',
      waning_gibbous: null,
      last_quarter: null,
      waning_crescent: null,
    },
  ],
};

const EARTH_RESPONSE = {
  phases: [
    {
      vernal: '2022-03-20T15:33:24.904529+00:00',
      summer: '2022-06-21T09:13:51.059598+00:00',
      autumn: null,
      winter: null,
    },
    {
      vernal: '2023-03-20T21:24:26.498316+00:00',
      summer: null,
      autumn: null,
      winter: null,
    },
  ],
};

const RETROGRADE_RESPONSE = {
  phases: {
    mercury: [
      {
        pre_shadow: '2021-12-29T09:27:05+00:00',
        retrograde: '2022-01-14T11:41:17+00:00',
        direct: '2022-02-04T04:13:32+00:00',
        post_shadow: null,
      },
      {
        pre_shadow: '2022-04-26T06:45:03+00:00',
        retrograde: '2022-05-10T11:47:29+00:00',
        direct: '2022-06-03T08:02:09+00:00',
        post_shadow: '2022-06-18T22:49:08+00:00',
      },
    ],
    venus: [
      {
        pre_shadow: '2021-11-17T20:37:34+00:00',
        retrograde: '2021-12-19T02:35:29+00:00',
        direct: '2022-01-29T09:45:58+00:00',
        post_shadow: null,
      },
    ],
    mars: [],
    jupiter: [],
    saturn: [],
    uranus: [],
    neptune: [],
    pluto: [],
  },
};

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: async () => body,
  });
}

function calledUrl(): string {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('skyhintsAdaptor', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('metadata', () => {
    it('has the expected id, name, and daily schedule', () => {
      expect(skyhintsAdaptor.id).toBe('skyhints');
      expect(skyhintsAdaptor.name).toBe('Skyhints Celestial');
      expect(skyhintsAdaptor.schedule).toMatch(/^0 0 \* \* \*$/);
    });

    it('def has no write fields and no properties', () => {
      expect(skyhintsAdaptor.def.write).toEqual({});
      expect(skyhintsAdaptor.def.properties).toEqual({});
    });
  });

  describe('config schema', () => {
    it('rejects an invalid URL', () => {
      expect(() =>
        skyhintsAdaptor.config.parse({ baseUrl: 'not-a-url', type: 'moon' }),
      ).toThrow();
    });

    it('rejects an unknown type', () => {
      expect(() =>
        skyhintsAdaptor.config.parse({ baseUrl: BASE, type: 'sun' }),
      ).toThrow();
    });

    it('accepts all valid types', () => {
      for (const type of ['moon', 'earth', 'retrograde'] as const) {
        expect(() =>
          skyhintsAdaptor.config.parse({ baseUrl: BASE, type }),
        ).not.toThrow();
      }
    });
  });

  // ── moon ──────────────────────────────────────────────────────────────────

  describe('fetch() — moon', () => {
    const cfg = { baseUrl: BASE, type: 'moon' as const };

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch(MOON_RESPONSE));
    });

    it('calls /moon endpoint', async () => {
      await skyhintsAdaptor.fetch(cfg);
      expect(calledUrl()).toBe(`${BASE}/moon`);
    });

    it('returns moon_{N}_{phase} keys as Unix timestamps', async () => {
      const result = await skyhintsAdaptor.fetch(cfg);

      expect(result.moon_0_new).toBe(
        Math.floor(
          new Date('2022-01-02T18:33:30.390116+00:00').getTime() / 1000,
        ),
      );
      expect(result.moon_0_full).toBe(
        Math.floor(
          new Date('2022-01-17T23:48:26.384505+00:00').getTime() / 1000,
        ),
      );
      expect(result.moon_1_new).toBe(
        Math.floor(
          new Date('2022-02-01T05:46:01.346265+00:00').getTime() / 1000,
        ),
      );
    });

    it('skips null phase timestamps', async () => {
      const result = await skyhintsAdaptor.fetch(cfg);

      expect(result).not.toHaveProperty('moon_0_first_quarter');
      expect(result).not.toHaveProperty('moon_0_waxing_gibbous');
      expect(result).not.toHaveProperty('moon_1_waxing_crescent');
    });

    it('returns an empty record when phases array is empty', async () => {
      vi.stubGlobal('fetch', mockFetch({ phases: [] }));
      const result = await skyhintsAdaptor.fetch(cfg);
      expect(result).toEqual({});
    });

    it('returns an empty record when phases key is absent', async () => {
      vi.stubGlobal('fetch', mockFetch({}));
      const result = await skyhintsAdaptor.fetch(cfg);
      expect(result).toEqual({});
    });

    it('throws on non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 404));
      await expect(skyhintsAdaptor.fetch(cfg)).rejects.toThrow('404');
    });
  });

  // ── earth ─────────────────────────────────────────────────────────────────

  describe('fetch() — earth', () => {
    const cfg = { baseUrl: BASE, type: 'earth' as const };

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch(EARTH_RESPONSE));
    });

    it('calls /earth endpoint', async () => {
      await skyhintsAdaptor.fetch(cfg);
      expect(calledUrl()).toBe(`${BASE}/earth`);
    });

    it('returns earth_{N}_{season} keys as Unix timestamps', async () => {
      const result = await skyhintsAdaptor.fetch(cfg);

      expect(result.earth_0_vernal).toBe(
        Math.floor(
          new Date('2022-03-20T15:33:24.904529+00:00').getTime() / 1000,
        ),
      );
      expect(result.earth_0_summer).toBe(
        Math.floor(
          new Date('2022-06-21T09:13:51.059598+00:00').getTime() / 1000,
        ),
      );
      expect(result.earth_1_vernal).toBe(
        Math.floor(
          new Date('2023-03-20T21:24:26.498316+00:00').getTime() / 1000,
        ),
      );
    });

    it('skips null season timestamps', async () => {
      const result = await skyhintsAdaptor.fetch(cfg);

      expect(result).not.toHaveProperty('earth_0_autumn');
      expect(result).not.toHaveProperty('earth_0_winter');
      expect(result).not.toHaveProperty('earth_1_summer');
    });

    it('returns an empty record when phases key is absent', async () => {
      vi.stubGlobal('fetch', mockFetch({}));
      const result = await skyhintsAdaptor.fetch(cfg);
      expect(result).toEqual({});
    });

    it('throws on non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 500));
      await expect(skyhintsAdaptor.fetch(cfg)).rejects.toThrow('500');
    });
  });

  // ── retrograde ────────────────────────────────────────────────────────────

  describe('fetch() — retrograde', () => {
    const cfg = { baseUrl: BASE, type: 'retrograde' as const };

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch(RETROGRADE_RESPONSE));
    });

    it('calls /retrograde endpoint', async () => {
      await skyhintsAdaptor.fetch(cfg);
      expect(calledUrl()).toBe(`${BASE}/retrograde`);
    });

    it('returns retrograde_{planet}_{N}_{phase} keys as Unix timestamps', async () => {
      const result = await skyhintsAdaptor.fetch(cfg);

      expect(result.retrograde_mercury_0_pre_shadow).toBe(
        Math.floor(new Date('2021-12-29T09:27:05+00:00').getTime() / 1000),
      );
      expect(result.retrograde_mercury_0_retrograde).toBe(
        Math.floor(new Date('2022-01-14T11:41:17+00:00').getTime() / 1000),
      );
      expect(result.retrograde_mercury_0_direct).toBe(
        Math.floor(new Date('2022-02-04T04:13:32+00:00').getTime() / 1000),
      );
      expect(result.retrograde_mercury_1_pre_shadow).toBe(
        Math.floor(new Date('2022-04-26T06:45:03+00:00').getTime() / 1000),
      );
      expect(result.retrograde_venus_0_direct).toBe(
        Math.floor(new Date('2022-01-29T09:45:58+00:00').getTime() / 1000),
      );
    });

    it('skips null retrograde phase timestamps', async () => {
      const result = await skyhintsAdaptor.fetch(cfg);

      expect(result).not.toHaveProperty('retrograde_mercury_0_post_shadow');
      expect(result).not.toHaveProperty('retrograde_venus_0_post_shadow');
    });

    it('produces no keys for planets with empty period arrays', async () => {
      const result = await skyhintsAdaptor.fetch(cfg);

      for (const planet of [
        'mars',
        'jupiter',
        'saturn',
        'uranus',
        'neptune',
        'pluto',
      ]) {
        const hasAny = Object.keys(result).some((k) =>
          k.startsWith(`retrograde_${planet}_`),
        );
        expect(hasAny).toBe(false);
      }
    });

    it('handles missing phases key gracefully', async () => {
      vi.stubGlobal('fetch', mockFetch({}));
      const result = await skyhintsAdaptor.fetch(cfg);
      expect(result).toEqual({});
    });

    it('handles a planet key absent from the response', async () => {
      const partial = {
        phases: { mercury: RETROGRADE_RESPONSE.phases.mercury },
      };
      vi.stubGlobal('fetch', mockFetch(partial));
      const result = await skyhintsAdaptor.fetch(cfg);

      expect(result.retrograde_mercury_0_retrograde).toBeDefined();
      expect(
        Object.keys(result).some((k) => k.startsWith('retrograde_venus_')),
      ).toBe(false);
    });

    it('throws on non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 503));
      await expect(skyhintsAdaptor.fetch(cfg)).rejects.toThrow('503');
    });
  });
});
