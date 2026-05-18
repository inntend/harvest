import { Cron } from 'croner';
import type { z } from 'zod';
import type { Adaptor, AnyAdaptor, DataEvent } from './types.js';

type Shape = Record<string, z.ZodTypeAny>;
type DataHandler = (event: DataEvent) => void | Promise<void>;

type Entry = {
  adaptor: AnyAdaptor;
  config: any;
  job?: Cron;
};

export class AdaptorScheduler {
  readonly #registry = new Map<string, Entry>();
  readonly #handlers: DataHandler[] = [];

  register<C extends Shape, R extends Shape, W extends Shape>(
    adaptor: Adaptor<C, R, W>,
    config: z.infer<z.ZodObject<C>>,
  ): this {
    const parsed = adaptor.config.parse(config);
    this.#registry.set(adaptor.id, { adaptor, config: parsed });
    return this;
  }

  onData(handler: DataHandler): this {
    this.#handlers.push(handler);
    return this;
  }

  start(): this {
    for (const [id, entry] of this.#registry) {
      entry.job = new Cron(entry.adaptor.schedule, () => this.run(id));
    }
    return this;
  }

  stop(): void {
    for (const entry of this.#registry.values()) {
      entry.job?.stop();
      entry.job = undefined;
    }
  }

  async run(adaptorId: string): Promise<void> {
    const entry = this.#registry.get(adaptorId);
    if (!entry) throw new Error(`Unknown adaptor: ${adaptorId}`);

    const { adaptor, config } = entry;
    try {
      const raw = await adaptor.fetch(config);
      const data = adaptor.read.partial().parse(raw);
      const event: DataEvent = { adaptorId, timestamp: new Date(), data };
      await Promise.all(this.#handlers.map((h) => h(event)));
    } catch (err) {
      console.error(`[harvest] Adaptor "${adaptorId}" error:`, err);
    }
  }

  async write(adaptorId: string, values: unknown): Promise<void> {
    const entry = this.#registry.get(adaptorId);
    if (!entry) throw new Error(`Unknown adaptor: ${adaptorId}`);
    if (!entry.adaptor.send)
      throw new Error(`Adaptor "${adaptorId}" does not support write`);

    const parsed = entry.adaptor.write.partial().parse(values);
    await entry.adaptor.send(entry.config, parsed);
  }
}
