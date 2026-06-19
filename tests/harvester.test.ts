import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SeriesEntry } from '../src/definition';
import {
  type ConnectorSpec,
  type ConnectorStore,
  Harvester,
  type Interval,
  subtractIntervals,
} from '../src/harvester';
import type { Adaptor } from '../src/types';

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
    writeSeries: vi.fn(async (_id: string, _entries: SeriesEntry[]) => {}),
    reset: vi.fn(async () => {}),
  };
}

const harvester = (store: ReturnType<typeof makeStore>) =>
  new Harvester({
    store: store as unknown as ConnectorStore,
    deviceId: 'd1',
    retry: { retries: 0 },
  });

describe('Harvester.fetchRange', () => {
  it('fetches an uncovered range, writes series, commits coverage', async () => {
    const store = makeStore([spec()]);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);

    expect(store.writeSeries).toHaveBeenCalledOnce();
    expect(store.writeSeries.mock.calls[0][1][0]).toMatchObject({
      identifier: 'feed-1',
      value: 42,
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
    expect(store.writeSeries).not.toHaveBeenCalled();
  });

  it('skips a gap claimed by another device', async () => {
    const store = makeStore([spec()]);
    store.claim = vi.fn(async () => false);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeSeries).not.toHaveBeenCalled();
  });

  it('does not configure disabled connectors', async () => {
    const store = makeStore([spec({ enabled: false })]);
    const h = harvester(store).provide(adaptor());
    await h.load();
    await h.fetchRange('c1', FROM, TO);
    expect(store.writeSeries).not.toHaveBeenCalled();
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
    expect(store.writeSeries).toHaveBeenCalledOnce();
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
    expect(store.writeSeries).toHaveBeenCalledOnce();
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
