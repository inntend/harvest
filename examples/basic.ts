import { AdaptorScheduler, demoAdaptor } from '../src/index.js';

const scheduler = new AdaptorScheduler();

scheduler
  .register(demoAdaptor, {
    capacityKwh: 100,
    maxChargePower: 50,
    maxDischargePower: 50,
  })
  .onData((event) => {
    console.log(
      `[${event.timestamp.toISOString()}] ${event.adaptorId}`,
      event.data,
    );
  })
  .start();

// Send a write command after 5 seconds
setTimeout(async () => {
  await scheduler.write('demo', { targetSoc: 80, chargingEnabled: true });
}, 5_000);

// Stop after 35 seconds
setTimeout(() => {
  scheduler.stop();
  console.log('Done.');
}, 35_000);
