import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AdaptorRegistry } from '../src/registry';
import { type Adaptor, type Reading, UnknownAdaptorError } from '../src/types';

const config = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
});

const def = {
  properties: { max: { unit: '%', value: 100 } },
  read: { value: { unit: '%', min: 0, max: 'max' } },
  write: { target: { unit: '%', min: 0, max: 100 } },
};

const components = [
  {
    identifier: 'dev-1',
    measurements: [{ reference: 'value', unit: '%', identifier: 'feed-1' }],
  },
];

const RANGE = {
  from: new Date('2024-01-01T00:00:00Z'),
  to: new Date('2024-01-01T01:00:00Z'),
};

const makeAdaptor = (
  fetchFn: Adaptor<typeof config.shape>['fetch'] = async (_cfg, range) => [
    { timestamp: range.to.toISOString(), values: { value: 42 } },
  ],
  overrides: Partial<Adaptor<typeof config.shape>> = {},
): Adaptor<typeof config.shape> => ({
  id: 'test',
  name: 'Test Adaptor',
  config,
  def,
  fetch: fetchFn,
  send: vi.fn(),
  ...overrides,
});

const configure = (
  reg: AdaptorRegistry,
  adaptor: Adaptor<typeof config.shape>,
  cfg: { host: string; port: number },
  id = adaptor.id,
) =>
  reg.provide(adaptor).configure({
    id,
    adaptorId: adaptor.id,
    config: cfg,
    components,
  });

describe('AdaptorRegistry', () => {
  it('configure throws on invalid config', () => {
    expect(() =>
      configure(new AdaptorRegistry(), makeAdaptor(), {
        host: 'localhost',
        port: 99999,
      }),
    ).toThrow();
  });

  it('configure throws UnknownAdaptorError for an unprovided adaptor', () => {
    const reg = new AdaptorRegistry();
    expect(() =>
      reg.configure({
        id: 'c1',
        adaptorId: 'ghost',
        config: { host: 'h', port: 1 },
        components,
      }),
    ).toThrow(UnknownAdaptorError);
  });

  it('fetch returns SeriesEntry[] from readings', async () => {
    const reg = new AdaptorRegistry();
    configure(reg, makeAdaptor(), { host: 'localhost', port: 502 }, 'c1');
    const entries = await reg.fetch('c1', RANGE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ identifier: 'feed-1', value: 42 });
  });

  it('maps multiple readings to multiple entries', async () => {
    const reg = new AdaptorRegistry();
    const fetchFn = async (): Promise<Reading[]> => [
      { timestamp: '2024-01-01T00:00:00.000Z', values: { value: 1 } },
      { timestamp: '2024-01-01T01:00:00.000Z', values: { value: 2 } },
    ];
    configure(reg, makeAdaptor(fetchFn), { host: 'h', port: 1 }, 'c1');
    const entries = await reg.fetch('c1', RANGE);
    expect(entries.map((e) => e.value)).toEqual([1, 2]);
  });

  it('fetchReadings returns native-unit readings, stripping undeclared keys', async () => {
    const reg = new AdaptorRegistry();
    const fetchFn = async (): Promise<Reading[]> => [
      {
        timestamp: '2024-01-01T00:00:00.000Z',
        values: { value: 30, extra: 99 },
      },
    ];
    configure(reg, makeAdaptor(fetchFn), { host: 'h', port: 1 }, 'c1');
    const readings = await reg.fetchReadings('c1', RANGE);
    expect(readings).toHaveLength(1);
    // `value` is a declared read field (kept); `extra` is undeclared (stripped).
    expect(readings[0]).toEqual({
      timestamp: '2024-01-01T00:00:00.000Z',
      values: { value: 30 },
    });
  });

  it('fetchReadings validates readings against the read schema bounds', async () => {
    const reg = new AdaptorRegistry();
    const fetchFn = async (): Promise<Reading[]> => [
      { timestamp: '2024-01-01T00:00:00.000Z', values: { value: 150 } },
    ];
    configure(reg, makeAdaptor(fetchFn), { host: 'h', port: 1 }, 'c1');
    await expect(reg.fetchReadings('c1', RANGE)).rejects.toThrow();
  });

  it('retries with backoff then succeeds', async () => {
    const fetch = vi
      .fn<Adaptor<typeof config.shape>['fetch']>()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce([
        { timestamp: RANGE.to.toISOString(), values: { value: 7 } },
      ]);
    const onError = vi.fn();
    const reg = new AdaptorRegistry({ retry: { retries: 2, baseDelayMs: 1 } });
    configure(reg, makeAdaptor(fetch), { host: 'h', port: 1 }, 'c1');
    reg.onError(onError);

    const entries = await reg.fetch('c1', RANGE);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(entries[0]).toMatchObject({ value: 7 });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({
      connectorId: 'c1',
      attempt: 1,
      willRetry: true,
    });
  });

  it('throws after exhausting retries, emitting onError per attempt', async () => {
    const onError = vi.fn();
    const reg = new AdaptorRegistry({ retry: { retries: 1, baseDelayMs: 1 } });
    configure(
      reg,
      makeAdaptor(async () => {
        throw new Error('down');
      }),
      { host: 'h', port: 1 },
      'c1',
    );
    reg.onError(onError);

    await expect(reg.fetch('c1', RANGE)).rejects.toThrow('down');
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[1][0]).toMatchObject({
      attempt: 2,
      willRetry: false,
    });
  });

  it('write converts units, validates, and calls send', async () => {
    const adaptor = makeAdaptor();
    const reg = new AdaptorRegistry();
    configure(reg, adaptor, { host: 'localhost', port: 502 }, 'c1');

    await reg.write('c1', [{ reference: 'target', value: 75, unit: '%' }]);

    expect(adaptor.send).toHaveBeenCalledWith(
      { host: 'localhost', port: 502 },
      { target: 75 },
    );
  });

  it('write throws when an input references an unknown write field', async () => {
    const reg = new AdaptorRegistry();
    configure(reg, makeAdaptor(), { host: 'localhost', port: 502 }, 'c1');
    await expect(
      reg.write('c1', [{ reference: 'ghost', value: 1, unit: '%' }]),
    ).rejects.toThrow('no write field "ghost"');
  });

  it('write throws for connectors without send', async () => {
    const adaptor = makeAdaptor(undefined, { send: undefined });
    const reg = new AdaptorRegistry();
    configure(reg, adaptor, { host: 'localhost', port: 502 }, 'c1');
    await expect(
      reg.write('c1', [{ reference: 'target', value: 50, unit: '%' }]),
    ).rejects.toThrow('does not support write');
  });

  it('fetch/write throw for an unknown connector id', async () => {
    const reg = new AdaptorRegistry();
    await expect(reg.fetch('ghost', RANGE)).rejects.toThrow(
      'Unknown connector: ghost',
    );
    await expect(reg.write('ghost', [])).rejects.toThrow(
      'Unknown connector: ghost',
    );
  });

  it('fetch applies a config override, re-validating the resolved config', async () => {
    const geoConfig = z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    });
    const geo: Adaptor<typeof geoConfig.shape> = {
      id: 'geo',
      name: 'Geo',
      config: geoConfig,
      def: {
        properties: {},
        read: { lat: { unit: 'deg' } },
        write: {},
        inputs: { latitude: { unit: 'deg' }, longitude: { unit: 'deg' } },
      },
      fetch: async (cfg, range) => [
        {
          timestamp: range.from.toISOString(),
          values: { lat: (cfg as { latitude: number }).latitude },
        },
      ],
    };
    const reg = new AdaptorRegistry().provide(geo);
    // Bootstrap omits the (dynamic) coordinates → allowed because they're inputs.
    reg.configure({
      id: 'c1',
      adaptorId: 'geo',
      config: {},
      components: [
        {
          identifier: 'c1',
          measurements: [{ reference: 'lat', unit: 'deg', identifier: 'f' }],
        },
      ],
      inputs: ['latitude', 'longitude'],
    });

    const entries = await reg.fetch('c1', RANGE, {
      latitude: 42,
      longitude: -71,
    });
    expect(entries[0]).toMatchObject({ identifier: 'f', value: 42 });

    // An out-of-range override fails the per-fetch config.parse.
    await expect(
      reg.fetch('c1', RANGE, { latitude: 999, longitude: 0 }),
    ).rejects.toThrow();
  });

  it('adaptorDef() returns the def for a provided type, null for unknown', () => {
    const reg = new AdaptorRegistry().provide(makeAdaptor());
    expect(reg.adaptorDef('test')).toEqual(def);
    expect(reg.adaptorDef('ghost')).toBeNull();
  });

  it('catalog() lists all provided adaptor types with id/name/def', () => {
    const reg = new AdaptorRegistry().provide(makeAdaptor());
    const catalog = reg.catalog();
    expect(catalog).toEqual([
      { id: 'test', name: 'Test Adaptor', def: makeAdaptor().def },
    ]);
  });

  it('supports multiple connectors of one adaptor type', () => {
    const reg = new AdaptorRegistry().provide(makeAdaptor());
    reg
      .configure({
        id: 'home',
        adaptorId: 'test',
        config: { host: 'a', port: 1 },
        components,
      })
      .configure({
        id: 'work',
        adaptorId: 'test',
        config: { host: 'b', port: 2 },
        components,
      });
    expect(reg.has('home')).toBe(true);
    expect(reg.has('work')).toBe(true);
    expect(reg.connectorIds()).toEqual(['home', 'work']);
  });
});
