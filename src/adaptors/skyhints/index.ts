import { z } from 'zod';
import type { Adaptor, Reading } from '../../types';
import earthData from './data/earth.json';
import moonData from './data/moon.json';
import retrogradeData from './data/retrograde.json';

// Skyhints serves astronomical events from a bundled almanac (no service call).
// Each selectable field is an event type; a fetch emits one indicator Reading
// (value 1) at every occurrence inside the requested range, so events render as
// markers on their day — same shape as any other recorded point.

type EventRecord = Record<string, string>; // event-key -> ISO timestamp

// field id -> { label, source data-key }. The principal moon phases + the four
// solstices/equinoxes; intermediate moon phases are intentionally omitted.
const MOON_FIELDS = [
  { field: 'new_moon', label: 'New Moon', key: 'new' },
  { field: 'first_quarter', label: 'First Quarter', key: 'first_quarter' },
  { field: 'full_moon', label: 'Full Moon', key: 'full' },
  { field: 'last_quarter', label: 'Last Quarter', key: 'last_quarter' },
] as const;

const SEASON_FIELDS = [
  { field: 'spring_equinox', label: 'Spring Equinox', key: 'vernal' },
  { field: 'summer_solstice', label: 'Summer Solstice', key: 'summer' },
  { field: 'autumn_equinox', label: 'Autumn Equinox', key: 'autumn' },
  { field: 'winter_solstice', label: 'Winter Solstice', key: 'winter' },
] as const;

const PLANETS = [
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
] as const;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// All event occurrences across the bundled data, computed once. Each retrograde
// uses the period's `retrograde` start as its event timestamp. The ISO string is
// parsed here (ms epoch + normalized timestamp) so fetch is a pure range filter.
type Occurrence = { field: string; ms: number; timestamp: string };
const OCCURRENCES: Occurrence[] = (() => {
  const out: Occurrence[] = [];
  const add = (field: string, iso: string) => {
    const date = new Date(iso);
    out.push({ field, ms: date.getTime(), timestamp: date.toISOString() });
  };
  for (const cycle of moonData as EventRecord[])
    for (const m of MOON_FIELDS) if (cycle[m.key]) add(m.field, cycle[m.key]);
  for (const year of earthData as EventRecord[])
    for (const s of SEASON_FIELDS) if (year[s.key]) add(s.field, year[s.key]);
  const retro = retrogradeData as Record<string, EventRecord[]>;
  for (const planet of PLANETS)
    for (const period of retro[planet] ?? [])
      if (period.retrograde) add(`${planet}_retrograde`, period.retrograde);
  return out;
})();

// Static read fields (one per event type), derived from the same tables so they
// can never drift from what `fetch` emits.
type ReadEntry = [string, { unit: string; label: string }];
const read = Object.fromEntries<{ unit: string; label: string }>([
  ...MOON_FIELDS.map((m): ReadEntry => [m.field, { unit: '', label: m.label }]),
  ...SEASON_FIELDS.map(
    (s): ReadEntry => [s.field, { unit: '', label: s.label }],
  ),
  ...PLANETS.map(
    (p): ReadEntry => [
      `${p}_retrograde`,
      { unit: '', label: `${cap(p)} Retrograde` },
    ],
  ),
]);

const config = z.object({});

export const skyhintsAdaptor: Adaptor<typeof config.shape> = {
  id: 'skyhints',
  name: 'Skyhints Celestial',
  config,

  def: {
    properties: {},
    read,
    write: {},
    description:
      'Moon phases, solstices & equinoxes, and planetary retrogrades from a built-in almanac.',
  },

  async fetch(_cfg, range) {
    const from = range.from.getTime();
    const to = range.to.getTime();
    const readings: Reading[] = [];
    for (const occ of OCCURRENCES)
      if (occ.ms >= from && occ.ms < to)
        readings.push({
          timestamp: occ.timestamp,
          values: { [occ.field]: 1 },
        });
    return readings;
  },
};
