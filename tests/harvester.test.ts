import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type ConnectorSpec, Harvester } from '../src/harvester';
import type { Adaptor } from '../src/types';

const config = z.object({ host: z.string() });

const adaptor = (
  fetchFn: () => Promise<Record<string, number>> = async () => ({ value: 42 }),
): Adaptor<typeof config.shape> => ({
  id: 'test',
  name: 'Test',
  schedule: '* * * * *',
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
  schedule: '* * * * *',
  config: { host: 'h' },
  components: [
    {
      identifier: 'c1',
      measurements: [{ reference: 'value', unit: '%', identifier: 'feed-1' }],
    },
  ],
  ...over,
});

describe('Harvester', () => {
  it('loads connectors and writes fetched series through the store port', async () => {
    const writeSeries = vi.fn().mockResolvedValue(undefined);
    const store = { list: async () => [spec()], writeSeries };
    const h = new Harvester({ store, retry: { retries: 0 } }).provide(
      adaptor(),
    );

    await h.start();
    await h.run('c1');
    h.stop();

    expect(writeSeries).toHaveBeenCalledOnce();
    const [connectorId, entries] = writeSeries.mock.calls[0];
    expect(connectorId).toBe('c1');
    expect(entries[0]).toMatchObject({ identifier: 'feed-1', value: 42 });
  });

  it('does not schedule disabled connectors', async () => {
    const writeSeries = vi.fn().mockResolvedValue(undefined);
    const store = {
      list: async () => [spec({ enabled: false })],
      writeSeries,
    };
    const h = new Harvester({ store, retry: { retries: 0 } }).provide(
      adaptor(),
    );

    await h.start();
    await expect(h.run('c1')).rejects.toThrow('Unknown connector');
    h.stop();
    expect(writeSeries).not.toHaveBeenCalled();
  });

  it('skips connectors whose adaptor was not provided and reports onError', async () => {
    const onError = vi.fn();
    const store = {
      list: async () => [spec({ id: 'custom', adaptorId: 'not-supplied' })],
      writeSeries: vi.fn(),
    };
    const h = new Harvester({ store, retry: { retries: 0 } });
    h.onError(onError);

    await h.start();
    h.stop();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({
      connectorId: 'custom',
      adaptorId: 'not-supplied',
    });
  });

  it('reload re-reads configuration and applies enable toggles', async () => {
    let enabled = false;
    const store = {
      list: async () => [spec({ enabled })],
      writeSeries: vi.fn().mockResolvedValue(undefined),
    };
    const h = new Harvester({ store, retry: { retries: 0 } }).provide(
      adaptor(),
    );

    await h.start();
    await expect(h.run('c1')).rejects.toThrow('Unknown connector');

    enabled = true;
    await h.reload();
    await h.run('c1');
    h.stop();

    expect(store.writeSeries).toHaveBeenCalledOnce();
  });
});
