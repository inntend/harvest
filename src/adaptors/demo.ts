import { z } from 'zod';
import type { Adaptor } from '../types';

const config = z.object({
  'charging.max': z
    .number()
    .positive()
    .max(500_000)
    .describe('Max charge power W'),
  'discharging.max': z
    .number()
    .positive()
    .max(500_000)
    .describe('Max discharge power W'),
  capacity: z
    .number()
    .positive()
    .max(1_000_000)
    .describe('Battery capacity Wh'),
});

export const demoAdaptor: Adaptor<typeof config.shape> = {
  id: 'demo',
  name: 'Demo Battery',
  config,

  def: {
    properties: {
      'charging.max': { unit: 'W', value: 50_000 },
      'discharging.max': { unit: 'W', value: 50_000 },
      capacity: { unit: 'Wh', value: 100_000 },
    },
    read: {
      soc: { unit: '%', min: 0, max: 100 },
      chargePower: { unit: 'kW', min: 0, max: 'charging.max' },
      dischargePower: { unit: 'kW', min: 0, max: 'discharging.max' },
      voltage: { unit: 'V', min: 40, max: 60 },
    },
    write: {
      targetSoc: { unit: '%', min: 0, max: 100 },
      chargingMode: { unit: '', min: 0, max: 1 },
    },
  },

  async fetch(cfg, range) {
    const maxCharge = cfg['charging.max'] / 1000; // W → kW
    const maxDischarge = cfg['discharging.max'] / 1000;
    const soc = Math.round(Math.random() * 100);
    return [
      {
        timestamp: range.to.toISOString(),
        values: {
          soc,
          chargePower: soc < 90 ? +(Math.random() * maxCharge).toFixed(2) : 0,
          dischargePower:
            soc > 20 ? +(Math.random() * maxDischarge).toFixed(2) : 0,
          voltage: +(48 + Math.random() * 8).toFixed(2),
        },
      },
    ];
  },

  async send(_cfg, values) {
    console.log('[demo] write received:', values);
  },
};
