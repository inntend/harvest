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
};

export type AnyAdaptor = Adaptor<any>;

// Thrown by `configure()` when a connector references an adaptor type id that
// was never `provide()`d (e.g. a custom adaptor the host app forgot to supply).
export class UnknownAdaptorError extends Error {
  constructor(public readonly adaptorId: string) {
    super(`Unknown adaptor: ${adaptorId}`);
    this.name = 'UnknownAdaptorError';
  }
}
