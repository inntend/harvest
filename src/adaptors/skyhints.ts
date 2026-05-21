import { z } from 'zod';
import type { Adaptor } from '../types';

const MOON_PHASES = [
  'new',
  'waxing_crescent',
  'first_quarter',
  'waxing_gibbous',
  'full',
  'waning_gibbous',
  'last_quarter',
  'waning_crescent',
] as const;

const EARTH_SEASONS = ['vernal', 'summer', 'autumn', 'winter'] as const;

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

const RETROGRADE_PHASES = [
  'pre_shadow',
  'retrograde',
  'direct',
  'post_shadow',
] as const;

const config = z.object({
  baseUrl: z.string().url().describe('Skyhints API base URL'),
  type: z
    .enum(['moon', 'earth', 'retrograde'])
    .describe(
      '"moon" = lunar phase timestamps; "earth" = solstice/equinox timestamps; "retrograde" = planetary retrograde timestamps',
    ),
});

export const skyhintsAdaptor: Adaptor<typeof config.shape> = {
  id: 'skyhints',
  name: 'Skyhints Celestial',
  schedule: '0 0 * * *', // daily at midnight
  config,

  def: {
    properties: {},
    read: {
      // All values are Unix timestamps (seconds since epoch).
      // Keys are dynamically generated per dataset and not enumerated here.
      // Patterns:
      //   moon       → moon_{N}_{phase}              e.g. moon_0_new, moon_3_full
      //   earth      → earth_{N}_{season}            e.g. earth_0_vernal, earth_7_winter
      //   retrograde → retrograde_{planet}_{N}_{phase} e.g. retrograde_mercury_0_retrograde
    },
    write: {},
  },

  async fetch(cfg) {
    switch (cfg.type) {
      case 'moon':
        return fetchMoon(cfg.baseUrl);
      case 'earth':
        return fetchEarth(cfg.baseUrl);
      case 'retrograde':
        return fetchRetrograde(cfg.baseUrl);
    }
  },
};

// ── Fetch helpers ─────────────────────────────────────────────────────────────

type PhaseRecord = Record<string, string | null>;

async function fetchMoon(baseUrl: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseUrl}/moon`);
  if (!res.ok)
    throw new Error(`skyhints HTTP ${res.status}: ${res.statusText}`);

  const json = (await res.json()) as { phases?: PhaseRecord[] };
  const cycles = json.phases ?? [];
  const result: Record<string, number> = {};

  for (let i = 0; i < cycles.length; i++) {
    for (const phase of MOON_PHASES) {
      const ts = cycles[i][phase];
      if (typeof ts === 'string') result[`moon_${i}_${phase}`] = isoToUnix(ts);
    }
  }
  return result;
}

async function fetchEarth(baseUrl: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseUrl}/earth`);
  if (!res.ok)
    throw new Error(`skyhints HTTP ${res.status}: ${res.statusText}`);

  const json = (await res.json()) as { phases?: PhaseRecord[] };
  const years = json.phases ?? [];
  const result: Record<string, number> = {};

  for (let i = 0; i < years.length; i++) {
    for (const season of EARTH_SEASONS) {
      const ts = years[i][season];
      if (typeof ts === 'string')
        result[`earth_${i}_${season}`] = isoToUnix(ts);
    }
  }
  return result;
}

async function fetchRetrograde(
  baseUrl: string,
): Promise<Record<string, number>> {
  const res = await fetch(`${baseUrl}/retrograde`);
  if (!res.ok)
    throw new Error(`skyhints HTTP ${res.status}: ${res.statusText}`);

  const json = (await res.json()) as {
    phases?: Partial<Record<string, PhaseRecord[]>>;
  };
  const planets = json.phases ?? {};
  const result: Record<string, number> = {};

  for (const planet of PLANETS) {
    const periods = planets[planet] ?? [];
    for (let i = 0; i < periods.length; i++) {
      for (const phase of RETROGRADE_PHASES) {
        const ts = periods[i][phase];
        if (typeof ts === 'string')
          result[`retrograde_${planet}_${i}_${phase}`] = isoToUnix(ts);
      }
    }
  }
  return result;
}

// ── Shared ────────────────────────────────────────────────────────────────────

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}
