import type { Component, SeriesEntry } from './definition';
import {
  AdaptorScheduler,
  type ErrorEvent,
  type RetryOptions,
} from './scheduler';
import type { AnyAdaptor, DataEvent } from './types';

// The generic shape the store hands the Harvester for each connector. The host
// app maps its own (encrypted) records onto this — Harvest stays storage-agnostic.
export type ConnectorSpec = {
  id: string;
  adaptorId: string;
  schedule: string;
  enabled?: boolean; // default true; disabled connectors are not scheduled
  config: Record<string, unknown>; // -> adaptor.config.parse (bootstrap/credentials)
  components: Component[]; // read feeds -> { reference, unit, identifier }
};

// The port the host implements over its persistence layer. Harvest owns *when*
// to call these; the host owns the actual reads/writes (and any dedupe).
export interface ConnectorStore {
  list(): Promise<ConnectorSpec[]>;
  writeSeries(connectorId: string, entries: SeriesEntry[]): Promise<void>;
}

export type HarvesterOptions = {
  store: ConnectorStore;
  retry?: RetryOptions;
};

const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 1000 };

// Loads connectors from the store, schedules them, fetches on cron, self-heals
// on failure, and writes fetched points back through the store port.
export class Harvester {
  readonly #store: ConnectorStore;
  readonly #scheduler: AdaptorScheduler;
  readonly #errorHandlers: ((event: ErrorEvent) => void | Promise<void>)[] = [];

  constructor(options: HarvesterOptions) {
    this.#store = options.store;
    this.#scheduler = new AdaptorScheduler({
      retry: options.retry ?? DEFAULT_RETRY,
    });
    this.#scheduler.onData((event) =>
      this.#store.writeSeries(event.connectorId, event.data),
    );
    this.#scheduler.onError((event) => this.#emitError(event));
  }

  provide(...adaptors: AnyAdaptor[]): this {
    this.#scheduler.provide(...adaptors);
    return this;
  }

  onData(handler: (event: DataEvent) => void | Promise<void>): this {
    this.#scheduler.onData(handler);
    return this;
  }

  onError(handler: (event: ErrorEvent) => void | Promise<void>): this {
    this.#errorHandlers.push(handler);
    return this;
  }

  async start(): Promise<this> {
    await this.#load();
    this.#scheduler.start();
    return this;
  }

  // Re-read configuration and reschedule — applies enable/disable toggles and
  // any connectors/feeds that arrived via sync.
  async reload(): Promise<this> {
    this.#scheduler.reset();
    await this.#load();
    this.#scheduler.start();
    return this;
  }

  stop(): void {
    this.#scheduler.stop();
  }

  // Trigger a single connector immediately (e.g. for setup/testing).
  async run(connectorId: string): Promise<void> {
    await this.#scheduler.run(connectorId);
  }

  async #load(): Promise<void> {
    const specs = await this.#store.list();
    for (const spec of specs) {
      if (spec.enabled === false) continue;
      try {
        this.#scheduler.configure({
          id: spec.id,
          adaptorId: spec.adaptorId,
          schedule: spec.schedule,
          config: spec.config,
          components: spec.components,
        });
      } catch (error) {
        // e.g. UnknownAdaptorError (custom adaptor not supplied) — skip this
        // connector, keep the rest running.
        await this.#emitError({
          connectorId: spec.id,
          adaptorId: spec.adaptorId,
          error,
          attempt: 0,
          willRetry: false,
        });
      }
    }
  }

  async #emitError(event: ErrorEvent): Promise<void> {
    await Promise.all(this.#errorHandlers.map((h) => h(event)));
  }
}
