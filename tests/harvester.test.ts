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
import type { Adaptor, Reading } from '../src/types';

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
  components: [
    {
      identifier: 'c1',
      measurements: [{ reference: 'value', unit: '%', identifier: 'feed-1' }],
    },
  ],
  ...over,
});

const FROM = new Date('2024-01-01T00:00:00Z');
const TO = new Date('2024-01-02T00:00:00Z');

function makeStore(
  specs: ConnectorSpec[],
  covered: Record<string, Interval[]> = {},
  history: Record<string, ParameterPoint[]> = {},
) {
  const claimed = new Set<string>();
  return {
    list: vi.fn(async () => specs),
    coveredRanges: vi.fn(async (id: string) => covered[id] ?? []),
    claim: vi.fn(async (id: string, from: string, to: string) => {
      const key = `${id}|${from}|${to}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
    commitCoverage: vi.fn(async () => {}),
    writeReadings: vi.fn(async (_id: string, _readings: Reading[]) => {}),
    reset: vi.fn(async () => {}),
    parameterHistory: vi.fn(async (id: string) => history[id] ?? []),
  };
}

const harvester = (store: ReturnType<typeof makeStore>) =>
  new Harvester({
    store: store as unknown as ConnectorStore,
    deviceId: 'd1',
    retry: { retries: 0 },
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
      c1: [{ from: FROM.toISOString(), to: TO.toISOString() }],
    });
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).not.toHaveBeenCalled();
  });

  it('skips a gap claimed by another device', async () => {
    const store = makeStore([spec()]);
    store.claim = vi.fn(async () => false);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeReadings).not.toHaveBeenCalled();
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
      deviceId: 'd1',
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
      c1: [{ from: FROM.toISOString(), to: TO.toISOString() }],
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
    components: [
      {
        identifier: 'gps',
        measurements: [
          { reference: 'lat', unit: 'deg', identifier: 'feed-lat' },
          { reference: 'lng', unit: 'deg', identifier: 'feed-lng' },
        ],
      },
    ],
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
