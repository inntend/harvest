import { Convert, type UnitKey, type UnitsLibrary } from '@inntend/convert';
import type { Component, SeriesEntry } from './definition';
import { Schema } from './schema';
import { Transform } from './transform';
import {
  type AnyAdaptor,
  type Range,
  type Reading,
  UnknownAdaptorError,
} from './types';

type Unit = UnitKey<typeof UnitsLibrary>;
type ErrorHandler = (event: ErrorEvent) => void | Promise<void>;

// Bounded retry with exponential backoff applied to each fetch. `retries` is the
// number of *additional* attempts after the first (0 = no retry).
export type RetryOptions = { retries: number; baseDelayMs?: number };

export type ErrorEvent = {
  readonly connectorId: string;
  readonly adaptorId: string;
  readonly error: unknown;
  readonly attempt: number; // 1-based attempt number that failed (0 = configure)
  readonly willRetry: boolean;
};

export type ConfigureInput = {
  id: string; // connector id
  adaptorId: string; // adaptor type id, resolved from the catalog
  config: unknown; // validated via adaptor.config.parse
  components: Component[];
  // Config keys supplied per-fetch from a measurement history. They may be
  // absent from `config` at configure time (validated per fetch instead).
  inputs?: string[];
};

export type WriteInput = { reference: string; value: number; unit: string };

type Entry = {
  adaptor: AnyAdaptor;
  raw: unknown; // unparsed config; re-parsed with overrides for dynamic inputs
  config: Record<string, unknown>; // parsed/validated config (no overrides)
  transform: Transform;
};

const DEFAULT_RETRY: Required<RetryOptions> = { retries: 0, baseDelayMs: 500 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Holds the adaptor catalog (built-in + custom) and the configured connectors,
// and executes range fetches / writes. No scheduling — invoked on demand.
export class AdaptorRegistry {
  readonly #catalog = new Map<string, AnyAdaptor>(); // adaptor type id -> definition
  readonly #connectors = new Map<string, Entry>(); // connector id -> instance
  readonly #errorHandlers: ErrorHandler[] = [];
  readonly #retry: Required<RetryOptions>;

  constructor(options: { retry?: RetryOptions } = {}) {
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
  }

  provide(...adaptors: AnyAdaptor[]): this {
    for (const adaptor of adaptors) this.#catalog.set(adaptor.id, adaptor);
    return this;
  }

  configure(input: ConfigureInput): this {
    const adaptor = this.#catalog.get(input.adaptorId);
    if (!adaptor) throw new UnknownAdaptorError(input.adaptorId);
    // Dynamic-input keys may be absent from the bootstrap config (they come from
    // a measurement history per fetch), so relax them here; the per-fetch parse
    // in fetch() validates the fully-resolved config.
    const schema = input.inputs?.length
      ? adaptor.config.partial(
          Object.fromEntries(input.inputs.map((k) => [k, true])),
        )
      : adaptor.config;
    const config = schema.parse(input.config) as Record<string, unknown>;
    const transform = new Transform(adaptor.def);
    transform.setup(input.components);
    this.#connectors.set(input.id, {
      adaptor,
      raw: input.config,
      config,
      transform,
    });
    return this;
  }

  onError(handler: ErrorHandler): this {
    this.#errorHandlers.push(handler);
    return this;
  }

  has(connectorId: string): boolean {
    return this.#connectors.has(connectorId);
  }

  // The ids of all currently-configured connectors.
  connectorIds(): string[] {
    return [...this.#connectors.keys()];
  }

  // The def for a registered adaptor type, or null if unknown.
  adaptorDef(adaptorId: string): AnyAdaptor['def'] | null {
    return this.#catalog.get(adaptorId)?.def ?? null;
  }

  // Fetch a range and transform the readings into SeriesEntry[] (each entry's
  // identifier is the feed id from the configured components). `configOverride`
  // supplies time-varying input values (e.g. a GPS segment's lat/long); they are
  // merged onto the raw config and re-validated via adaptor.config.parse.
  async fetch(
    connectorId: string,
    range: Range,
    configOverride?: Record<string, number>,
  ): Promise<SeriesEntry[]> {
    const entry = this.#connectors.get(connectorId);
    if (!entry) throw new Error(`Unknown connector: ${connectorId}`);
    const config = configOverride
      ? (entry.adaptor.config.parse({
          ...(entry.raw as Record<string, unknown>),
          ...configOverride,
        }) as Record<string, unknown>)
      : entry.config;
    const readings = await this.#fetchWithRetry(
      connectorId,
      entry,
      range,
      config,
    );
    const byTimestamp: Record<string, Record<string, number>> = {};
    for (const reading of readings)
      byTimestamp[reading.timestamp] = reading.values;
    return entry.transform.measurements(byTimestamp);
  }

  // Push values out to the source (manual write-back). Each input value is
  // converted from its measurement unit to the adaptor's write-field unit.
  async write(connectorId: string, inputs: WriteInput[]): Promise<void> {
    const entry = this.#connectors.get(connectorId);
    if (!entry) throw new Error(`Unknown connector: ${connectorId}`);
    if (!entry.adaptor.send)
      throw new Error(`Connector "${connectorId}" does not support write`);

    const def = entry.adaptor.def;
    const values: Record<string, number> = {};
    for (const input of inputs) {
      const target = def.write[input.reference];
      if (!target)
        throw new Error(
          `Connector "${connectorId}" has no write field "${input.reference}"`,
        );
      values[input.reference] = new Convert()
        .from(input.value, input.unit as Unit)
        .to(target.unit as Unit);
    }

    const schema = new Schema(def);
    schema.setup();
    const parsed = schema.write.partial().parse(values);
    await entry.adaptor.send(entry.config, parsed as Record<string, number>);
  }

  async #fetchWithRetry(
    connectorId: string,
    entry: Entry,
    range: Range,
    config: Record<string, unknown>,
  ): Promise<Reading[]> {
    const { retries, baseDelayMs } = this.#retry;
    const maxAttempts = retries + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await entry.adaptor.fetch(config, range);
      } catch (err) {
        lastError = err;
        const willRetry = attempt < maxAttempts;
        await this.#emitError({
          connectorId,
          adaptorId: entry.adaptor.id,
          error: err,
          attempt,
          willRetry,
        });
        if (willRetry) await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  async #emitError(event: ErrorEvent): Promise<void> {
    await Promise.all(this.#errorHandlers.map((h) => h(event)));
  }
}
