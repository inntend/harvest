import {
  type AdaptorInfo,
  AdaptorRegistry,
  type ErrorEvent,
  type RetryOptions,
  type WriteInput,
} from './registry';
import type { AnyAdaptor, InputFeed, Reading } from './types';

// What the store hands the Harvester per connector. The host maps its own
// (encrypted) records onto this — Harvest stays storage-agnostic. A fetch pulls
// ALL of the adaptor's declared read fields (wide), so no per-field list is
// needed; the host decides which fields to surface at read time.
export type ConnectorSpec = {
  id: string;
  adaptorId: string;
  enabled?: boolean; // default true; disabled connectors are never invoked
  config: Record<string, unknown>; // -> adaptor.config.parse (bootstrap/credentials)
  // Config keys driven by a measurement history (e.g. ['latitude','longitude']).
  // Empty/absent ⇒ fixed connector (single fetch over the whole range).
  inputs?: string[];
  // Input references populated by a push/captured feed rather than hand-recorded
  // history: input reference -> feed id. Read by Harvester.captureInputs to know
  // which connectors a feed fills (the values still resolve as ordinary input
  // history at fetch time, so this never affects fetchRange).
  inputFeeds?: Record<string, string>;
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
// to call these; the host owns the reads/writes (and dedupe). Cross-device
// fetch dedupe is handled by the host syncing `coveredRanges` (a device that
// already pulled the synced coverage sees no gap), so the port carries no
// per-device claim; within-device overlap is guarded in-memory by the Harvester.
export interface ConnectorStore {
  list(): Promise<ConnectorSpec[]>;
  coveredRanges(connectorId: string): Promise<Interval[]>;
  commitCoverage(connectorId: string, from: string, to: string): Promise<void>;
  // Merge the fetched native-unit read fields into the connector's wide rows
  // (one row per timestamp). A merge — never a whole-row replace — so user
  // recorded input fields on the same row survive a re-fetch.
  writeReadings(connectorId: string, readings: Reading[]): Promise<void>;
  // Clear coverage and the connector's read fields for [from, to) so the range
  // can be fetched fresh — backs Harvester.refetch(). User-recorded input fields
  // are left intact (a re-fetch only overwrites read fields).
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
  retry?: RetryOptions;
};

const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 1000 };

// Demand-driven connector runtime: loads connector configs, and on request fills
// the uncovered gaps of a range by fetching → writing → committing coverage.
export class Harvester {
  readonly #store: ConnectorStore;
  readonly #registry: AdaptorRegistry;
  readonly #errorHandlers: ((event: ErrorEvent) => void | Promise<void>)[] = [];
  // Subscribers notified when a connector starts/stops actively fetching, plus a
  // per-connector in-flight count so we emit only on the 0↔1 transitions.
  readonly #pendingHandlers: ((
    connectorId: string,
    active: boolean,
  ) => void)[] = [];
  readonly #pending = new Map<string, number>();
  // Gaps being fetched right now (`connectorId|from|to`), so overlapping
  // fetchRange calls on this device don't double-fetch the same window before
  // its coverage is committed.
  readonly #inFlight = new Set<string>();
  // connectorId -> config keys driven by a measurement history (from spec.inputs).
  readonly #inputs = new Map<string, string[]>();
  // connectorId -> { input reference -> feed id } (from spec.inputFeeds).
  readonly #inputFeeds = new Map<string, Record<string, string>>();

  constructor(options: HarvesterOptions) {
    this.#store = options.store;
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

  // Subscribe to fetch activity: `active` flips true when a connector starts
  // fetching a gap and false when its last in-flight fetch settles. Lets a host
  // show a pending/skeleton state for exactly the connectors being fetched.
  onPending(handler: (connectorId: string, active: boolean) => void): this {
    this.#pendingHandlers.push(handler);
    return this;
  }

  // Read connector configs from the store and configure the catalog. Connectors
  // whose adaptor wasn't provided (custom, unsupplied) are skipped via onError.
  async load(): Promise<void> {
    const specs = await this.#store.list();
    this.#inputs.clear();
    this.#inputFeeds.clear();
    for (const spec of specs) {
      if (spec.enabled === false) continue;
      try {
        this.#registry.configure({
          id: spec.id,
          adaptorId: spec.adaptorId,
          config: spec.config,
          inputs: spec.inputs,
        });
        if (spec.inputs?.length) this.#inputs.set(spec.id, spec.inputs);
        if (spec.inputFeeds && Object.keys(spec.inputFeeds).length)
          this.#inputFeeds.set(spec.id, spec.inputFeeds);
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
      const key = `${connectorId}|${gap.from}|${gap.to}`;
      if (this.#inFlight.has(key)) continue;
      this.#inFlight.add(key);
      this.#markPending(connectorId, 1);
      try {
        // Connectors with dynamic inputs (e.g. GPS) segment the gap by input
        // history; fixed connectors fetch the whole gap in one call.
        const inputs = this.#inputs.get(connectorId);
        const readings =
          inputs?.length && this.#store.parameterHistory
            ? await this.#fetchSegmented(connectorId, gap, inputs)
            : await this.#registry.fetchReadings(connectorId, {
                from: new Date(gap.from),
                to: new Date(gap.to),
              });
        await this.#store.writeReadings(connectorId, readings);
        // Commit only the FINAL portion of the gap. An adaptor whose recent/
        // future data revises (e.g. a weather forecast) reports a `stableBefore`
        // boundary; the volatile tail past it stays uncovered so the next pull
        // re-fetches and overwrites it, and freezes each day as it ages past the
        // boundary. No boundary ⇒ the whole gap is final (commit it all).
        const boundary = this.#registry.stableBefore(connectorId, new Date());
        const commitTo =
          boundary && boundary.toISOString() < gap.to
            ? boundary.toISOString()
            : gap.to;
        if (commitTo > gap.from)
          await this.#store.commitCoverage(connectorId, gap.from, commitTo);
      } catch {
        // The registry already emitted onError for the failed attempts. The gap
        // stays uncovered, so a later request retries it (self-heal).
      } finally {
        this.#inFlight.delete(key);
        this.#markPending(connectorId, -1);
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
  ): Promise<Reading[]> {
    const points =
      (await this.#store.parameterHistory?.(connectorId, gap.from, gap.to)) ??
      [];
    const segments = segmentByParameters(gap.from, gap.to, points);
    const readings: Reading[] = [];
    for (const segment of segments) {
      const resolved = inputs.every((ref) => ref in segment.config);
      if (!resolved) continue;
      const segReadings = await this.#registry.fetchReadings(
        connectorId,
        { from: new Date(segment.from), to: new Date(segment.to) },
        segment.config,
      );
      readings.push(...segReadings);
    }
    return readings;
  }

  // Force a re-fetch of [from, to): clear its coverage/read fields for the
  // connector, then fetch it again (writing fresh read values).
  async refetch(connectorId: string, from: Date, to: Date): Promise<void> {
    if (!this.#registry.has(connectorId)) return;
    await this.#store.reset(connectorId, from.toISOString(), to.toISOString());
    await this.fetchRange(connectorId, from, to);
  }

  // Capture push/device input feeds into the connectors that bind them. For each
  // feed, finds connectors whose `inputFeeds` reference it and that lack a value
  // at/after `at`, reads the feed once (serving all its consumers), writes the
  // values as those connectors' inputs stamped at `at`, then reopens coverage
  // over [at, through) so the next fetch re-segments on the new value — a range
  // fetched while the feed was unavailable was committed empty, and reopening is
  // what lets it refill. The host owns cadence and supplies `at` (the value's
  // timestamp, e.g. local midnight) and `through` (typically now).
  async captureInputs(
    feeds: InputFeed[],
    at: Date,
    through: Date,
  ): Promise<void> {
    const atIso = at.toISOString();
    const throughIso = through.toISOString();
    for (const feed of feeds) {
      // Connectors binding this feed, with the references it still needs to fill.
      const targets: { id: string; refs: string[] }[] = [];
      for (const [id, map] of this.#inputFeeds) {
        if (!this.#registry.has(id)) continue;
        const refs = Object.entries(map)
          .filter(([, feedId]) => feedId === feed.id)
          .map(([reference]) => reference);
        if (refs.length === 0) continue;
        const history =
          (await this.#store.parameterHistory?.(id, atIso, throughIso)) ?? [];
        const have = new Set(
          history.filter((p) => p.timestamp >= atIso).map((p) => p.reference),
        );
        const missing = refs.filter((r) => !have.has(r));
        if (missing.length > 0) targets.push({ id, refs: missing });
      }
      if (targets.length === 0) continue;

      const values = await feed.read();
      if (!values) continue;

      for (const { id, refs } of targets) {
        const fields = Object.fromEntries(
          refs
            .filter((r) => values[r] !== undefined)
            .map((r) => [r, values[r]]),
        );
        if (Object.keys(fields).length === 0) continue;
        await this.#store.writeReadings(id, [
          { timestamp: atIso, values: fields },
        ]);
        await this.#store.reset(id, atIso, throughIso);
      }
    }
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

  // Track in-flight fetches per connector, emitting only on 0↔1 transitions so
  // overlapping gaps/ranges stay pending until the last one settles.
  #markPending(connectorId: string, delta: 1 | -1): void {
    const count = (this.#pending.get(connectorId) ?? 0) + delta;
    this.#pending.set(connectorId, count);
    if ((delta === 1 && count === 1) || (delta === -1 && count === 0))
      for (const handler of this.#pendingHandlers)
        handler(connectorId, count > 0);
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
