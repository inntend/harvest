import type { Component, SeriesEntry } from './definition';
import {
  type AdaptorInfo,
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
  // Config keys driven by a measurement history (e.g. ['latitude','longitude']).
  // Empty/absent ⇒ fixed connector (single fetch over the whole range).
  inputs?: string[];
};

// An ISO-8601 [from, to) interval. String form keeps the port serialization-free
// and lexicographically sortable (all UTC `…Z`).
export type Interval = { from: string; to: string };

// One sample of a time-varying input parameter. `reference` is the adaptor
// config key; `timestamp` is ISO-8601. Used to segment the fetch range.
export type ParameterPoint = {
  reference: string;
  timestamp: string;
  value: number;
};

// A constant-config window of [from, to) with the input values active over it.
export type Segment = {
  from: string;
  to: string;
  config: Record<string, number>;
};

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
  // History of a connector's input parameters over [from, to), including the
  // last value at or before `from` per reference (carry-in) so the first
  // segment's value is known. Only called for connectors with `inputs`.
  parameterHistory?(
    connectorId: string,
    from: string,
    to: string,
  ): Promise<ParameterPoint[]>;
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
  // connectorId -> config keys driven by a measurement history (from spec.inputs).
  readonly #inputs = new Map<string, string[]>();

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
    this.#inputs.clear();
    for (const spec of specs) {
      if (spec.enabled === false) continue;
      try {
        this.#registry.configure({
          id: spec.id,
          adaptorId: spec.adaptorId,
          config: spec.config,
          components: spec.components,
          inputs: spec.inputs,
        });
        if (spec.inputs?.length) this.#inputs.set(spec.id, spec.inputs);
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
    const inputs = this.#inputs.get(connectorId);
    for (const gap of gaps) {
      const claimed = await this.#store.claim(
        connectorId,
        gap.from,
        gap.to,
        this.#deviceId,
      );
      if (!claimed) continue;
      try {
        const entries =
          inputs?.length && this.#store.parameterHistory
            ? await this.#fetchSegmented(connectorId, gap, inputs)
            : await this.#registry.fetch(connectorId, {
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

  // Resolve the connector's input histories over the gap, split it into
  // constant-config segments (hold-forward), and fetch each segment with its own
  // config override. Segments missing a value for any required input are skipped
  // (no value ⇒ no data) but the gap is still committed as covered; a fetch
  // error propagates so the caller aborts the gap (no commit → retried).
  async #fetchSegmented(
    connectorId: string,
    gap: Interval,
    inputs: string[],
  ): Promise<SeriesEntry[]> {
    const points =
      (await this.#store.parameterHistory?.(connectorId, gap.from, gap.to)) ??
      [];
    const segments = segmentByParameters(gap.from, gap.to, points);
    const entries: SeriesEntry[] = [];
    for (const segment of segments) {
      const resolved = inputs.every((ref) => ref in segment.config);
      if (!resolved) continue;
      const segEntries = await this.#registry.fetch(
        connectorId,
        { from: new Date(segment.from), to: new Date(segment.to) },
        segment.config,
      );
      entries.push(...segEntries);
    }
    return entries;
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

  // The def for a registered adaptor type, or null if not provided.
  adaptorDef(adaptorId: string): ReturnType<AdaptorRegistry['adaptorDef']> {
    return this.#registry.adaptorDef(adaptorId);
  }

  // All registered adaptor types (for an adaptor picker in the host UI).
  adaptors(): AdaptorInfo[] {
    return this.#registry.catalog();
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

// Split [from, to) into constant-config segments from time-varying input points,
// using hold-forward (step) semantics: each point's value applies from its
// timestamp until the next change for that reference. `points` should include
// the last value at or before `from` per reference (carry-in) so the first
// segment is resolved. A reference with no value at a segment is simply absent
// from that segment's config (the caller decides whether that's fetchable).
export function segmentByParameters(
  from: string,
  to: string,
  points: ParameterPoint[],
): Segment[] {
  if (points.length === 0) return [];

  const sorted = [...points].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : 1,
  );

  // Boundaries: `from`, then each distinct change time strictly inside (from, to).
  const boundaries: string[] = [from];
  for (const p of sorted)
    if (
      p.timestamp > from &&
      p.timestamp < to &&
      p.timestamp !== boundaries[boundaries.length - 1]
    )
      boundaries.push(p.timestamp);

  // Single forward sweep: at each boundary, fold in every point active by then
  // (hold-forward), then snapshot the running config for the segment.
  const segments: Segment[] = [];
  const active: Record<string, number> = {};
  let i = 0;
  for (let b = 0; b < boundaries.length; b++) {
    const segFrom = boundaries[b];
    const segTo = b + 1 < boundaries.length ? boundaries[b + 1] : to;
    while (i < sorted.length && sorted[i].timestamp <= segFrom) {
      active[sorted[i].reference] = sorted[i].value;
      i++;
    }
    segments.push({ from: segFrom, to: segTo, config: { ...active } });
  }
  return segments;
}
