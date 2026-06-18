import {
  AdaptorScheduler,
  type Component,
  openMeteoAdaptor,
} from '../src/index.js';

const scheduler = new AdaptorScheduler();

// One weather station in Berlin. Each measurement maps an Open-Meteo read
// field to an output series, converting into the unit we want via @inntend/convert:
//   temperature  C    -> F     (Celsius to Fahrenheit)
//   wind speed   km/h -> m/s
//   the rest stay in their native unit.
const components: Component[] = [
  {
    identifier: 'berlin',
    measurements: [
      { reference: 'temperature_2m', unit: 'F', identifier: 'weather.temp_f' },
      {
        reference: 'relative_humidity_2m',
        unit: '%',
        identifier: 'weather.humidity',
      },
      { reference: 'wind_speed_10m', unit: 'm/s', identifier: 'weather.wind' },
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
