import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { assertAddressIndex, parseAccountPublicKey } from './hd-key.js';
import type { DerivedAddress } from './utxo.js';

const base58check = createBase58check(sha256);
const TRON_ADDRESS_PREFIX = 0x41;

/** Encodes a 20-byte account id as a TRON base58check address (prefix 0x41, "T..."). */
export function encodeTronAddress(accountId: Uint8Array): string {
  if (accountId.length !== 20) throw new TypeError('TRON account id must be 20 bytes');
  return base58check.encode(Uint8Array.from([TRON_ADDRESS_PREFIX, ...accountId]));
}

export function isTronAddress(address: string): boolean {
  try {
    const payload = base58check.decode(address);
    return payload.length === 21 && payload[0] === TRON_ADDRESS_PREFIX;
  } catch {
    return false;
  }
}

/**
 * Derives a TRON receive address from an account-level xpub at m/44'/195'/0'.
 * TRON uses secp256k1 and the same keccak account id as Ethereum, so public derivation works.
 */
export function deriveTronReceiveAddress(accountExtendedPublicKey: string, index: number): DerivedAddress {
  assertAddressIndex(index);
  const account = parseAccountPublicKey(accountExtendedPublicKey);
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error('could not derive child public key');
  const uncompressed = secp256k1.Point.fromBytes(child.publicKey).toBytes(false).subarray(1);
  return {
    address: encodeTronAddress(keccak_256(uncompressed).subarray(12)),
    derivationPath: `m/44'/195'/0'/0/${index}`,
    publicKeyHex: Array.from(child.publicKey, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}
