import { Cron } from 'croner';
import type { Component } from './definition';
import { Schema } from './schema';
import { Transform } from './transform';
import { type AnyAdaptor, type DataEvent, UnknownAdaptorError } from './types';

type DataHandler = (event: DataEvent) => void | Promise<void>;
type ErrorHandler = (event: ErrorEvent) => void | Promise<void>;

// Bounded retry with exponential backoff applied to each fetch. `retries` is the
// number of *additional* attempts after the first (0 = no retry).
export type RetryOptions = { retries: number; baseDelayMs?: number };

export type ErrorEvent = {
  readonly connectorId: string;
  readonly adaptorId: string;
  readonly error: unknown;
  readonly attempt: number; // 1-based attempt number that failed
  readonly willRetry: boolean;
};

// A connector instance: an adaptor type bound to a config + components + schedule.
export type ConfigureInput = {
  id: string; // connector id (registry key)
  adaptorId: string; // adaptor type id, resolved from the catalog
  schedule?: string; // overrides the adaptor's default schedule
  config: unknown; // validated via adaptor.config.parse
  components: Component[];
};

type Entry = {
  adaptor: AnyAdaptor;
  config: Record<string, unknown>; // validated at configure() via adaptor.config.parse()
  transform: Transform;
  schedule: string;
  job?: Cron;
};

const DEFAULT_RETRY: Required<RetryOptions> = { retries: 0, baseDelayMs: 500 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AdaptorScheduler {
  readonly #catalog = new Map<string, AnyAdaptor>(); // adaptor type id -> definition
  readonly #registry = new Map<string, Entry>(); // connector id -> instance
  readonly #handlers: DataHandler[] = [];
  readonly #errorHandlers: ErrorHandler[] = [];
  readonly #retry: Required<RetryOptions>;

  constructor(options: { retry?: RetryOptions } = {}) {
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
  }

  // Register adaptor *definitions* (built-in or custom) so connectors can
  // resolve them by type id at configure() time.
  provide(...adaptors: AnyAdaptor[]): this {
    for (const adaptor of adaptors) this.#catalog.set(adaptor.id, adaptor);
    return this;
  }

  // Register a connector *instance*, resolving its adaptor from the catalog.
  configure(input: ConfigureInput): this {
    const adaptor = this.#catalog.get(input.adaptorId);
    if (!adaptor) throw new UnknownAdaptorError(input.adaptorId);
    const config = adaptor.config.parse(input.config);
    const transform = new Transform(adaptor.def);
    transform.setup(input.components);
    this.#registry.set(input.id, {
      adaptor,
      config,
      transform,
      schedule: input.schedule ?? adaptor.schedule,
    });
    return this;
  }

  onData(handler: DataHandler): this {
    this.#handlers.push(handler);
    return this;
  }

  onError(handler: ErrorHandler): this {
    this.#errorHandlers.push(handler);
    return this;
  }

  has(connectorId: string): boolean {
    return this.#registry.has(connectorId);
  }

  start(): this {
    for (const [id, entry] of this.#registry) {
      entry.job?.stop();
      entry.job = new Cron(entry.schedule, () => this.run(id));
    }
    return this;
  }

  stop(): void {
    for (const entry of this.#registry.values()) {
      entry.job?.stop();
      entry.job = undefined;
    }
  }

  // Drop all configured connectors (keeps the adaptor catalog) so the registry
  // can be rebuilt from fresh configuration — used by Harvester.reload().
  reset(): void {
    this.stop();
    this.#registry.clear();
  }

  async run(connectorId: string): Promise<void> {
    const entry = this.#registry.get(connectorId);
    if (!entry) throw new Error(`Unknown connector: ${connectorId}`);

    try {
      const raw = await this.#fetchWithRetry(connectorId, entry);
      const now = new Date();
      const data = await entry.transform.measurements({
        [now.toISOString()]: raw,
      });
      const event: DataEvent = {
        connectorId,
        adaptorId: entry.adaptor.id,
        timestamp: now,
        data,
      };
      await Promise.all(this.#handlers.map((h) => h(event)));
    } catch (err) {
      // Retries are exhausted (onError already emitted per attempt). Keep the
      // scheduled job alive — it self-heals on the next cron tick.
      console.error(`[harvest] Connector "${connectorId}" failed:`, err);
    }
  }

  async write(
    connectorId: string,
    values: Record<string, number>,
  ): Promise<void> {
    const entry = this.#registry.get(connectorId);
    if (!entry) throw new Error(`Unknown connector: ${connectorId}`);
    if (!entry.adaptor.send)
      throw new Error(`Connector "${connectorId}" does not support write`);

    const schema = new Schema(entry.adaptor.def);
    schema.setup();
    const parsed = schema.write.partial().parse(values);
    await entry.adaptor.send(entry.config, parsed as Record<string, number>);
  }

  async #fetchWithRetry(
    connectorId: string,
    entry: Entry,
  ): Promise<Record<string, number>> {
    const { retries, baseDelayMs } = this.#retry;
    const maxAttempts = retries + 1; // first attempt + `retries` additional
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await entry.adaptor.fetch(entry.config);
      } catch (err) {
        const willRetry = attempt < maxAttempts;
        await this.#emitError({
          connectorId,
          adaptorId: entry.adaptor.id,
          error: err,
          attempt,
          willRetry,
        });
        if (!willRetry) throw err;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    // Unreachable: the final attempt always returns or throws above.
    throw new Error('unreachable');
  }

  async #emitError(event: ErrorEvent): Promise<void> {
    await Promise.all(this.#errorHandlers.map((h) => h(event)));
  }
}
