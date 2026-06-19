import type { Component, SeriesEntry } from './definition';
import {
  AdaptorRegistry,
  type ErrorEvent,
  type RetryOptions,
  type WriteInput,
} from './registry';
import type { AnyAdaptor } from './types';

// What the store hands the Harvester per connector. The host maps its own
// (encrypted) records onto this — Harvest stays storage-agnostic.
export type ConnectorSpec = {
  id: string;
  adaptorId: string;
  enabled?: boolean; // default true; disabled connectors are never invoked
  config: Record<string, unknown>; // -> adaptor.config.parse (bootstrap/credentials)
  components: Component[]; // read feeds -> { reference, unit, identifier: feedId }
};

// An ISO-8601 [from, to) interval. String form keeps the port serialization-free
// and lexicographically sortable (all UTC `…Z`).
export type Interval = { from: string; to: string };

// The port the host implements over its persistence layer. Harvest owns *when*
// to call these; the host owns the reads/writes (and dedupe).
export interface ConnectorStore {
  list(): Promise<ConnectorSpec[]>;
  coveredRanges(connectorId: string): Promise<Interval[]>;
  // Returns false if the interval is already covered or live-claimed by another
  // device; otherwise records a claim for `deviceId` and returns true.
  claim(
    connectorId: string,
    from: string,
    to: string,
    deviceId: string,
  ): Promise<boolean>;
  commitCoverage(connectorId: string, from: string, to: string): Promise<void>;
  writeSeries(connectorId: string, entries: SeriesEntry[]): Promise<void>;
  // Clear coverage, claims and connector-sourced series for [from, to) so the
  // range can be fetched fresh — backs Harvester.refetch().
  reset(connectorId: string, from: string, to: string): Promise<void>;
}

export type HarvesterOptions = {
  store: ConnectorStore;
  deviceId: string;
  retry?: RetryOptions;
};

const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 1000 };

// Demand-driven connector runtime: loads connector configs, and on request fills
// the uncovered gaps of a range by claiming → fetching → writing → committing.
export class Harvester {
  readonly #store: ConnectorStore;
  readonly #registry: AdaptorRegistry;
  readonly #deviceId: string;
  readonly #errorHandlers: ((event: ErrorEvent) => void | Promise<void>)[] = [];

  constructor(options: HarvesterOptions) {
    this.#store = options.store;
    this.#deviceId = options.deviceId;
    this.#registry = new AdaptorRegistry({
      retry: options.retry ?? DEFAULT_RETRY,
    });
    this.#registry.onError((event) => this.#emitError(event));
  }

  provide(...adaptors: AnyAdaptor[]): this {
    this.#registry.provide(...adaptors);
    return this;
  }

  onError(handler: (event: ErrorEvent) => void | Promise<void>): this {
    this.#errorHandlers.push(handler);
    return this;
  }

  // Read connector configs from the store and configure the catalog. Connectors
  // whose adaptor wasn't provided (custom, unsupplied) are skipped via onError.
  async load(): Promise<void> {
    const specs = await this.#store.list();
    for (const spec of specs) {
      if (spec.enabled === false) continue;
      try {
        this.#registry.configure({
          id: spec.id,
          adaptorId: spec.adaptorId,
          config: spec.config,
          components: spec.components,
        });
      } catch (error) {
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

  // Fill any uncovered gaps of [from, to) for one connector.
  async fetchRange(connectorId: string, from: Date, to: Date): Promise<void> {
    if (!this.#registry.has(connectorId)) return;
    const covered = await this.#store.coveredRanges(connectorId);
    const gaps = subtractIntervals(
      from.toISOString(),
      to.toISOString(),
      covered,
    );
    for (const gap of gaps) {
      const claimed = await this.#store.claim(
        connectorId,
        gap.from,
        gap.to,
        this.#deviceId,
      );
      if (!claimed) continue;
      try {
        const entries = await this.#registry.fetch(connectorId, {
          from: new Date(gap.from),
          to: new Date(gap.to),
        });
        await this.#store.writeSeries(connectorId, entries);
        await this.#store.commitCoverage(connectorId, gap.from, gap.to);
      } catch {
        // The registry already emitted onError for the failed attempts. Leave the
        // claim to expire so a later request retries this gap (self-heal).
      }
    }
  }

  // Force a re-fetch of [from, to): clear its coverage/claims/series for the
  // connector, then fetch it again (writing fresh values).
  async refetch(connectorId: string, from: Date, to: Date): Promise<void> {
    if (!this.#registry.has(connectorId)) return;
    await this.#store.reset(connectorId, from.toISOString(), to.toISOString());
    await this.fetchRange(connectorId, from, to);
  }

  // Manual write-back: push values out via the connector's adaptor.send().
  async write(connectorId: string, inputs: WriteInput[]): Promise<void> {
    await this.#registry.write(connectorId, inputs);
  }

  // The ids of all loaded/configured connectors (enabled + adaptor available).
  connectorIds(): string[] {
    return this.#registry.connectorIds();
  }

  async #emitError(event: ErrorEvent): Promise<void> {
    await Promise.all(this.#errorHandlers.map((h) => h(event)));
  }
}

// [from, to) minus the union of covered intervals → the remaining gaps to fetch.
export function subtractIntervals(
  from: string,
  to: string,
  covered: Interval[],
): Interval[] {
  const sorted = covered
    .filter((c) => c.to > from && c.from < to)
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  const gaps: Interval[] = [];
  let cursor = from;
  for (const c of sorted) {
    // c.from < to is guaranteed by the filter above, so it bounds the gap.
    if (c.from > cursor) gaps.push({ from: cursor, to: c.from });
    if (c.to > cursor) cursor = c.to;
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}
