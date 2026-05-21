import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AdaptorScheduler } from '../src/scheduler';
import type { Adaptor } from '../src/types';

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
): Adaptor<typeof config.shape> => ({
  id: 'test',
  name: 'Test Adaptor',
  schedule: '* * * * *',
  config,
  def,
  fetch: fetchFn,
  send: vi.fn(),
});

describe('AdaptorScheduler', () => {
  it('register throws on invalid config', () => {
    const scheduler = new AdaptorScheduler();
    expect(() =>
      scheduler.register(
        makeAdaptor(),
        { host: 'localhost', port: 99999 },
        components,
      ),
    ).toThrow();
  });

  it('run fetches, validates, and emits a DataEvent with SeriesEntry[]', async () => {
    const handler = vi.fn();
    const scheduler = new AdaptorScheduler();
    scheduler
      .register(makeAdaptor(), { host: 'localhost', port: 502 }, components)
      .onData(handler);

    await scheduler.run('test');

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    expect(event.adaptorId).toBe('test');
    expect(event.data).toHaveLength(1);
    expect(event.data[0]).toMatchObject({ identifier: 'series-1', value: 42 });
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('run catches fetch errors without crashing', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const handler = vi.fn();
    const scheduler = new AdaptorScheduler();
    scheduler
      .register(
        makeAdaptor(async () => {
          throw new Error('network down');
        }),
        { host: 'localhost', port: 502 },
        components,
      )
      .onData(handler);

    await expect(scheduler.run('test')).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('write validates values and calls send', async () => {
    const adaptor = makeAdaptor();
    const scheduler = new AdaptorScheduler();
    scheduler.register(adaptor, { host: 'localhost', port: 502 }, components);

    await scheduler.write('test', { target: 75 });

    expect(adaptor.send).toHaveBeenCalledWith(
      { host: 'localhost', port: 502 },
      { target: 75 },
    );
  });

  it('write throws for adaptors without send', async () => {
    const adaptor = { ...makeAdaptor(), send: undefined };
    const scheduler = new AdaptorScheduler();
    scheduler.register(adaptor, { host: 'localhost', port: 502 }, components);

    await expect(scheduler.write('test', { target: 50 })).rejects.toThrow(
      'does not support write',
    );
  });

  it('run throws for an unregistered adaptor id', async () => {
    const scheduler = new AdaptorScheduler();
    await expect(scheduler.run('ghost')).rejects.toThrow(
      'Unknown adaptor: ghost',
    );
  });

  it('write throws for an unregistered adaptor id', async () => {
    const scheduler = new AdaptorScheduler();
    await expect(scheduler.write('ghost', {})).rejects.toThrow(
      'Unknown adaptor: ghost',
    );
  });

  it('start returns this for chaining and creates jobs', () => {
    const scheduler = new AdaptorScheduler();
    scheduler.register(
      makeAdaptor(),
      { host: 'localhost', port: 502 },
      components,
    );

    const result = scheduler.start();
    expect(result).toBe(scheduler);

    scheduler.stop(); // clean up
  });

  it('stop is safe before start and halts jobs after start', () => {
    const scheduler = new AdaptorScheduler();
    scheduler.register(
      makeAdaptor(),
      { host: 'localhost', port: 502 },
      components,
    );

    // stop before start — entry.job is undefined, optional chaining is a no-op
    expect(() => scheduler.stop()).not.toThrow();

    // start then stop
    scheduler.start();
    expect(() => scheduler.stop()).not.toThrow();
  });
});
