import {
  AdaptorScheduler,
  type Component,
  openMeteoAdaptor,
} from '../src/index.js';

const scheduler = new AdaptorScheduler();

// One weather station in Berlin. Each measurement maps an Open-Meteo read
// field to an output series. We keep everything in its native metric unit;
// downstream projects convert on read via @inntend/convert as needed.
const components: Component[] = [
  {
    identifier: 'berlin',
    measurements: [
      { reference: 'temperature_2m', unit: 'C', identifier: 'weather.temp' },
      {
        reference: 'relative_humidity_2m',
        unit: '%',
        identifier: 'weather.humidity',
      },
      { reference: 'wind_speed_10m', unit: 'km/h', identifier: 'weather.wind' },
      {
        reference: 'wind_direction_10m',
        unit: 'deg',
        identifier: 'weather.wind_dir',
      },
      { reference: 'cloud_cover', unit: '%', identifier: 'weather.cloud' },
      {
        reference: 'surface_pressure',
        unit: 'hPa',
        identifier: 'weather.pressure',
      },
      {
        reference: 'shortwave_radiation',
        unit: 'W/m2',
        identifier: 'weather.radiation',
      },
    ],
  },
];

scheduler
  .register(
    openMeteoAdaptor,
    {
      latitude: 52.52,
      longitude: 13.41,
      timezone: 'Europe/Berlin',
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

// Open-Meteo's schedule is hourly, so trigger one run now for the demo.
await scheduler.run('open-meteo');

// Stop after 5 seconds.
setTimeout(() => {
  scheduler.stop();
  console.log('Done.');
}, 5_000);
