import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';
import { assertAddressIndex, parseAccountPublicKey } from './hd-key.js';

export type UtxoAsset = 'BTC' | 'LTC';
export type UtxoNetwork = 'mainnet' | 'testnet';

export interface DerivedAddress {
  address: string;
  derivationPath: string;
  publicKeyHex: string;
}

const NETWORKS: Record<UtxoAsset, Record<UtxoNetwork, { hrp: string; coinType: number }>> = {
  BTC: {
    mainnet: { hrp: 'bc', coinType: 0 },
    testnet: { hrp: 'tb', coinType: 1 },
  },
  LTC: {
    mainnet: { hrp: 'ltc', coinType: 2 },
    testnet: { hrp: 'tltc', coinType: 1 },
  },
};

export function deriveUtxoReceiveAddress(
  accountExtendedPublicKey: string,
  asset: UtxoAsset,
  network: UtxoNetwork,
  index: number,
): DerivedAddress {
  assertAddressIndex(index);
  const networkConfig = NETWORKS[asset]?.[network];
  if (!networkConfig) throw new TypeError('unsupported UTXO asset or network');
  const account = parseAccountPublicKey(accountExtendedPublicKey);
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error('could not derive child public key');
  const pubkeyHash = ripemd160(sha256(child.publicKey));
  const address = bech32.encode(networkConfig.hrp, [0, ...bech32.toWords(pubkeyHash)]);
  return {
    address,
    derivationPath: `m/84'/${networkConfig.coinType}'/0'/0/${index}`,
    publicKeyHex: Array.from(child.publicKey, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}
