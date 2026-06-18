import { AdaptorScheduler, type Component, demoAdaptor } from '../src/index.js';

const scheduler = new AdaptorScheduler();

// One physical battery, mapping each read field to an output series identifier.
const components: Component[] = [
  {
    identifier: 'battery-1',
    measurements: [
      { reference: 'soc', unit: '%', identifier: 'battery.soc' },
      { reference: 'chargePower', unit: 'kW', identifier: 'battery.charge' },
      {
        reference: 'dischargePower',
        unit: 'kW',
        identifier: 'battery.discharge',
      },
      { reference: 'voltage', unit: 'V', identifier: 'battery.voltage' },
    ],
  },
];

scheduler
  .register(
    demoAdaptor,
    {
      'charging.max': 50_000, // W
      'discharging.max': 50_000, // W
      capacity: 100_000, // Wh
    },
    components,
  )
  .onData((event) => {
    console.log(
      `[${event.timestamp.toISOString()}] ${event.adaptorId}`,
      event.data,
    );
  })
  .start();

// Send a write command after 5 seconds
setTimeout(async () => {
  await scheduler.write('demo', { targetSoc: 80, chargingMode: 1 });
}, 5_000);

// Stop after 35 seconds
setTimeout(() => {
  scheduler.stop();
  console.log('Done.');
}, 35_000);
