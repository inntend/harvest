import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { demoAdaptor } from './adaptors/demo';
import { openMeteoAdaptor } from './adaptors/open-meteo';
import { skyhintsAdaptor } from './adaptors/skyhints';
import type { AdaptorDef } from './definition';
import {
  type ConnectorStore,
  Harvester,
  type HarvesterOptions,
} from './harvester';
import type {
  AdaptorInfo,
  ErrorEvent,
  RetryOptions,
  WriteInput,
} from './registry';
import type { AnyAdaptor } from './types';

// Built-in adaptors auto-registered by HarvesterProvider (unless disabled).
const BUILTINS: AnyAdaptor[] = [demoAdaptor, openMeteoAdaptor, skyhintsAdaptor];

export type HarvesterContextValue = {
  // True once connectors have been loaded from the store and configured.
  ready: boolean;
  // Ids of all loaded/configured connectors (enabled + adaptor available).
  connectorIds: string[];
  // Fill any uncovered gaps of [from, to) for one connector (on demand).
  fetchRange: (connectorId: string, from: Date, to: Date) => Promise<void>;
  // Force a re-fetch of [from, to): clear its coverage/claims/series, then fetch.
  refetch: (connectorId: string, from: Date, to: Date) => Promise<void>;
  // Connector ids with an in-flight re-fetch, so data views can show a pending
  // state. Driven by markRefetching (not demand-pull, which has its own loading).
  refetching: Record<string, boolean>;
  // Flag a connector as actively re-fetching; returns a release fn. Ref-counted
  // so overlapping/chunked re-fetches stay marked until the last one releases.
  markRefetching: (connectorId: string) => () => void;
  // Manual write-back: push values out via the connector's adaptor.send().
  write: (connectorId: string, inputs: WriteInput[]) => Promise<void>;
  // Re-read connector configs (e.g. after new connectors arrive).
  reload: () => Promise<void>;
  // Last error per connector id (unknown adaptor, exhausted fetch retries, …).
  health: Record<string, ErrorEvent>;
  // The def for a provided adaptor type (catalog lookup — available before load()).
  adaptorDef: (adaptorId: string) => AdaptorDef | null;
  // All registered adaptor types (built-in + supplied) for an adaptor picker.
  listAdaptors: () => AdaptorInfo[];
};

const HarvesterContext = createContext<HarvesterContextValue | null>(null);

export function useHarvester(): HarvesterContextValue {
  const ctx = useContext(HarvesterContext);
  if (!ctx) throw new Error('HarvesterContext not initialized.');
  return ctx;
}

export type HarvesterProviderProps = {
  // The host's persistence adapter — see ConnectorStore.
  store: ConnectorStore;
  // Stable per-device id used to attribute fetch claims across devices.
  deviceId: string;
  // Custom adaptors in addition to the built-ins.
  adaptors?: AnyAdaptor[];
  // Auto-register the built-in adaptors (demo/open-meteo/skyhints). Default true.
  includeBuiltins?: boolean;
  retry?: RetryOptions;
  // Gate loading until prerequisites are met (e.g. an encryption key). Default true.
  enabled?: boolean;
  // When this value changes, connectors are reloaded (e.g. a store change signal).
  reloadKey?: unknown;
  children: ReactNode;
};

export function HarvesterProvider(props: HarvesterProviderProps): ReactElement {
  const { store, deviceId, retry, enabled = true, reloadKey, children } = props;
  const adaptors = props.adaptors ?? [];
  const includeBuiltins = props.includeBuiltins ?? true;

  // Read latest non-effect inputs via refs so they don't retrigger the effect.
  const adaptorsRef = useRef(adaptors);
  adaptorsRef.current = adaptors;
  const builtinsRef = useRef(includeBuiltins);
  builtinsRef.current = includeBuiltins;

  const harvesterRef = useRef<Harvester | null>(null);
  const [health, setHealth] = useState<Record<string, ErrorEvent>>({});
  const [ready, setReady] = useState(false);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const options: HarvesterOptions = { store, deviceId, retry };
    const list = builtinsRef.current
      ? [...BUILTINS, ...adaptorsRef.current]
      : adaptorsRef.current;
    const harvester = new Harvester(options)
      .provide(...list)
      .onError((event) =>
        setHealth((prev) => ({ ...prev, [event.connectorId]: event })),
      );
    harvesterRef.current = harvester;
    setReady(false);
    setConnectorIds([]);
    void harvester.load().then(() => {
      if (!active) return;
      setConnectorIds(harvester.connectorIds());
      setReady(true);
    });
    return () => {
      active = false;
      harvesterRef.current = null;
      setReady(false);
      setConnectorIds([]);
    };
  }, [store, deviceId, retry, enabled, reloadKey]);

  const fetchRange = useCallback(
    async (connectorId: string, from: Date, to: Date) => {
      await harvesterRef.current?.fetchRange(connectorId, from, to);
    },
    [],
  );

  const refetch = useCallback(
    async (connectorId: string, from: Date, to: Date) => {
      await harvesterRef.current?.refetch(connectorId, from, to);
    },
    [],
  );

  const [refetching, setRefetching] = useState<Record<string, boolean>>({});
  const refetchCounts = useRef<Record<string, number>>({});

  const markRefetching = useCallback((connectorId: string) => {
    const counts = refetchCounts.current;
    counts[connectorId] = (counts[connectorId] ?? 0) + 1;
    if (counts[connectorId] === 1)
      setRefetching((prev) => ({ ...prev, [connectorId]: true }));
    return () => {
      counts[connectorId] -= 1;
      if (counts[connectorId] === 0)
        setRefetching((prev) => {
          const next = { ...prev };
          delete next[connectorId];
          return next;
        });
    };
  }, []);

  const write = useCallback(
    async (connectorId: string, inputs: WriteInput[]) => {
      await harvesterRef.current?.write(connectorId, inputs);
    },
    [],
  );

  const reload = useCallback(async () => {
    const harvester = harvesterRef.current;
    if (!harvester) return;
    await harvester.load();
    setConnectorIds(harvester.connectorIds());
  }, []);

  const adaptorDef = useCallback(
    (adaptorId: string): AdaptorDef | null =>
      harvesterRef.current?.adaptorDef(adaptorId) ?? null,
    [],
  );

  const listAdaptors = useCallback(
    (): AdaptorInfo[] => harvesterRef.current?.adaptors() ?? [],
    [],
  );

  const value = useMemo(
    () => ({
      ready,
      connectorIds,
      fetchRange,
      refetch,
      refetching,
      markRefetching,
      write,
      reload,
      health,
      adaptorDef,
      listAdaptors,
    }),
    [
      ready,
      connectorIds,
      fetchRange,
      refetch,
      refetching,
      markRefetching,
      write,
      reload,
      health,
      adaptorDef,
      listAdaptors,
    ],
  );

  return createElement(HarvesterContext.Provider, { value }, children);
}

// Demand trigger: when a view needs data over [from, to), ask every configured
// connector to fill any uncovered gaps. Covered ranges make no external call.
export function useDemandPull(range: { from: Date; to: Date }): void {
  const { ready, connectorIds, fetchRange } = useHarvester();
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();

  useEffect(() => {
    if (!ready) return;
    let active = true;
    void (async () => {
      for (const connectorId of connectorIds) {
        if (!active) return;
        await fetchRange(connectorId, new Date(fromIso), new Date(toIso));
      }
    })();
    return () => {
      active = false;
    };
  }, [ready, connectorIds, fromIso, toIso, fetchRange]);
}
