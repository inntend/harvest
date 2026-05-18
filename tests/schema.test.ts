import { describe, expect, test } from 'vitest';
import { SchemaError } from '../src/definition';
import { Schema } from '../src/schema';

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
    'charge.total': { unit: 'kWh', min: 0 },
    'discharge.total': { unit: 'kWh', max: 0 },
  },
  write: {
    charging: { unit: 'kW', min: 0, max: 'charging.max' },
    discharging: { unit: 'kW', min: 0, max: 'discharging.min' },
  },
};

describe('Schema', () => {
  test('resolves property overrides and converts bounds', () => {
    const s = new Schema(definition);
    s.setup([{ reference: 'capacity', unit: 'MWh', value: 0.19 }]);

    // Properties: overridden capacity, defaults for others
    expect(s.properties).toEqual({
      capacity: { unit: 'MWh', value: 0.19 },
      'charging.max': { unit: 'W', value: 150_000 },
      'discharging.min': { unit: 'kW', value: 2 },
    });

    // soc.max = 0.19 MWh → 190 kWh
    expect(() => s.read.parse({ soc: 190 })).not.toThrow();
    expect(() => s.read.parse({ soc: 191 })).toThrow();

    // soc.percent.max = 100 (literal)
    expect(() => s.read.parse({ 'soc.percent': 100 })).not.toThrow();
    expect(() => s.read.parse({ 'soc.percent': 101 })).toThrow();

    // charging.max = 150000 W → 150 kW
    expect(() => s.read.parse({ charging: 150 })).not.toThrow();
    expect(() => s.read.parse({ charging: 151 })).toThrow();

    // discharging.min = 2 kW → 2 kW (same unit, identity)
    expect(() => s.read.parse({ discharging: 2 })).not.toThrow();
    expect(() => s.read.parse({ discharging: 1 })).toThrow();

    // charge.total: min 0, no max
    expect(() => s.read.parse({ 'charge.total': 0 })).not.toThrow();
    expect(() => s.read.parse({ 'charge.total': -1 })).toThrow();

    // discharge.total: max 0, no min
    expect(() => s.read.parse({ 'discharge.total': 0 })).not.toThrow();
    expect(() => s.read.parse({ 'discharge.total': 1 })).toThrow();
  });

  test('throws on unknown property override', () => {
    const s = new Schema(definition);
    expect(() =>
      s.setup([{ reference: 'invalid', unit: 'Wh', value: 100 }]),
    ).toThrow(SchemaError);
    expect(() =>
      s.setup([{ reference: 'invalid', unit: 'Wh', value: 100 }]),
    ).toThrow("Property 'invalid' is not supported.");
  });

  test('throws when bound references non-existent property', () => {
    const s = new Schema({
      properties: {},
      read: { soc: { unit: 'kWh', min: 0, max: 'not-found' } },
      write: {},
    });
    expect(() => s.setup()).toThrow(SchemaError);
    expect(() => s.setup()).toThrow("Property 'not-found' does not exist.");
  });

  test('uses definition defaults when no overrides given', () => {
    const s = new Schema(definition);
    s.setup();
    expect(s.properties).toEqual({
      capacity: { unit: 'Wh', value: 200_000 },
      'charging.max': { unit: 'W', value: 150_000 },
      'discharging.min': { unit: 'kW', value: 2 },
    });
    // soc.max = 200000 Wh → 200 kWh
    expect(() => s.read.parse({ soc: 200 })).not.toThrow();
    expect(() => s.read.parse({ soc: 201 })).toThrow();
  });
});
