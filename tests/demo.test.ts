import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoAdaptor } from '../src/adaptors/demo';

const cfg = {
  'charging.max': 50_000,
  'discharging.max': 50_000,
  capacity: 100_000,
};
const range = {
  from: new Date('2024-01-01T00:00:00Z'),
  to: new Date('2024-01-01T01:00:00Z'),
};

afterEach(() => vi.restoreAllMocks());

describe('demoAdaptor', () => {
  it('validates its config', () => {
    expect(() => demoAdaptor.config.parse(cfg)).not.toThrow();
    expect(() => demoAdaptor.config.parse({ ...cfg, capacity: -1 })).toThrow();
  });

  it('charges (not discharges) at low state of charge', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.05); // soc = 5
    const [reading] = await demoAdaptor.fetch(cfg, range);

    expect(reading.timestamp).toBe(range.to.toISOString());
    expect(reading.values.soc).toBe(5);
    expect(reading.values.chargePower).toBeGreaterThan(0); // soc < 90
    expect(reading.values.dischargePower).toBe(0); // soc <= 20
    expect(reading.values.voltage).toBeCloseTo(48.4);
  });

  it('discharges (not charges) at high state of charge', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.95); // soc = 95
    const [reading] = await demoAdaptor.fetch(cfg, range);

    expect(reading.values.soc).toBe(95);
    expect(reading.values.chargePower).toBe(0); // soc >= 90
    expect(reading.values.dischargePower).toBeGreaterThan(0); // soc > 20
  });

  it('send logs the received values', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await demoAdaptor.send?.(cfg, { targetSoc: 80 });
    expect(log).toHaveBeenCalledWith('[demo] write received:', {
      targetSoc: 80,
    });
  });
});
