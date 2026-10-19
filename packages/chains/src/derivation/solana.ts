import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

function decodePublicKey(value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(value);
  } catch {
    throw new TypeError('Solana public key is invalid');
  }
  if (bytes.length !== 32) throw new TypeError('Solana public key is invalid');
  return bytes;
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True for a 32-byte base58 key that is a regular (on-curve) wallet address. */
export function isSolanaWalletAddress(value: string): boolean {
  try {
    return isOnCurve(decodePublicKey(value));
  } catch {
    return false;
  }
}

/** Solana `findProgramAddress`: the first off-curve sha256(seeds || bump || program || marker). */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): { address: string; bump: number } {
  const program = decodePublicKey(programId);
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = sha256(Uint8Array.from([...seeds.flatMap((seed) => [...seed]), bump, ...program, ...marker]));
    if (!isOnCurve(hash)) return { address: base58.encode(hash), bump };
  }
  throw new Error('no program address found');
}

/** Associated token account that receives an SPL `mint` for the wallet `owner`. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgramId = SPL_TOKEN_PROGRAM_ID): string {
  return findProgramAddress(
    [decodePublicKey(owner), decodePublicKey(tokenProgramId), decodePublicKey(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).address;
}
