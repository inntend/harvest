import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AdaptorScheduler } from '../src/scheduler';
import { type Adaptor, UnknownAdaptorError } from '../src/types';

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
    measurements: [{ reference: 'value', unit: '%', identifier: 'series-1' }],
  },
];

const makeAdaptor = (
  fetchFn: () => Promise<Record<string, number>> = async () => ({ value: 42 }),
  overrides: Partial<Adaptor<typeof config.shape>> = {},
): Adaptor<typeof config.shape> => ({
  id: 'test',
  name: 'Test Adaptor',
  schedule: '* * * * *',
  config,
  def,
  fetch: fetchFn,
  send: vi.fn(),
  ...overrides,
});

const configure = (
  scheduler: AdaptorScheduler,
  adaptor: Adaptor<typeof config.shape>,
  cfg: { host: string; port: number },
  id = adaptor.id,
) =>
  scheduler.provide(adaptor).configure({
    id,
    adaptorId: adaptor.id,
    config: cfg,
    components,
  });

describe('AdaptorScheduler', () => {
  it('configure throws on invalid config', () => {
    const scheduler = new AdaptorScheduler();
    expect(() =>
      configure(scheduler, makeAdaptor(), { host: 'localhost', port: 99999 }),
    ).toThrow();
  });

  it('configure throws UnknownAdaptorError for an unprovided adaptor', () => {
    const scheduler = new AdaptorScheduler();
    expect(() =>
      scheduler.configure({
        id: 'c1',
        adaptorId: 'ghost',
        config: { host: 'localhost', port: 502 },
        components,
      }),
    ).toThrow(UnknownAdaptorError);
  });

  it('run fetches, validates, and emits a DataEvent with SeriesEntry[]', async () => {
    const handler = vi.fn();
    const scheduler = new AdaptorScheduler();
    configure(scheduler, makeAdaptor(), { host: 'localhost', port: 502 }, 'c1');
    scheduler.onData(handler);

    await scheduler.run('c1');

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    expect(event.connectorId).toBe('c1');
    expect(event.adaptorId).toBe('test');
    expect(event.data).toHaveLength(1);
    expect(event.data[0]).toMatchObject({ identifier: 'series-1', value: 42 });
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('supports multiple connectors of the same adaptor type', async () => {
    const handler = vi.fn();
    const scheduler = new AdaptorScheduler().provide(makeAdaptor());
    scheduler
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
      })
      .onData(handler);

    await scheduler.run('home');
    await scheduler.run('work');

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map((c) => c[0].connectorId)).toEqual([
      'home',
      'work',
    ]);
  });

  it('uses the per-connector schedule override', () => {
    const scheduler = new AdaptorScheduler().provide(makeAdaptor());
    scheduler.configure({
      id: 'c1',
      adaptorId: 'test',
      schedule: '0 0 * * *',
      config: { host: 'localhost', port: 502 },
      components,
    });
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it('retries with backoff then succeeds, emitting one DataEvent', async () => {
    const fetch = vi
      .fn<() => Promise<Record<string, number>>>()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce({ value: 7 });
    const onData = vi.fn();
    const onError = vi.fn();
    const scheduler = new AdaptorScheduler({
      retry: { retries: 2, baseDelayMs: 1 },
    });
    configure(scheduler, makeAdaptor(fetch), { host: 'h', port: 1 }, 'c1');
    scheduler.onData(onData).onError(onError);

    await scheduler.run('c1');

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenCalledOnce();
    expect(onData.mock.calls[0][0].data[0]).toMatchObject({ value: 7 });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({
      connectorId: 'c1',
      attempt: 1,
      willRetry: true,
    });
  });

  it('run does not crash when retries are exhausted', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const onData = vi.fn();
    const onError = vi.fn();
    const scheduler = new AdaptorScheduler({
      retry: { retries: 1, baseDelayMs: 1 },
    });
    configure(
      scheduler,
      makeAdaptor(async () => {
        throw new Error('network down');
      }),
      { host: 'h', port: 1 },
      'c1',
    );
    scheduler.onData(onData).onError(onError);

    await expect(scheduler.run('c1')).resolves.toBeUndefined();
    expect(onData).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2); // attempt 1 (willRetry) + attempt 2 (final)
    expect(onError.mock.calls[1][0]).toMatchObject({
      attempt: 2,
      willRetry: false,
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('write validates values and calls send', async () => {
    const adaptor = makeAdaptor();
    const scheduler = new AdaptorScheduler();
    configure(scheduler, adaptor, { host: 'localhost', port: 502 }, 'c1');

    await scheduler.write('c1', { target: 75 });

    expect(adaptor.send).toHaveBeenCalledWith(
      { host: 'localhost', port: 502 },
      { target: 75 },
    );
  });

  it('write throws for connectors without send', async () => {
    const adaptor = makeAdaptor(undefined, { send: undefined });
    const scheduler = new AdaptorScheduler();
    configure(scheduler, adaptor, { host: 'localhost', port: 502 }, 'c1');

    await expect(scheduler.write('c1', { target: 50 })).rejects.toThrow(
      'does not support write',
    );
  });

  it('run/write throw for an unknown connector id', async () => {
    const scheduler = new AdaptorScheduler();
    await expect(scheduler.run('ghost')).rejects.toThrow(
      'Unknown connector: ghost',
    );
    await expect(scheduler.write('ghost', {})).rejects.toThrow(
      'Unknown connector: ghost',
    );
  });

  it('reset clears connectors but keeps the catalog', () => {
    const scheduler = new AdaptorScheduler();
    configure(scheduler, makeAdaptor(), { host: 'h', port: 1 }, 'c1');
    expect(scheduler.has('c1')).toBe(true);

    scheduler.reset();
    expect(scheduler.has('c1')).toBe(false);

    // catalog retained — can reconfigure without re-providing
    scheduler.configure({
      id: 'c2',
      adaptorId: 'test',
      config: { host: 'h', port: 1 },
      components,
    });
    expect(scheduler.has('c2')).toBe(true);
  });
});
