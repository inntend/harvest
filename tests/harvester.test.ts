import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type ConnectorSpec,
  type ConnectorStore,
  Harvester,
  type Interval,
  type ParameterPoint,
  segmentByParameters,
  subtractIntervals,
} from '../src/harvester';
import type { Adaptor, Range, Reading } from '../src/types';

const config = z.object({ host: z.string() });

const adaptor = (
  fetchFn: Adaptor<typeof config.shape>['fetch'] = async (_cfg, range) => [
    { timestamp: range.to.toISOString(), values: { value: 42 } },
  ],
): Adaptor<typeof config.shape> => ({
  id: 'test',
  name: 'Test',
  config,
  def: {
    properties: {},
    read: { value: { unit: '%', min: 0, max: 100 } },
    write: {},
  },
  fetch: fetchFn,
});

const spec = (over: Partial<ConnectorSpec> = {}): ConnectorSpec => ({
  id: 'c1',
  adaptorId: 'test',
  config: { host: 'h' },
  ...over,
});

const FROM = new Date('2024-01-01T00:00:00Z');
const TO = new Date('2024-01-02T00:00:00Z');

// Mirror of registry.ts's read-schema version hash so seeded coverage carries the
// version the harvester computes for the test adaptor (read keys ['value'], no
// salt). If the hashing changes, these tests fail loudly and this is updated.
function readVersion(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
const VERSION = readVersion('value|');

function makeStore(
  specs: ConnectorSpec[],
  covered: Record<string, Interval[]> = {},
  history: Record<string, ParameterPoint[]> = {},
) {
  return {
    list: vi.fn(async () => specs),
    coveredRanges: vi.fn(async (id: string) => covered[id] ?? []),
    commitCoverage: vi.fn(
      async (_id: string, _from: string, _to: string, _version?: string) => {},
    ),
    writeReadings: vi.fn(async (_id: string, _readings: Reading[]) => {}),
    reset: vi.fn(async () => {}),
    parameterHistory: vi.fn(async (id: string) => history[id] ?? []),
  };
}

const harvester = (
  store: ReturnType<typeof makeStore>,
  opts?: { volatileTtlMs?: number },
) =>
  new Harvester({
    store: store as unknown as ConnectorStore,
    retry: { retries: 0 },
    volatileTtlMs: opts?.volatileTtlMs,
  });

describe('Harvester.fetchRange', () => {
  it('fetches an uncovered range, writes readings, commits coverage', async () => {
    const store = makeStore([spec()]);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);

    expect(store.writeReadings).toHaveBeenCalledOnce();
    expect(store.writeReadings.mock.calls[0][1][0]).toMatchObject({
      timestamp: TO.toISOString(),
      values: { value: 42 },
    });
    expect(store.commitCoverage).toHaveBeenCalledOnce();
  });

  it('skips fetching when the range is fully covered', async () => {
    const store = makeStore([spec()], {
      c1: [
        { from: FROM.toISOString(), to: TO.toISOString(), version: VERSION },
      ],
    });
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).not.toHaveBeenCalled();
  });

  it('does not double-fetch a gap already in flight on this device', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = makeStore([spec()]);
    const fetchFn = vi.fn(async (_cfg, range) => {
      await gate; // hold the first fetch open while the second is requested
      return [{ timestamp: range.to.toISOString(), values: { value: 1 } }];
    });
    const h = harvester(store).provide(adaptor(fetchFn));
    await h.load();

    const p1 = h.fetchRange('c1', FROM, TO);
    const p2 = h.fetchRange('c1', FROM, TO); // same gap, while p1 is in flight
    await new Promise((r) => setTimeout(r, 0));

    release();
    await Promise.all([p1, p2]);

    // The second call saw the gap in flight and skipped it — one fetch, one write.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.writeReadings).toHaveBeenCalledOnce();
  });

  it('does not configure disabled connectors', async () => {
    const store = makeStore([spec({ enabled: false })]);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).not.toHaveBeenCalled();
  });

  it('exposes the ids of loaded connectors', async () => {
    const store = makeStore([spec(), spec({ id: 'c2' })]);
    const h = harvester(store).provide(adaptor());
    expect(h.connectorIds()).toEqual([]); // none before load
    await h.load();
    expect(h.connectorIds()).toEqual(['c1', 'c2']);
  });

  it('reports onError for connectors whose adaptor was not provided', async () => {
    const onError = vi.fn();
    const store = makeStore([spec({ id: 'custom', adaptorId: 'missing' })]);
    const h = harvester(store);
    h.onError(onError);
    await h.load();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({
      connectorId: 'custom',
      adaptorId: 'missing',
    });
  });

  it('does not commit coverage when the fetch fails', async () => {
    const store = makeStore([spec()]);
    const h = harvester(store).provide(
      adaptor(async () => {
        throw new Error('down');
      }),
    );
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.commitCoverage).not.toHaveBeenCalled();
  });

  it('defaults the retry policy when none is supplied', async () => {
    const store = makeStore([spec()]);
    // No `retry` option → falls back to DEFAULT_RETRY internally.
    const h = new Harvester({
      store: store as unknown as ConnectorStore,
    }).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).toHaveBeenCalledOnce();
  });

  it('emits pending true then false while fetching an uncovered range', async () => {
    const store = makeStore([spec()]);
    const events: [string, boolean][] = [];
    const h = harvester(store)
      .provide(adaptor())
      .onPending((id, active) => events.push([id, active]));
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(events).toEqual([
      ['c1', true],
      ['c1', false],
    ]);
  });

  it('emits no pending events when the range is fully covered', async () => {
    const store = makeStore([spec()], {
      c1: [
        { from: FROM.toISOString(), to: TO.toISOString(), version: VERSION },
      ],
    });
    const events: [string, boolean][] = [];
    const h = harvester(store)
      .provide(adaptor())
      .onPending((id, active) => events.push([id, active]));
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(events).toEqual([]);
  });

  it('emits pending once across overlapping fetches (ref-counted)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = makeStore([spec()]);
    const events: [string, boolean][] = [];
    const h = harvester(store)
      .provide(
        adaptor(async (_cfg, range) => {
          await gate; // hold both fetches in flight at once
          return [{ timestamp: range.to.toISOString(), values: { value: 1 } }];
        }),
      )
      .onPending((id, active) => events.push([id, active]));
    await h.load();

    // Two distinct ranges → two gaps fetched concurrently on the same connector.
    const FROM2 = new Date('2024-02-01T00:00:00Z');
    const TO2 = new Date('2024-02-02T00:00:00Z');
    const p1 = h.fetchRange('c1', FROM, TO);
    const p2 = h.fetchRange('c1', FROM2, TO2);

    // Let both reach the gated fetch: the count climbs to 2 but only the 0→1
    // transition emits.
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([['c1', true]]);

    release();
    await Promise.all([p1, p2]);

    // Only the last fetch settling (1→0) emits the false; no churn at 2↔1.
    expect(events).toEqual([
      ['c1', true],
      ['c1', false],
    ]);
  });
});

describe('Harvester.refetch', () => {
  it('resets the range then fetches it', async () => {
    const store = makeStore([spec()]);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.refetch('c1', FROM, TO);

    expect(store.reset).toHaveBeenCalledWith(
      'c1',
      FROM.toISOString(),
      TO.toISOString(),
    );
    expect(store.writeReadings).toHaveBeenCalledOnce();
    expect(store.commitCoverage).toHaveBeenCalledOnce();
  });

  it('is a no-op for an unconfigured connector', async () => {
    const store = makeStore([]);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.refetch('ghost', FROM, TO);
    expect(store.reset).not.toHaveBeenCalled();
  });
});

describe('Harvester catalog lookups', () => {
  it('adaptorDef returns the def for a provided adaptor, null otherwise', () => {
    const store = makeStore([]);
    const a = adaptor();
    const h = harvester(store).provide(a);
    expect(h.adaptorDef('test')).toEqual(a.def);
    expect(h.adaptorDef('ghost')).toBeNull();
  });

  it('adaptors lists every provided adaptor type', () => {
    const store = makeStore([]);
    const a = adaptor();
    const h = harvester(store).provide(a);
    expect(h.adaptors()).toEqual([{ id: 'test', name: 'Test', def: a.def }]);
  });
});

describe('Harvester.write', () => {
  const writableAdaptor = (send = vi.fn()): Adaptor<typeof config.shape> => ({
    id: 'test',
    name: 'Test',
    config,
    def: {
      properties: {},
      read: { value: { unit: '%', min: 0, max: 100 } },
      write: { target: { unit: '%', min: 0, max: 100 } },
    },
    fetch: async (_cfg, range) => [
      { timestamp: range.to.toISOString(), values: { value: 42 } },
    ],
    send,
  });

  it('delegates write-back to the connector adaptor.send()', async () => {
    const send = vi.fn();
    const store = makeStore([spec()]);
    const h = harvester(store).provide(writableAdaptor(send));
    await h.load();
    await h.write('c1', [{ reference: 'target', value: 75, unit: '%' }]);
    expect(send).toHaveBeenCalledWith({ host: 'h' }, { target: 75 });
  });
});

describe('Harvester.fetchRange with dynamic inputs', () => {
  const dynConfig = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  });

  // Echoes the config it was called with into the reading values so tests can
  // assert which lat/long each segment used.
  const dynAdaptor = (): Adaptor<typeof dynConfig.shape> => ({
    id: 'dyn',
    name: 'Dyn',
    config: dynConfig,
    def: {
      properties: {},
      read: { lat: { unit: 'deg' }, lng: { unit: 'deg' } },
      write: {},
      inputs: {
        latitude: { unit: 'deg', min: -90, max: 90 },
        longitude: { unit: 'deg', min: -180, max: 180 },
      },
    },
    fetch: async (cfg, range) => [
      {
        timestamp: range.from.toISOString(),
        values: {
          lat: (cfg as { latitude: number }).latitude,
          lng: (cfg as { longitude: number }).longitude,
        },
      },
    ],
  });

  const dynSpec = (): ConnectorSpec => ({
    id: 'gps',
    adaptorId: 'dyn',
    config: {}, // no fixed coordinates; supplied per-segment from history
    inputs: ['latitude', 'longitude'],
  });

  it('fetches once per location segment with merged config', async () => {
    const mid = '2024-01-01T12:00:00.000Z';
    const store = makeStore(
      [dynSpec()],
      {},
      {
        gps: [
          { reference: 'latitude', timestamp: FROM.toISOString(), value: 52 },
          { reference: 'longitude', timestamp: FROM.toISOString(), value: 13 },
          { reference: 'latitude', timestamp: mid, value: 42 },
          { reference: 'longitude', timestamp: mid, value: -71 },
        ],
      },
    );
    const h = harvester(store).provide(dynAdaptor());
    await h.load();
    await h.fetchRange('gps', FROM, TO);

    // Two segments → both written in one commit/writeReadings for the gap.
    expect(store.commitCoverage).toHaveBeenCalledOnce();
    expect(store.writeReadings).toHaveBeenCalledOnce();
    const readings = store.writeReadings.mock.calls[0][1];
    // Segment 1 (Berlin) lat=52, Segment 2 (Boston) lat=42.
    const lats = readings.map((r) => r.values.lat).sort((a, b) => a - b);
    expect(lats).toEqual([42, 52]);
  });

  it('skips segments with no resolved input value but still covers the gap', async () => {
    const firstPoint = '2024-01-01T12:00:00.000Z';
    // Only a value from mid-range onward → the [FROM, firstPoint) segment is
    // unresolved and skipped, but the gap is still committed as covered.
    const store = makeStore(
      [dynSpec()],
      {},
      {
        gps: [
          { reference: 'latitude', timestamp: firstPoint, value: 42 },
          { reference: 'longitude', timestamp: firstPoint, value: -71 },
        ],
      },
    );
    const h = harvester(store).provide(dynAdaptor());
    await h.load();
    await h.fetchRange('gps', FROM, TO);

    const readings = store.writeReadings.mock.calls[0][1];
    // One resolved segment → one reading written (its values carry lat/lng).
    expect(readings).toHaveLength(1);
    expect(readings[0].values).toMatchObject({ lat: 42, lng: -71 });
    expect(store.commitCoverage).toHaveBeenCalledOnce();
  });

  it('treats missing parameter history as no segments but still covers the gap', async () => {
    const store = makeStore([dynSpec()]);
    // parameterHistory present (so the segmented path runs) but returns nothing.
    store.parameterHistory = vi.fn(
      async () => undefined as unknown as ParameterPoint[],
    );
    const h = harvester(store).provide(dynAdaptor());
    await h.load();
    await h.fetchRange('gps', FROM, TO);

    expect(store.writeReadings).toHaveBeenCalledWith('gps', []);
    expect(store.commitCoverage).toHaveBeenCalledOnce();
  });

  it('does not segment a connector without inputs (fixed path)', async () => {
    const store = makeStore([spec()]);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.parameterHistory).not.toHaveBeenCalled();
  });
});

describe('segmentByParameters', () => {
  const FROM_S = '2024-01-01T00:00:00.000Z';
  const TO_S = '2024-01-02T00:00:00.000Z';
  const MID_S = '2024-01-01T12:00:00.000Z';

  it('returns one segment spanning the whole range when nothing changes', () => {
    const segs = segmentByParameters(FROM_S, TO_S, [
      { reference: 'latitude', timestamp: FROM_S, value: 52 },
    ]);
    expect(segs).toEqual([
      { from: FROM_S, to: TO_S, config: { latitude: 52 } },
    ]);
  });

  it('splits at a mid-range change (hold-forward)', () => {
    const segs = segmentByParameters(FROM_S, TO_S, [
      { reference: 'latitude', timestamp: FROM_S, value: 52 },
      { reference: 'latitude', timestamp: MID_S, value: 42 },
    ]);
    expect(segs).toEqual([
      { from: FROM_S, to: MID_S, config: { latitude: 52 } },
      { from: MID_S, to: TO_S, config: { latitude: 42 } },
    ]);
  });

  it('carries a value recorded before `from` into the first segment', () => {
    const before = '2023-12-31T00:00:00.000Z';
    const segs = segmentByParameters(FROM_S, TO_S, [
      { reference: 'latitude', timestamp: before, value: 52 },
    ]);
    expect(segs).toEqual([
      { from: FROM_S, to: TO_S, config: { latitude: 52 } },
    ]);
  });

  it('combines multiple references changing at different times', () => {
    const t1 = '2024-01-01T06:00:00.000Z';
    const t2 = '2024-01-01T18:00:00.000Z';
    const segs = segmentByParameters(FROM_S, TO_S, [
      { reference: 'latitude', timestamp: FROM_S, value: 52 },
      { reference: 'longitude', timestamp: FROM_S, value: 13 },
      { reference: 'latitude', timestamp: t1, value: 48 },
      { reference: 'longitude', timestamp: t2, value: 2 },
    ]);
    expect(segs).toEqual([
      { from: FROM_S, to: t1, config: { latitude: 52, longitude: 13 } },
      { from: t1, to: t2, config: { latitude: 48, longitude: 13 } },
      { from: t2, to: TO_S, config: { latitude: 48, longitude: 2 } },
    ]);
  });

  it('omits a reference with no value at a segment', () => {
    const segs = segmentByParameters(FROM_S, TO_S, [
      { reference: 'latitude', timestamp: MID_S, value: 42 },
    ]);
    expect(segs).toEqual([
      { from: FROM_S, to: MID_S, config: {} },
      { from: MID_S, to: TO_S, config: { latitude: 42 } },
    ]);
  });

  it('sorts history supplied out of chronological order', () => {
    // Points given newest-first → exercises the sort comparator's reorder path.
    const segs = segmentByParameters(FROM_S, TO_S, [
      { reference: 'latitude', timestamp: MID_S, value: 42 },
      { reference: 'latitude', timestamp: FROM_S, value: 52 },
    ]);
    expect(segs).toEqual([
      { from: FROM_S, to: MID_S, config: { latitude: 52 } },
      { from: MID_S, to: TO_S, config: { latitude: 42 } },
    ]);
  });

  it('returns no segments when there is no history', () => {
    expect(segmentByParameters(FROM_S, TO_S, [])).toEqual([]);
  });
});

describe('subtractIntervals', () => {
  it('returns the whole range when nothing is covered', () => {
    expect(subtractIntervals('a', 'z', [])).toEqual([{ from: 'a', to: 'z' }]);
  });

  it('subtracts a middle covered interval', () => {
    const gaps = subtractIntervals(
      '2024-01-01T00:00:00.000Z',
      '2024-01-05T00:00:00.000Z',
      [{ from: '2024-01-02T00:00:00.000Z', to: '2024-01-03T00:00:00.000Z' }],
    );
    expect(gaps).toEqual([
      { from: '2024-01-01T00:00:00.000Z', to: '2024-01-02T00:00:00.000Z' },
      { from: '2024-01-03T00:00:00.000Z', to: '2024-01-05T00:00:00.000Z' },
    ]);
  });

  it('returns empty when fully covered', () => {
    expect(subtractIntervals('b', 'y', [{ from: 'a', to: 'z' }])).toEqual([]);
  });

  it('sorts unsorted intervals and absorbs nested ones', () => {
    // Passed out of order (exercises the sort comparator) and 'd'–'f' is nested
    // inside 'b'–'k' (exercises the non-advancing cursor path).
    const gaps = subtractIntervals('a', 'z', [
      { from: 'p', to: 't' },
      { from: 'b', to: 'k' },
      { from: 'd', to: 'f' },
    ]);
    expect(gaps).toEqual([
      { from: 'a', to: 'b' },
      { from: 'k', to: 'p' },
      { from: 't', to: 'z' },
    ]);
  });
});

describe('Harvester.captureInputs', () => {
  const AT = new Date('2024-01-02T00:00:00Z');
  const THROUGH = new Date('2024-01-02T12:00:00Z');

  const gpsConfig = z.object({
    latitude: z.number(),
    longitude: z.number(),
  });
  const gpsAdaptor: Adaptor<typeof gpsConfig.shape> = {
    id: 'gps',
    name: 'GPS',
    config: gpsConfig,
    def: {
      properties: {},
      read: { temp: { unit: 'C' } },
      write: {},
      inputs: { latitude: { unit: 'deg' }, longitude: { unit: 'deg' } },
    },
    fetch: async () => [],
  };

  const gpsSpec = (over: Partial<ConnectorSpec> = {}): ConnectorSpec => ({
    id: 'c1',
    adaptorId: 'gps',
    config: { latitude: 0, longitude: 0 },
    inputs: ['latitude', 'longitude'],
    inputFeeds: { latitude: 'device-gps', longitude: 'device-gps' },
    ...over,
  });

  const feed = (
    values: Record<string, number> | null = { latitude: 1, longitude: 2 },
  ) => ({ id: 'device-gps', read: vi.fn(async () => values) });

  it('writes feed values and reopens coverage for a connector missing today', async () => {
    const store = makeStore([gpsSpec()]);
    const h = harvester(store).provide(gpsAdaptor);
    await h.load();
    const f = feed();
    await h.captureInputs([f], AT, THROUGH);

    expect(f.read).toHaveBeenCalledOnce();
    expect(store.writeReadings).toHaveBeenCalledOnce();
    expect(store.writeReadings.mock.calls[0][1][0]).toMatchObject({
      timestamp: AT.toISOString(),
      values: { latitude: 1, longitude: 2 },
    });
    expect(store.reset).toHaveBeenCalledWith(
      'c1',
      AT.toISOString(),
      THROUGH.toISOString(),
    );
  });

  it('skips when the connector already has values at/after `at`', async () => {
    const store = makeStore(
      [gpsSpec()],
      {},
      {
        c1: [
          { reference: 'latitude', timestamp: AT.toISOString(), value: 9 },
          { reference: 'longitude', timestamp: AT.toISOString(), value: 9 },
        ],
      },
    );
    const h = harvester(store).provide(gpsAdaptor);
    await h.load();
    const f = feed();
    await h.captureInputs([f], AT, THROUGH);

    expect(f.read).not.toHaveBeenCalled();
    expect(store.writeReadings).not.toHaveBeenCalled();
    expect(store.reset).not.toHaveBeenCalled();
  });

  it('reads the feed once and writes to every consumer', async () => {
    const store = makeStore([gpsSpec({ id: 'c1' }), gpsSpec({ id: 'c2' })]);
    const h = harvester(store).provide(gpsAdaptor);
    await h.load();
    const f = feed();
    await h.captureInputs([f], AT, THROUGH);

    expect(f.read).toHaveBeenCalledOnce();
    expect(store.writeReadings).toHaveBeenCalledTimes(2);
    expect(store.reset).toHaveBeenCalledTimes(2);
  });

  it('does not write or reset when the feed is unavailable', async () => {
    const store = makeStore([gpsSpec()]);
    const h = harvester(store).provide(gpsAdaptor);
    await h.load();
    await h.captureInputs([feed(null)], AT, THROUGH);

    expect(store.writeReadings).not.toHaveBeenCalled();
    expect(store.reset).not.toHaveBeenCalled();
  });

  it('ignores connectors that do not bind the feed', async () => {
    const store = makeStore([gpsSpec({ inputFeeds: undefined })]);
    const h = harvester(store).provide(gpsAdaptor);
    await h.load();
    const f = feed();
    await h.captureInputs([f], AT, THROUGH);

    expect(f.read).not.toHaveBeenCalled();
    expect(store.writeReadings).not.toHaveBeenCalled();
  });

  it('skips a connector whose inputFeeds map to a different feed id', async () => {
    // connector binds 'other-feed', not 'device-gps' → refs is empty → continue
    const store = makeStore([
      gpsSpec({
        inputFeeds: { latitude: 'other-feed', longitude: 'other-feed' },
      }),
    ]);
    const h = harvester(store).provide(gpsAdaptor);
    await h.load();
    const f = feed();
    await h.captureInputs([f], AT, THROUGH);

    expect(f.read).not.toHaveBeenCalled();
    expect(store.writeReadings).not.toHaveBeenCalled();
  });

  it('treats absent parameterHistory as no prior values and writes the feed', async () => {
    // Store without parameterHistory → covers the ?. null path and ?? [] fallback.
    const store = {
      list: vi.fn(async () => [gpsSpec()]),
      coveredRanges: vi.fn(async () => []),
      commitCoverage: vi.fn(async () => {}),
      writeReadings: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
    } as unknown as ReturnType<typeof makeStore>;
    const h = harvester(store).provide(gpsAdaptor);
    await h.load();
    const f = feed();
    await h.captureInputs([f], AT, THROUGH);

    expect(f.read).toHaveBeenCalledOnce();
    expect(store.writeReadings).toHaveBeenCalledOnce();
  });

  it('skips write when feed values contain none of the expected refs', async () => {
    // Feed returns 'elevation' but connector expects 'latitude'/'longitude' → fields is empty
    const store = makeStore([gpsSpec()]);
    const h = harvester(store).provide(gpsAdaptor);
    await h.load();
    const f = {
      id: 'device-gps',
      read: vi.fn(async () => ({ elevation: 100 })),
    };
    await h.captureInputs([f], AT, THROUGH);

    expect(f.read).toHaveBeenCalledOnce();
    expect(store.writeReadings).not.toHaveBeenCalled();
    expect(store.reset).not.toHaveBeenCalled();
  });
});

describe('Harvester.fetchRange forecast coverage (volatile TTL)', () => {
  const MID = new Date('2024-01-01T12:00:00Z'); // between FROM and TO
  const HOUR = 60 * 60 * 1000;

  const stable = (
    boundary: Date,
    fetchFn?: Adaptor<typeof config.shape>['fetch'],
  ): Adaptor<typeof config.shape> => ({
    ...adaptor(fetchFn),
    stableBefore: () => boundary,
  });

  const fetchSpy = () =>
    vi.fn(async (_cfg: unknown, range: Range) => [
      { timestamp: range.to.toISOString(), values: { value: 1 } },
    ]);

  const coveredFull = (fetchedAt: string): Record<string, Interval[]> => ({
    c1: [
      {
        from: FROM.toISOString(),
        to: TO.toISOString(),
        fetchedAt,
        version: VERSION,
      },
    ],
  });

  it('commits the whole gap (stable head + volatile tail)', async () => {
    const store = makeStore([spec()]);
    const h = harvester(store).provide(stable(MID));
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.commitCoverage).toHaveBeenCalledWith(
      'c1',
      FROM.toISOString(),
      TO.toISOString(),
      VERSION,
    );
  });

  it('with no TTL, re-fetches only the volatile tail each pull', async () => {
    // Coverage is "fresh", but ttl=0 ⇒ the volatile tail always reopens.
    const store = makeStore([spec()], coveredFull(new Date().toISOString()));
    const fetchFn = fetchSpy();
    const h = harvester(store).provide(stable(MID, fetchFn));
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][1]).toEqual({ from: MID, to: TO });
  });

  it('within the TTL, does not re-fetch fresh volatile coverage', async () => {
    const store = makeStore([spec()], coveredFull(new Date().toISOString()));
    const h = harvester(store, { volatileTtlMs: HOUR }).provide(stable(MID));
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).not.toHaveBeenCalled();
  });

  it('after the TTL, reopens the volatile tail (keeps the stable head)', async () => {
    const staleAt = new Date(Date.now() - 5 * HOUR).toISOString();
    const store = makeStore([spec()], coveredFull(staleAt));
    const fetchFn = fetchSpy();
    const h = harvester(store, { volatileTtlMs: HOUR }).provide(
      stable(MID, fetchFn),
    );
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][1]).toEqual({ from: MID, to: TO });
  });

  it('never expires coverage for an adaptor without stableBefore', async () => {
    const staleAt = new Date(Date.now() - 5 * HOUR).toISOString();
    const store = makeStore([spec()], coveredFull(staleAt));
    const h = harvester(store, { volatileTtlMs: HOUR }).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).not.toHaveBeenCalled();
  });
});

describe('Harvester.fetchRange read-schema version (backfill)', () => {
  it('stamps committed coverage with the adaptor read-schema version', async () => {
    const store = makeStore([spec()]);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.commitCoverage).toHaveBeenCalledWith(
      'c1',
      FROM.toISOString(),
      TO.toISOString(),
      VERSION,
    );
  });

  it('re-fetches coverage stamped under a different version', async () => {
    // A field was added since this range was fetched → its version no longer
    // matches, so the range re-fetches to backfill the new field.
    const store = makeStore([spec()], {
      c1: [{ from: FROM.toISOString(), to: TO.toISOString(), version: 'old' }],
    });
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).toHaveBeenCalledOnce();
    expect(store.commitCoverage).toHaveBeenCalledWith(
      'c1',
      FROM.toISOString(),
      TO.toISOString(),
      VERSION,
    );
  });

  it('re-fetches legacy coverage that has no version', async () => {
    const store = makeStore([spec()], {
      c1: [{ from: FROM.toISOString(), to: TO.toISOString() }],
    });
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).toHaveBeenCalledOnce();
  });

  it('re-fetches only the portion not covered under the current version', async () => {
    // The first half was already fetched under the current version; only the
    // uncovered second half re-fetches.
    const MID_S = new Date('2024-01-01T12:00:00Z').toISOString();
    const store = makeStore([spec()], {
      c1: [{ from: FROM.toISOString(), to: MID_S, version: VERSION }],
    });
    const fetchFn = vi.fn(async (_cfg: unknown, range: Range) => [
      { timestamp: range.to.toISOString(), values: { value: 1 } },
    ]);
    const h = harvester(store).provide(adaptor(fetchFn));
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][1]).toEqual({ from: new Date(MID_S), to: TO });
  });

  it('changes the version when the adaptor bumps its readVersion salt', async () => {
    const salted: Adaptor<typeof config.shape> = {
      ...adaptor(),
      readVersion: 'v2',
    };
    const store = makeStore([spec()]);
    const h = harvester(store).provide(salted);
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    const stampedVersion = store.commitCoverage.mock.calls[0][3];
    expect(stampedVersion).not.toBe(VERSION);
    expect(stampedVersion).toBe(readVersion('value|v2'));
  });
});
