import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

const base58check = createBase58check(sha256);
const HARDENED = 0x80000000;

const VERSION_PAIRS = new Map<number, { private: number; public: number }>([
  [0x0488b21e, { private: 0x0488ade4, public: 0x0488b21e }], // xpub
  [0x043587cf, { private: 0x04358394, public: 0x043587cf }], // tpub
  [0x04b24746, { private: 0x04b2430c, public: 0x04b24746 }], // zpub
  [0x045f1cf6, { private: 0x045f18bc, public: 0x045f1cf6 }], // vpub
]);

export function parseAccountPublicKey(extendedKey: string): HDKey {
  if (typeof extendedKey !== 'string' || extendedKey.length < 20 || extendedKey.length > 120) {
    throw new TypeError('extended public key is invalid');
  }
  let payload: Uint8Array;
  try {
    payload = base58check.decode(extendedKey);
  } catch {
    throw new TypeError('extended public key is invalid');
  }
  if (payload.length !== 78) throw new TypeError('extended public key is invalid');
  const version = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
  const versions = VERSION_PAIRS.get(version);
  if (!versions) throw new TypeError('extended public key version is unsupported');
  const key = HDKey.fromExtendedKey(extendedKey, versions);
  if (key.privateKey !== null) throw new TypeError('private extended keys are not accepted');
  if (!key.publicKey || key.depth !== 3 || key.index !== HARDENED) {
    throw new TypeError('an account-level extended public key for account 0 is required');
  }
  return key;
}

export function assertAddressIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED) {
    throw new RangeError('address index must be an integer from 0 to 2147483647');
  }
}
