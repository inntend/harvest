import type { UnitKey } from '@inntend/convert';
import { Convert, type UnitsLibrary } from '@inntend/convert';
import type { z } from 'zod';
import type {
  AdaptorDef,
  Component,
  MeasurementRef,
  SeriesEntry,
} from './definition';
import { Schema } from './schema';

type Unit = UnitKey<typeof UnitsLibrary>;
type ReadSchema = z.ZodObject<Record<string, z.ZodOptional<z.ZodNumber>>>;

export class Transform {
  public readonly def: AdaptorDef;

  readonly #measurements: Record<string, MeasurementRef[]> = {};
  readonly #schemas: Record<string, ReadSchema> = {};

  constructor(def: AdaptorDef) {
    this.def = def;
  }

  setup(components: Component[]): void {
    for (const key in this.#measurements) delete this.#measurements[key];
    for (const key in this.#schemas) delete this.#schemas[key];

    for (const component of components) {
      if (component.status === 'disabled') {
        console.warn(
          `[transform] Component '${component.identifier}' is disabled.`,
        );
        continue;
      }
      if (!component.measurements?.length) {
        console.warn(
          `[transform] Component '${component.identifier}' has no measurements.`,
        );
        continue;
      }
      const schema = new Schema(this.def);
      schema.setup(component.properties);
      this.#measurements[component.identifier] = component.measurements;
      this.#schemas[component.identifier] = schema.read;
    }
  }

  measurements(
    values: Record<string, Record<string, Convert | number>>,
  ): SeriesEntry[] {
    const result: SeriesEntry[] = [];

    // Numeric view of each timestamp's values (Convert -> number), built once and
    // reused for every component's validation below — it's component-independent.
    const numericByTimestamp: Record<string, Record<string, number>> = {};
    for (const timestamp in values) {
      const raw = values[timestamp];
      const numeric: Record<string, number> = {};
      for (const ref in raw) {
        const v = raw[ref];
        numeric[ref] = typeof v === 'number' ? v : v.value();
      }
      numericByTimestamp[timestamp] = numeric;
    }

    for (const componentId in this.#measurements) {
      // Bounds can differ per component (property overrides), so validate every
      // timestamp against this component's own schema.
      for (const timestamp in values)
        this.#schemas[componentId].parse(numericByTimestamp[timestamp]);

      for (const m of this.#measurements[componentId]) {
        for (const timestamp in values) {
          const v = values[timestamp][m.reference];
          if (v === undefined) continue;
          const converter =
            typeof v === 'number'
              ? new Convert().from(v, this.def.read[m.reference].unit as Unit)
              : v;
          result.push({
            identifier: m.identifier,
            timestamp,
            value: converter.to(m.unit as Unit),
          });
        }
      }
    }

    return result;
  }
}
