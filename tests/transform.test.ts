import { Convert } from '@inntend/convert';
import { describe, expect, test, vi } from 'vitest';
import { Transform } from '../src/transform';

const definition = {
  properties: {
    capacity: { unit: 'Wh', value: 200_000 },
    'charging.max': { unit: 'W', value: 150_000 },
    'discharging.min': { unit: 'kW', value: 2 },
  },
  read: {
    soc: { unit: 'kWh', min: 0, max: 'capacity' },
    'soc.percent': { unit: '%', min: 0, max: 100 },
    charging: { unit: 'kW', min: 0, max: 'charging.max' },
    discharging: { unit: 'kW', min: 'discharging.min', max: 50 },
  },
  write: {
    charging: { unit: 'kW', min: 0, max: 'charging.max' },
    discharging: { unit: 'kW', min: 0, max: 'discharging.min' },
  },
};

describe('Transform', () => {
  test('validates and unit-converts measurements for multiple components', async () => {
    const t = new Transform(definition);
    t.setup([
      {
        identifier: 'A',
        status: 'ready',
        properties: [{ reference: 'capacity', unit: 'MWh', value: 0.19 }],
        measurements: [
          { reference: 'soc', unit: 'kWh', identifier: '23' },
          { reference: 'soc.percent', unit: '%', identifier: '24' },
          { reference: 'charging', unit: 'kW', identifier: '25' },
          { reference: 'discharging', unit: 'kW', identifier: '26' },
        ],
      },
      {
        identifier: 'B',
        status: 'ready',
        properties: [{ reference: 'capacity', unit: 'Wh', value: 420 }],
        measurements: [
          { reference: 'soc', unit: 'Wh', identifier: '33' },
          { reference: 'soc.percent', unit: '%', identifier: '34' },
          { reference: 'charging', unit: 'W', identifier: '35' },
        ],
      },
    ]);

    const result = await t.measurements({
      'some-ts': {
        soc: new Convert().from(0.036, 'kWh'),
        'soc.percent': new Convert().from(67, '%'),
        charging: 0.12,
        discharging: new Convert().from(3, 'kW'),
      },
    });

    expect(result).toEqual([
      { identifier: '23', timestamp: 'some-ts', value: 0.036 },
      { identifier: '24', timestamp: 'some-ts', value: 67 },
      { identifier: '25', timestamp: 'some-ts', value: 0.12 },
      { identifier: '26', timestamp: 'some-ts', value: 3 },
      { identifier: '33', timestamp: 'some-ts', value: 36 },
      { identifier: '34', timestamp: 'some-ts', value: 67 },
      { identifier: '35', timestamp: 'some-ts', value: 120 },
    ]);
  });

  test('skips disabled and measurement-less components', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new Transform(definition);
    t.setup([
      {
        identifier: 'A',
        status: 'ready',
        properties: [{ reference: 'capacity', unit: 'MWh', value: 0.19 }],
        measurements: [
          { reference: 'soc', unit: 'kWh', identifier: '23' },
          { reference: 'soc.percent', unit: '%', identifier: '24' },
          { reference: 'charging', unit: 'kW', identifier: '25' },
          { reference: 'discharging', unit: 'kW', identifier: '26' },
        ],
      },
      { identifier: 'B-disabled', status: 'disabled' },
      { identifier: 'C-no-measurements', status: 'ready' },
      {
        identifier: 'D',
        status: 'ready',
        measurements: [
          { reference: 'soc', unit: 'kWh', identifier: '23' },
          { reference: 'soc.percent', unit: '%', identifier: '24' },
        ],
      },
    ]);

    const result = await t.measurements({
      'some-ts': {
        soc: new Convert().from(0.036, 'kWh'),
        'soc.percent': new Convert().from(67, '%'),
        charging: new Convert().from(0.12, 'kW'),
        discharging: new Convert().from(3, 'kW'),
      },
    });

    expect(result).toEqual([
      { identifier: '23', timestamp: 'some-ts', value: 0.036 },
      { identifier: '24', timestamp: 'some-ts', value: 67 },
      { identifier: '25', timestamp: 'some-ts', value: 0.12 },
      { identifier: '26', timestamp: 'some-ts', value: 3 },
      { identifier: '23', timestamp: 'some-ts', value: 0.036 },
      { identifier: '24', timestamp: 'some-ts', value: 67 },
    ]);
    warn.mockRestore();
  });
});
