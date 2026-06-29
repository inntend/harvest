export { demoAdaptor } from './adaptors/demo';
export { openMeteoAdaptor } from './adaptors/open-meteo';
export { skyhintsAdaptor } from './adaptors/skyhints';
export type {
  AdaptorDef,
  Bound,
  FieldDef,
  PropertyDef,
  PropertyOverride,
} from './definition';
export { SchemaError } from './definition';
export type {
  ConnectorSpec,
  ConnectorStore,
  HarvesterOptions,
  Interval,
  ParameterPoint,
  Segment,
} from './harvester';
export {
  Harvester,
  segmentByParameters,
  subtractIntervals,
} from './harvester';
export type {
  AdaptorInfo,
  ConfigureInput,
  ErrorEvent,
  RetryOptions,
  WriteInput,
} from './registry';
export { AdaptorRegistry } from './registry';
export { Schema } from './schema';
export type { Adaptor, AnyAdaptor, InputFeed, Range, Reading } from './types';
export { UnknownAdaptorError } from './types';
