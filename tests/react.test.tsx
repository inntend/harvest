// @vitest-environment happy-dom
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ConnectorSpec, ConnectorStore, Interval } from '../src/harvester';
import { HarvesterProvider, useDemandPull, useHarvester } from '../src/react';
import type { Adaptor } from '../src/types';

const config = z.object({ host: z.string() });

const adaptor = (send = vi.fn()): Adaptor<typeof config.shape> => ({
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
    writeSeries: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
  };
}

type Store = ReturnType<typeof makeStore>;

const wrapper =
  (store: Store, props: Record<string, unknown> = {}) =>
  ({ children }: { children: ReactNode }) =>
    createElement(HarvesterProvider, {
      store: store as ConnectorStore,
      deviceId: 'd1',
      includeBuiltins: false,
      adaptors: [adaptor()],
      ...props,
      children,
    });

afterEach(() => vi.restoreAllMocks());

describe('useHarvester', () => {
  it('throws when used outside a provider', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useHarvester())).toThrow(
      'HarvesterContext not initialized',
    );
    err.mockRestore();
  });
});

describe('HarvesterProvider', () => {
  it('loads connectors and exposes ready + connectorIds', async () => {
    const store = makeStore([spec(), spec({ id: 'c2' })]);
    const { result } = renderHook(() => useHarvester(), {
      wrapper: wrapper(store),
    });

    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.connectorIds).toEqual(['c1', 'c2']);
  });

  it('fetchRange fills gaps, write pushes back, reload re-reads config', async () => {
    const send = vi.fn();
    const store = makeStore([spec()]);
    const wrap = wrapper(store, { adaptors: [adaptor(send)] });
    const { result } = renderHook(() => useHarvester(), { wrapper: wrap });
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.fetchRange('c1', FROM, TO);
    });
    expect(store.writeSeries).toHaveBeenCalledOnce();
    expect(store.commitCoverage).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.write('c1', [
        { reference: 'target', value: 75, unit: '%' },
      ]);
    });
    expect(send).toHaveBeenCalledWith({ host: 'h' }, { target: 75 });

    store.list.mockResolvedValueOnce([spec(), spec({ id: 'c2' })]);
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.connectorIds).toEqual(['c1', 'c2']);
  });

  it('records the last error per connector in health', async () => {
    const store = makeStore([spec({ id: 'ghost', adaptorId: 'missing' })]);
    const { result } = renderHook(() => useHarvester(), {
      wrapper: wrapper(store, { adaptors: [] }),
    });

    await waitFor(() => expect(result.current.health.ghost).toBeDefined());
    expect(result.current.health.ghost).toMatchObject({
      connectorId: 'ghost',
      adaptorId: 'missing',
    });
    expect(result.current.ready).toBe(true);
  });

  it('does not load while disabled, and the callbacks no-op', async () => {
    const store = makeStore([spec()]);
    const { result } = renderHook(() => useHarvester(), {
      wrapper: wrapper(store, { enabled: false }),
    });

    // Effect bailed out: nothing loaded, no harvester behind the callbacks.
    expect(store.list).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    await act(async () => {
      await result.current.fetchRange('c1', FROM, TO);
      await result.current.write('c1', []);
      await result.current.reload();
    });
    expect(store.writeSeries).not.toHaveBeenCalled();
    // Catalog lookups fall back gracefully with no harvester behind them.
    expect(result.current.adaptorDef('test')).toBeNull();
    expect(result.current.listAdaptors()).toEqual([]);
  });

  it('defaults to including built-in adaptors', async () => {
    // includeBuiltins/adaptors left at their defaults; an empty store means no
    // connector fetches fire, so the built-ins load without any network call.
    const store = makeStore([]);
    const { result } = renderHook(() => useHarvester(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(HarvesterProvider, {
          store: store as unknown as ConnectorStore,
          deviceId: 'd1',
          children,
        }),
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.connectorIds).toEqual([]);
  });

  it('ignores a load that resolves after unmount', async () => {
    const store = makeStore([spec()]);
    let resolveList!: (s: ConnectorSpec[]) => void;
    store.list.mockReturnValueOnce(
      new Promise((r) => {
        resolveList = r;
      }),
    );
    const { result, unmount } = renderHook(() => useHarvester(), {
      wrapper: wrapper(store),
    });

    unmount(); // cleanup sets active=false before the list resolves
    await act(async () => {
      resolveList([spec()]);
      await Promise.resolve();
    });
    // No state update leaked through after unmount.
    expect(result.current.ready).toBe(false);
  });

  it('refetch resets then refills the range', async () => {
    const store = makeStore([spec()]);
    const { result } = renderHook(() => useHarvester(), {
      wrapper: wrapper(store),
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.refetch('c1', FROM, TO);
    });
    expect(store.reset).toHaveBeenCalledWith(
      'c1',
      FROM.toISOString(),
      TO.toISOString(),
    );
    expect(store.writeSeries).toHaveBeenCalledOnce();
  });

  it('reflects pending while a connector is actively fetching a gap', async () => {
    let resolveFetch!: (
      v: { timestamp: string; values: { value: number } }[],
    ) => void;
    const gate = new Promise<
      { timestamp: string; values: { value: number } }[]
    >((res) => {
      resolveFetch = res;
    });
    const slow: Adaptor<typeof config.shape> = {
      ...adaptor(),
      fetch: () => gate,
    };
    const store = makeStore([spec()]);
    const { result } = renderHook(() => useHarvester(), {
      wrapper: wrapper(store, { adaptors: [slow] }),
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    let done!: Promise<void>;
    act(() => {
      done = result.current.fetchRange('c1', FROM, TO);
    });
    await waitFor(() => expect(result.current.pending.c1).toBe(true));

    await act(async () => {
      resolveFetch([{ timestamp: TO.toISOString(), values: { value: 42 } }]);
      await done;
    });
    expect(result.current.pending.c1).toBeUndefined();
  });

  it('adaptorDef and listAdaptors expose the registered catalog', async () => {
    const store = makeStore([spec()]);
    const { result } = renderHook(() => useHarvester(), {
      wrapper: wrapper(store),
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.adaptorDef('test')).toEqual(adaptor().def);
    expect(result.current.adaptorDef('ghost')).toBeNull();
    expect(result.current.listAdaptors()).toEqual([
      { id: 'test', name: 'Test', def: adaptor().def },
    ]);
  });
});

describe('useDemandPull', () => {
  it('fetches every connector once ready, and not before', async () => {
    const store = makeStore([spec(), spec({ id: 'c2' })]);
    const { unmount } = render(
      createElement(wrapper(store), {
        children: createElement(function Demand() {
          useDemandPull({ from: FROM, to: TO });
          return null;
        }),
      }),
    );

    // One claim per connector for the requested range, after ready flips true.
    await waitFor(() => expect(store.claim).toHaveBeenCalledTimes(2));
    const ids = store.claim.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(['c1', 'c2']);

    unmount(); // runs the effect cleanup (active = false)
  });

  it('stops iterating connectors when unmounted mid-pull', async () => {
    const store = makeStore([spec(), spec({ id: 'c2' })]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    store.coveredRanges.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await gate; // hold the first connector's fetch open
      return [];
    });

    const { unmount } = render(
      createElement(wrapper(store), {
        children: createElement(function Demand() {
          useDemandPull({ from: FROM, to: TO });
          return null;
        }),
      }),
    );

    // First connector's fetch is in flight; tear down before it resolves.
    await waitFor(() => expect(store.coveredRanges).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      release();
      await Promise.resolve();
    });

    // The loop resumes, sees active === false, and never reaches c2.
    expect(store.coveredRanges).toHaveBeenCalledTimes(1);
  });
});
