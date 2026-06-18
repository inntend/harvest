import { type ConnectorStore, demoAdaptor, Harvester } from '../src/index.js';

// Connectors are demand-driven: the host implements a ConnectorStore and calls
// fetchRange(connector, from, to) when it needs data. Here we use a trivial
// in-memory store that claims everything and just logs the fetched series.
const store: ConnectorStore = {
  async list() {
    return [
      {
        id: 'battery-1',
        adaptorId: 'demo',
        config: {
          'charging.max': 50_000, // W
          'discharging.max': 50_000, // W
          capacity: 100_000, // Wh
        },
        components: [
          {
            identifier: 'battery-1',
            measurements: [
              { reference: 'soc', unit: '%', identifier: 'battery.soc' },
              {
                reference: 'chargePower',
                unit: 'kW',
                identifier: 'battery.charge',
              },
              {
                reference: 'voltage',
                unit: 'V',
                identifier: 'battery.voltage',
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
  async commitCoverage(connectorId, from, to) {
    console.log(`covered ${connectorId}: ${from} → ${to}`);
  },
  async writeSeries(connectorId, entries) {
    console.log(connectorId, entries);
  },
};

const harvester = new Harvester({ store, deviceId: 'example-device' }).provide(
  demoAdaptor,
);
await harvester.load();

// Fill the last hour on demand.
const to = new Date();
const from = new Date(to.getTime() - 60 * 60 * 1000);
await harvester.fetchRange('battery-1', from, to);

// Manual write-back (value given in the measurement's unit).
await harvester.write('battery-1', [
  { reference: 'targetSoc', value: 80, unit: '%' },
]);

console.log('Done.');
