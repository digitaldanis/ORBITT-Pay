import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { api, type CatalogAsset, type NetworkHealth } from './api.js';
import { useResource } from './ui.js';

interface CatalogValue {
  assets: CatalogAsset[];
  networks: NetworkHealth[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  networkName: (network: string) => string;
  find: (asset: string, network: string) => CatalogAsset | undefined;
}

const CatalogContext = createContext<CatalogValue | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const load = useCallback(() => api<{ assets: CatalogAsset[]; networks: NetworkHealth[] }>('/v1/dashboard/assets'), []);
  const { data, loading, error, reload } = useResource(load, 'The asset catalog could not be loaded.');
  const value = useMemo<CatalogValue>(() => {
    const assets = data?.assets ?? [];
    const names = new Map(assets.map((asset) => [asset.network, asset.network_name]));
    return {
      assets, networks: data?.networks ?? [], loading, error, reload,
      networkName: (network) => names.get(network) ?? network,
      find: (asset, network) => assets.find((item) => item.asset === asset && item.network === network),
    };
  }, [data, loading, error, reload]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogValue {
  const value = useContext(CatalogContext);
  if (!value) throw new Error('useCatalog must be used inside CatalogProvider');
  return value;
}
