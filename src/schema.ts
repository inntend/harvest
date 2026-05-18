import type { UnitKey } from '@inntend/convert';
import { Convert, type UnitsLibrary } from '@inntend/convert';

type Unit = UnitKey<typeof UnitsLibrary>;

import { z } from 'zod';
import type {
  AdaptorDef,
  Bound,
  FieldDef,
  PropertyDef,
  PropertyOverride,
} from './definition';
import { SchemaError } from './definition';

type ReadShape = Record<string, z.ZodOptional<z.ZodNumber>>;

export class Schema {
  public properties: Record<string, PropertyDef> = {};
  public read: z.ZodObject<ReadShape> = z.object({});
  public write: z.ZodObject<ReadShape> = z.object({});

  readonly #def: AdaptorDef;

  constructor(def: AdaptorDef) {
    this.#def = def;
  }

  setup(overrides?: PropertyOverride[]): void {
    this._configureProperties(overrides);
    this.read = this._buildSchema(this.#def.read);
    this.write = this._buildSchema(this.#def.write);
  }

  private _configureProperties(overrides?: PropertyOverride[]): void {
    this.properties = {};
    for (const ref in this.#def.properties) {
      this.properties[ref] = { ...this.#def.properties[ref] };
    }
    for (const override of overrides ?? []) {
      if (!this.properties[override.reference]) {
        throw new SchemaError(
          `Property '${override.reference}' is not supported.`,
        );
      }
      this.properties[override.reference] = {
        unit: override.unit,
        value: override.value,
      };
    }
  }

  private _buildSchema(
    fields: Record<string, FieldDef>,
  ): z.ZodObject<ReadShape> {
    const shape: ReadShape = {};
    for (const key in fields) {
      shape[key] = this._fieldSchema(fields[key]).optional();
    }
    return z.object(shape);
  }

  private _fieldSchema(field: FieldDef): z.ZodNumber {
    let s = z.number();
    if (field.min !== undefined)
      s = s.min(this._resolveBound(field.min, field.unit));
    if (field.max !== undefined)
      s = s.max(this._resolveBound(field.max, field.unit));
    return s;
  }

  private _resolveBound(bound: Bound, unit: string): number {
    if (typeof bound === 'number') return bound;
    return this._propertyValue(bound, unit);
  }

  private _propertyValue(reference: string, targetUnit: string): number {
    const prop = this.properties[reference];
    if (!prop) throw new SchemaError(`Property '${reference}' does not exist.`);
    return new Convert()
      .from(prop.value, prop.unit as Unit)
      .to(targetUnit as Unit);
  }
}
