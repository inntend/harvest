import {
  type ConnectorStore,
  Harvester,
  openMeteoAdaptor,
} from '../src/index.js';

// One weather station in Berlin. Each measurement maps an Open-Meteo read field
// to an output series. We keep everything in its native metric unit; downstream
// projects convert on read via @inntend/convert as needed.
const store: ConnectorStore = {
  async list() {
    return [
      {
        id: 'berlin',
        adaptorId: 'open-meteo',
        config: {
          latitude: 52.52,
          longitude: 13.41,
          timezone: 'Europe/Berlin',
        },
        components: [
          {
            identifier: 'berlin',
            measurements: [
              {
                reference: 'temperature_2m',
                unit: 'C',
                identifier: 'weather.temp',
              },
              {
                reference: 'relative_humidity_2m',
                unit: '%',
                identifier: 'weather.humidity',
              },
              {
                reference: 'wind_speed_10m',
                unit: 'km/h',
                identifier: 'weather.wind',
              },
              {
                reference: 'cloud_cover',
                unit: '%',
                identifier: 'weather.cloud',
              },
            ],
          },
        ],
      },
    ];
  },
  async coveredRanges() {
    return [];
  },
  async claim() {
    return true;
  },
  async commitCoverage() {},
  async writeSeries(connectorId, entries) {
    console.log(connectorId, entries);
  },
};

const harvester = new Harvester({ store, deviceId: 'example-device' }).provide(
  openMeteoAdaptor,
);
await harvester.load();

// Fetch current conditions on demand.
const to = new Date();
const from = new Date(to.getTime() - 60 * 60 * 1000);
await harvester.fetchRange('berlin', from, to);

console.log('Done.');
