import type { z } from 'zod';

type Shape = Record<string, z.ZodTypeAny>;

/**
 * An adaptor defines its capabilities through three Zod schemas:
 * - config: static properties & configuration (host, port, capacity…)
 *           constraints like min/max are expressed directly via Zod
 * - read:   values the adaptor can provide, validated on each fetch
 * - write:  values the adaptor can accept via send()
 */
export type Adaptor<C extends Shape, R extends Shape, W extends Shape> = {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly config: z.ZodObject<C>;
  readonly read: z.ZodObject<R>;
  readonly write: z.ZodObject<W>;
  fetch(
    config: z.infer<z.ZodObject<C>>,
  ): Promise<Partial<z.infer<z.ZodObject<R>>>>;
  send?(
    config: z.infer<z.ZodObject<C>>,
    values: Partial<z.infer<z.ZodObject<W>>>,
  ): Promise<void>;
};

export type DataEvent<T = Record<string, unknown>> = {
  readonly adaptorId: string;
  readonly timestamp: Date;
  readonly data: T;
};

export type AnyAdaptor = Adaptor<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
