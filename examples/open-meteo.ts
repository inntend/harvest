import { AdaptorScheduler, openMeteoAdaptor } from '../src/index.js';

const scheduler = new AdaptorScheduler();

scheduler
  .register(openMeteoAdaptor, {
    latitude: 52.52,
    longitude: 13.41,
    timezone: 'Europe/Berlin',
  })
  .onData((event) => {
    console.log(
      `[${event.timestamp.toISOString()}] ${event.adaptorId}`,
      event.data,
    );
  })
  .start();

// Stop after 5 seconds (for demo purposes)
setTimeout(() => {
  scheduler.stop();
  console.log('Done.');
}, 5_000);
