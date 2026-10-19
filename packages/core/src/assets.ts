export const ASSET_FAMILIES = ['utxo', 'evm', 'tron', 'solana'] as const;
export type AssetFamily = (typeof ASSET_FAMILIES)[number];

/**
 * `derived`: every invoice receives its own address derived from the merchant's account xpub.
 * `shared`: the merchant's single public address is reused and each open invoice gets a unique
 * amount offset so the transfer amount identifies the invoice (used where public derivation is
 * impossible, e.g. ed25519 on Solana).
 */
export type AddressMode = 'derived' | 'shared';

export interface AssetDefinition {
  asset: string;
  network: string;
  family: AssetFamily;
  decimals: number;
  enabled: boolean;
  name: string;
  networkName: string;
  /** Token contract (EVM/TRON) or SPL mint (Solana); absent for native assets. */
  contract: string | null;
  /** The asset whose wallet configuration (xpub/address) this asset shares on its network. */
  walletAsset: string;
  addressMode: AddressMode;
  /** Upper bound for the unique amount offset in shared-address mode. */
  maxOffsetBaseUnits: bigint;
  derivationAsset?: 'BTC' | 'LTC';
  derivationNetwork?: 'mainnet' | 'testnet';
}

interface RawAsset {
  asset?: unknown;
  network?: unknown;
  family?: unknown;
  decimals?: unknown;
  enabled?: unknown;
  name?: unknown;
  network_name?: unknown;
  contract?: unknown;
  wallet_asset?: unknown;
  max_offset_base_units?: unknown;
  derivation_asset?: unknown;
  derivation_network?: unknown;
}

const CODE = /^[A-Z0-9]{2,16}$/;
const NETWORK = /^[a-z0-9-]{2,48}$/;

/** Validates the JSON asset catalog (config/assets.json) and normalizes it. */
export function parseAssetCatalog(input: unknown): AssetDefinition[] {
  if (!Array.isArray(input)) throw new TypeError('asset catalog must be an array');
  const seen = new Set<string>();
  const result = input.map((raw: RawAsset, index): AssetDefinition => {
    const where = `asset catalog entry ${index}`;
    if (typeof raw.asset !== 'string' || !CODE.test(raw.asset)) throw new TypeError(`${where}: asset code is invalid`);
    if (typeof raw.network !== 'string' || !NETWORK.test(raw.network)) throw new TypeError(`${where}: network is invalid`);
    if (!ASSET_FAMILIES.includes(raw.family as AssetFamily)) throw new TypeError(`${where}: family is invalid`);
    if (!Number.isInteger(raw.decimals) || (raw.decimals as number) < 0 || (raw.decimals as number) > 36) throw new TypeError(`${where}: decimals are invalid`);
    const family = raw.family as AssetFamily;
    const key = `${raw.asset}:${raw.network}`;
    if (seen.has(key)) throw new TypeError(`${where}: duplicate ${key}`);
    seen.add(key);
    if (family === 'utxo' && (!['BTC', 'LTC'].includes(raw.derivation_asset as string) || !['mainnet', 'testnet'].includes(raw.derivation_network as string))) {
      throw new TypeError(`${where}: UTXO assets need derivation_asset and derivation_network`);
    }
    const maxOffset = raw.max_offset_base_units === undefined ? 0n : BigInt(String(raw.max_offset_base_units));
    if (maxOffset < 0n) throw new TypeError(`${where}: max_offset_base_units must not be negative`);
    const addressMode: AddressMode = family === 'solana' ? 'shared' : 'derived';
    if (addressMode === 'shared' && maxOffset < 1000n) throw new TypeError(`${where}: shared-address assets need max_offset_base_units of at least 1000`);
    return {
      asset: raw.asset,
      network: raw.network,
      family,
      decimals: raw.decimals as number,
      enabled: raw.enabled !== false,
      name: typeof raw.name === 'string' ? raw.name : raw.asset,
      networkName: typeof raw.network_name === 'string' ? raw.network_name : raw.network,
      contract: typeof raw.contract === 'string' ? raw.contract : null,
      walletAsset: typeof raw.wallet_asset === 'string' ? raw.wallet_asset : raw.asset,
      addressMode,
      maxOffsetBaseUnits: maxOffset,
      ...(family === 'utxo' ? {
        derivationAsset: raw.derivation_asset as 'BTC' | 'LTC',
        derivationNetwork: raw.derivation_network as 'mainnet' | 'testnet',
      } : {}),
    };
  });
  for (const asset of result) {
    const wallet = result.find((candidate) => candidate.asset === asset.walletAsset && candidate.network === asset.network);
    if (!wallet || wallet.contract !== null) throw new TypeError(`${asset.asset}:${asset.network}: wallet_asset must name the native asset of the network`);
  }
  return result;
}

export function findAsset(catalog: readonly AssetDefinition[], asset: string, network: string): AssetDefinition | undefined {
  return catalog.find((candidate) => candidate.asset === asset && candidate.network === network);
}
