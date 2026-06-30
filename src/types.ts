import type { z } from 'zod';
import type { AdaptorDef } from './definition';

type Shape = Record<string, z.ZodTypeAny>;

// A time window to fetch. Connectors are invoked on demand for a range.
export type Range = { from: Date; to: Date };

// One timestamped sample. `timestamp` is the source data's own time (ISO 8601),
// so the same point fetched by any device dedupes by (source, timestamp).
export type Reading = { timestamp: string; values: Record<string, number> };

export type Adaptor<C extends Shape> = {
  readonly id: string;
  readonly name: string;
  readonly config: z.ZodObject<C>;
  readonly def: AdaptorDef;
  fetch(config: z.infer<z.ZodObject<C>>, range: Range): Promise<Reading[]>;
  send?(
    config: z.infer<z.ZodObject<C>>,
    values: Record<string, number>,
  ): Promise<void>;
  // The instant on/before which this adaptor's data is final (immutable). Anything
  // at or after it is volatile (e.g. a weather forecast that revises) and must be
  // re-fetched on each pull. The Harvester commits coverage only up to this
  // boundary, leaving the volatile tail uncovered. Absent ⇒ all data is final.
  stableBefore?(now: Date): Date;
};

export type AnyAdaptor = Adaptor<any>;

// A push/captured source for a connector's time-varying inputs (e.g. a device's
// GPS → latitude/longitude). Unlike adaptor.fetch (demand-pull from a remote API
// over a range), a feed is captured at a point in time and written into the
// connector's own input series, then read back via the store's parameterHistory
// for segmentation. `read` performs any permission/IO and returns the current
// values keyed by input reference, or null when unavailable/denied.
export type InputFeed = {
  readonly id: string;
  read(): Promise<Record<string, number> | null>;
};

// Thrown by `configure()` when a connector references an adaptor type id that
// was never `provide()`d (e.g. a custom adaptor the host app forgot to supply).
export class UnknownAdaptorError extends Error {
  constructor(public readonly adaptorId: string) {
    super(`Unknown adaptor: ${adaptorId}`);
    this.name = 'UnknownAdaptorError';
  }
}
