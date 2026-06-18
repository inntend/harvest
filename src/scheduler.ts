import { Cron } from 'croner';
import type { z } from 'zod';
import type { Component } from './definition';
import { Schema } from './schema';
import { Transform } from './transform';
import type { Adaptor, AnyAdaptor, DataEvent } from './types';

type Shape = Record<string, z.ZodTypeAny>;
type DataHandler = (event: DataEvent) => void | Promise<void>;

type Entry = {
  adaptor: AnyAdaptor;
  config: any; // validated at registration via adaptor.config.parse()
  transform: Transform;
  job?: Cron;
};

export class AdaptorScheduler {
  readonly #registry = new Map<string, Entry>();
  readonly #handlers: DataHandler[] = [];

  register<C extends Shape>(
    adaptor: Adaptor<C>,
    config: z.input<z.ZodObject<C>>,
    components: Component[],
  ): this {
    const parsed = adaptor.config.parse(config);
    const transform = new Transform(adaptor.def);
    transform.setup(components);
    this.#registry.set(adaptor.id, { adaptor, config: parsed, transform });
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

    const { adaptor, config, transform } = entry;
    try {
      const raw = await adaptor.fetch(config);
      const now = new Date();
      const data = await transform.measurements({ [now.toISOString()]: raw });
      const event: DataEvent = { adaptorId, timestamp: now, data };
      await Promise.all(this.#handlers.map((h) => h(event)));
    } catch (err) {
      console.error(`[harvest] Adaptor "${adaptorId}" error:`, err);
    }
  }

  async write(
    adaptorId: string,
    values: Record<string, number>,
  ): Promise<void> {
    const entry = this.#registry.get(adaptorId);
    if (!entry) throw new Error(`Unknown adaptor: ${adaptorId}`);
    if (!entry.adaptor.send)
      throw new Error(`Adaptor "${adaptorId}" does not support write`);

    const schema = new Schema(entry.adaptor.def);
    schema.setup();
    const parsed = schema.write.partial().parse(values);
    await entry.adaptor.send(entry.config, parsed as Record<string, number>);
  }
}
