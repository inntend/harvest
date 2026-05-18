import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AdaptorScheduler } from '../src/scheduler.js';
import type { Adaptor } from '../src/types.js';

const config = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
});
const read = z.object({ value: z.number().min(0).max(100) });
const write = z.object({ target: z.number().min(0).max(100) });

const makeAdaptor = (
  fetchFn: () => Promise<{ value?: number }> = async () => ({ value: 42 }),
): Adaptor<typeof config.shape, typeof read.shape, typeof write.shape> => ({
  id: 'test',
  name: 'Test Adaptor',
  schedule: '* * * * *',
  config,
  read,
  write,
  fetch: fetchFn,
  send: vi.fn(),
});

describe('AdaptorScheduler', () => {
  it('register throws on invalid config', () => {
    const scheduler = new AdaptorScheduler();
    // port out of range
    expect(() =>
      scheduler.register(makeAdaptor(), { host: 'localhost', port: 99999 }),
    ).toThrow();
  });

  it('run fetches, validates, and emits a DataEvent', async () => {
    const handler = vi.fn();
    const scheduler = new AdaptorScheduler();
    scheduler
      .register(makeAdaptor(), { host: 'localhost', port: 502 })
      .onData(handler);

    await scheduler.run('test');

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    expect(event.adaptorId).toBe('test');
    expect(event.data).toEqual({ value: 42 });
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
        {
          host: 'localhost',
          port: 502,
        },
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
    scheduler.register(adaptor, { host: 'localhost', port: 502 });

    await scheduler.write('test', { target: 75 });

    expect(adaptor.send).toHaveBeenCalledWith(
      { host: 'localhost', port: 502 },
      { target: 75 },
    );
  });

  it('write throws for adaptors without send', async () => {
    const adaptor = { ...makeAdaptor(), send: undefined };
    const scheduler = new AdaptorScheduler();
    scheduler.register(adaptor, { host: 'localhost', port: 502 });

    await expect(scheduler.write('test', { target: 50 })).rejects.toThrow(
      'does not support write',
    );
  });
});
