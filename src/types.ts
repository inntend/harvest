import type { z } from 'zod';
import type { AdaptorDef, SeriesEntry } from './definition';

type Shape = Record<string, z.ZodTypeAny>;

export type Adaptor<C extends Shape> = {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly config: z.ZodObject<C>;
  readonly def: AdaptorDef;
  fetch(config: z.infer<z.ZodObject<C>>): Promise<Record<string, number>>;
  send?(
    config: z.infer<z.ZodObject<C>>,
    values: Record<string, number>,
  ): Promise<void>;
};

export type DataEvent = {
  readonly adaptorId: string;
  readonly timestamp: Date;
  readonly data: SeriesEntry[];
};

export type AnyAdaptor = Adaptor<any>;
