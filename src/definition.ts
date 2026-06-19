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
