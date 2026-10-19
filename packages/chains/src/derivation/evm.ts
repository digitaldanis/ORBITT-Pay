import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { assertAddressIndex, parseAccountPublicKey } from './hd-key.js';
import type { DerivedAddress } from './utxo.js';

function toChecksumAddress(addressBytes: Uint8Array): string {
  const lower = Array.from(addressBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const hash = keccak_256(new TextEncoder().encode(lower));
  const checksummed = Array.from(lower, (character, index) => {
    const nibble = index % 2 === 0 ? hash[index >> 1]! >> 4 : hash[index >> 1]! & 0x0f;
    return nibble >= 8 ? character.toUpperCase() : character;
  }).join('');
  return `0x${checksummed}`;
}

export function deriveEvmReceiveAddress(accountExtendedPublicKey: string, index: number): DerivedAddress {
  assertAddressIndex(index);
  const account = parseAccountPublicKey(accountExtendedPublicKey);
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error('could not derive child public key');
  const publicKey = secp256k1.Point.fromBytes(child.publicKey).toBytes(false).subarray(1);
  const addressHash = keccak_256(publicKey);
  const address = toChecksumAddress(addressHash.subarray(12));
  return {
    address,
    derivationPath: `m/44'/60'/0'/0/${index}`,
    publicKeyHex: Array.from(child.publicKey, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}
