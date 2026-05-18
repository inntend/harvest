import { z } from 'zod';
import type { Adaptor } from '../types.js';

const config = z.object({
  capacityKwh: z.number().positive().max(1000).describe('Battery capacity kWh'),
  maxChargePower: z
    .number()
    .positive()
    .max(500)
    .describe('Max charge power kW'),
  maxDischargePower: z
    .number()
    .positive()
    .max(500)
    .describe('Max discharge power kW'),
});

const read = z.object({
  soc: z.number().min(0).max(100).describe('State of charge %'),
  chargePower: z.number().min(0).describe('Current charge power kW'),
  dischargePower: z.number().min(0).describe('Current discharge power kW'),
  voltage: z.number().min(40).max(60).describe('Terminal voltage V'),
});

const write = z.object({
  targetSoc: z.number().min(0).max(100),
  chargingEnabled: z.boolean(),
});

export const demoAdaptor: Adaptor<
  typeof config.shape,
  typeof read.shape,
  typeof write.shape
> = {
  id: 'demo',
  name: 'Demo Battery',
  schedule: '*/10 * * * * *',
  config,
  read,
  write,

  async fetch(cfg) {
    const soc = Math.round(Math.random() * 100);
    return {
      soc,
      chargePower:
        soc < 90 ? +(Math.random() * cfg.maxChargePower).toFixed(2) : 0,
      dischargePower:
        soc > 20 ? +(Math.random() * cfg.maxDischargePower).toFixed(2) : 0,
      voltage: +(48 + Math.random() * 8).toFixed(2),
    };
  },

  async send(_cfg, values) {
    console.log('[demo] write received:', values);
  },
};
