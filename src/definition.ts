export type Bound = number | string; // string = key in def.properties

export type PropertyDef = { unit: string; value: number };

export type FieldDef = {
  unit: string;
  label?: string;
  min?: Bound;
  max?: Bound;
};

export type AdaptorDef = {
  properties: Record<string, PropertyDef>;
  read: Record<string, FieldDef>;
  write: Record<string, FieldDef>;
  // Config keys that can be driven by a measurement history instead of a fixed
  // bootstrap value (e.g. open-meteo latitude/longitude from a GPS series). The
  // key is the adaptor `config` key; FieldDef supplies unit/label/min/max for UI.
  inputs?: Record<string, FieldDef>;
  // Presentation metadata the host renders. `description` is a one-line blurb;
  // `icon` is an image source (URL or data-URI — an SVG/PNG per adaptor). Both
  // travel with the adaptor, so host-supplied custom adaptors carry their own.
  description?: string;
  icon?: string;
};

export type PropertyOverride = {
  reference: string; // key in def.properties
  unit: string;
  value: number;
};

export type MeasurementRef = {
  reference: string; // key in def.read
  unit: string; // desired output unit
  identifier: string; // SeriesEntry identifier
};

export type Component = {
  identifier: string;
  status?: 'ready' | 'disabled'; // defaults to 'ready'
  properties?: PropertyOverride[];
  measurements?: MeasurementRef[];
};

export type SeriesEntry = {
  identifier: string;
  timestamp: string;
  value: number;
};

export class SchemaError extends Error {}
