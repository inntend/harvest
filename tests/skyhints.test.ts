import { describe, expect, it } from 'vitest';
import { buildOccurrences, skyhintsAdaptor } from '../src/adaptors/skyhints';
import type { Reading } from '../src/types';

// January 2022 — a window with known almanac events from the bundled data:
//   new moon         2022-01-02T18:33:30Z
//   first quarter    2022-01-09T18:11:16Z
//   mercury retro    2022-01-14T11:41:17Z
//   full moon        2022-01-17T23:48:26Z
//   last quarter     2022-01-25T13:40:55Z
const JAN_2022 = {
  from: new Date('2022-01-01T00:00:00Z'),
  to: new Date('2022-02-01T00:00:00Z'),
};

const find = (readings: Reading[], field: string) =>
  readings.find((r) => field in r.values);

describe('skyhintsAdaptor', () => {
  describe('metadata', () => {
    it('has the expected id and name', () => {
      expect(skyhintsAdaptor.id).toBe('skyhints');
      expect(skyhintsAdaptor.name).toBe('Skyhints Celestial');
    });

    it('exposes static, labelled event read fields', () => {
      expect(skyhintsAdaptor.def.read.full_moon).toEqual({
        unit: '',
        label: 'Full Moon',
      });
      expect(skyhintsAdaptor.def.read.spring_equinox).toEqual({
        unit: '',
        label: 'Spring Equinox',
      });
      expect(skyhintsAdaptor.def.read.mercury_retrograde).toEqual({
        unit: '',
        label: 'Mercury Retrograde',
      });
    });

    it('has a description and no write fields', () => {
      expect(skyhintsAdaptor.def.write).toEqual({});
      expect(skyhintsAdaptor.def.description).toBeTruthy();
    });
  });

  describe('config schema', () => {
    it('accepts an empty config (zero-config adaptor)', () => {
      expect(() => skyhintsAdaptor.config.parse({})).not.toThrow();
    });
  });

  describe('fetch()', () => {
    it('emits an indicator (value 1) at each event inside the range', async () => {
      const readings = await skyhintsAdaptor.fetch({}, JAN_2022);

      const newMoon = find(readings, 'new_moon');
      expect(newMoon?.values.new_moon).toBe(1);
      expect(newMoon?.timestamp).toBe(
        new Date('2022-01-02T18:33:30.390116+00:00').toISOString(),
      );

      const fullMoon = find(readings, 'full_moon');
      expect(fullMoon?.values.full_moon).toBe(1);
      expect(fullMoon?.timestamp).toBe(
        new Date('2022-01-17T23:48:26.384505+00:00').toISOString(),
      );

      const retro = find(readings, 'mercury_retrograde');
      expect(retro?.values.mercury_retrograde).toBe(1);
      expect(retro?.timestamp).toBe(
        new Date('2022-01-14T11:41:17+00:00').toISOString(),
      );
    });

    it('omits intermediate moon phases (not enumerated as fields)', async () => {
      const readings = await skyhintsAdaptor.fetch({}, JAN_2022);
      expect(find(readings, 'waxing_crescent')).toBeUndefined();
      expect(find(readings, 'waning_gibbous')).toBeUndefined();
    });

    it('returns one event per reading, all within [from, to)', async () => {
      const readings = await skyhintsAdaptor.fetch({}, JAN_2022);
      const from = JAN_2022.from.getTime();
      const to = JAN_2022.to.getTime();
      for (const r of readings) {
        expect(Object.keys(r.values)).toHaveLength(1);
        expect(Object.values(r.values)).toEqual([1]);
        const t = new Date(r.timestamp).getTime();
        expect(t).toBeGreaterThanOrEqual(from);
        expect(t).toBeLessThan(to);
      }
    });

    it('excludes events outside the range', async () => {
      // A quiet 24h window with no principal event.
      const quiet = {
        from: new Date('2022-01-03T00:00:00Z'),
        to: new Date('2022-01-04T00:00:00Z'),
      };
      expect(await skyhintsAdaptor.fetch({}, quiet)).toEqual([]);
    });

    it('includes seasonal events (equinox/solstice) in their range', async () => {
      const spring = {
        from: new Date('2022-03-01T00:00:00Z'),
        to: new Date('2022-04-01T00:00:00Z'),
      };
      const readings = await skyhintsAdaptor.fetch({}, spring);
      const equinox = find(readings, 'spring_equinox');
      expect(equinox?.values.spring_equinox).toBe(1);
      expect(equinox?.timestamp).toBe(
        new Date('2022-03-20T15:33:24.904529+00:00').toISOString(),
      );
    });
  });

  describe('buildOccurrences', () => {
    it('maps moon, season, and retrograde keys to field occurrences', () => {
      const occ = buildOccurrences(
        [{ new: '2022-01-02T18:33:30Z', full: '2022-01-17T23:48:26Z' }],
        [{ vernal: '2022-03-20T15:33:24Z' }],
        { mercury: [{ retrograde: '2022-01-14T11:41:17Z' }] },
      );
      expect(occ.map((o) => o.field).sort()).toEqual([
        'full_moon',
        'mercury_retrograde',
        'new_moon',
        'spring_equinox',
      ]);
      const newMoon = occ.find((o) => o.field === 'new_moon');
      expect(newMoon?.timestamp).toBe(
        new Date('2022-01-02T18:33:30Z').toISOString(),
      );
      expect(newMoon?.ms).toBe(new Date('2022-01-02T18:33:30Z').getTime());
    });

    it('skips absent keys, planets, and periods without a retrograde date', () => {
      const occ = buildOccurrences(
        // Cycle missing the `full` key → only new_moon is emitted.
        [{ new: '2022-01-02T18:33:30Z' }],
        // Year missing every season key → no seasonal occurrences.
        [{}],
        {
          // mars absent from the map → exercises the `?? []` fallback.
          // venus present but its only period lacks a `retrograde` date.
          venus: [{ shadow: '2022-01-01T00:00:00Z' }],
        },
      );
      expect(occ.map((o) => o.field)).toEqual(['new_moon']);
    });

    it('returns nothing for entirely empty inputs', () => {
      expect(buildOccurrences([], [], {})).toEqual([]);
    });
  });
});
