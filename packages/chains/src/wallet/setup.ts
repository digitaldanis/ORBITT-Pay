import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * Creates a fresh multi-chain wallet on the merchant's device. Only the public account keys
 * below ever leave it; the recovery phrase stays with the merchant. Paths follow the defaults
 * of common wallets so the phrase can be imported elsewhere to see and spend the funds.
 */

export const WALLET_PATHS = {
  bitcoin: "m/84'/0'/0'",
  bitcoinTestnet: "m/84'/1'/0'",
  litecoin: "m/84'/2'/0'",
  evm: "m/44'/60'/0'",
  tron: "m/44'/195'/0'",
  solana: "m/44'/501'/0'/0'",
} as const;

const ZPUB = { private: 0x04b2430c, public: 0x04b24746 };
const VPUB = { private: 0x045f18bc, public: 0x045f1cf6 };
const HARDENED = 0x80000000;

export interface WalletPublicKeys {
  /** BIP84 account key (zpub) for Bitcoin. */
  bitcoin: string;
  /** BIP84 account key (vpub) for Bitcoin testnet. */
  bitcoinTestnet: string;
  /** BIP84 account key for Litecoin, serialized with zpub version bytes. */
  litecoin: string;
  /** BIP44 account key (xpub) shared by every EVM network. */
  evm: string;
  /** BIP44 account key (xpub) for TRON. */
  tron: string;
  /** Solana wallet address (account 0, as in Phantom and Solflare). */
  solana: string;
}

export function createRecoveryPhrase(words: 12 | 24 = 12): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128);
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(normalizePhrase(phrase), wordlist);
}

export function recoveryWordlist(): readonly string[] {
  return wordlist;
}

function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

/** SLIP-0010 ed25519 derivation; every level is hardened, as ed25519 requires. */
export function deriveEd25519(seed: Uint8Array, path: string): Uint8Array {
  const segments = path.split('/');
  if (segments.shift() !== 'm') throw new TypeError('path must start with m');
  let digest = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  for (const segment of segments) {
    if (!/^\d+'$/.test(segment)) throw new TypeError('ed25519 paths must be fully hardened');
    const index = (Number(segment.slice(0, -1)) + HARDENED) >>> 0;
    const data = new Uint8Array(37);
    data.set(digest.slice(0, 32), 1);
    new DataView(data.buffer).setUint32(33, index, false);
    digest = hmac(sha512, digest.slice(32), data);
  }
  return digest.slice(0, 32);
}

export function deriveWalletPublicKeys(phrase: string, passphrase = ''): WalletPublicKeys {
  const normalized = normalizePhrase(phrase);
  if (!validateMnemonic(normalized, wordlist)) throw new TypeError('recovery phrase is invalid');
  const seed = mnemonicToSeedSync(normalized, passphrase);
  const account = (path: string, versions?: { private: number; public: number }) =>
    HDKey.fromMasterSeed(seed, versions).derive(path).publicExtendedKey;
  const solanaSecret = deriveEd25519(seed, WALLET_PATHS.solana);
  const keys: WalletPublicKeys = {
    bitcoin: account(WALLET_PATHS.bitcoin, ZPUB),
    bitcoinTestnet: account(WALLET_PATHS.bitcoinTestnet, VPUB),
    litecoin: account(WALLET_PATHS.litecoin, ZPUB),
    evm: account(WALLET_PATHS.evm),
    tron: account(WALLET_PATHS.tron),
    solana: base58.encode(ed25519.getPublicKey(solanaSecret)),
  };
  seed.fill(0);
  solanaSecret.fill(0);
  return keys;
}

/** Which public key from `deriveWalletPublicKeys` belongs to a catalog network, and how it is sent. */
export function walletKeyForNetwork(keys: WalletPublicKeys, network: string): { extended_public_key: string } | { address: string } | null {
  switch (network) {
    case 'bitcoin': return { extended_public_key: keys.bitcoin };
    case 'bitcoin-testnet': return { extended_public_key: keys.bitcoinTestnet };
    case 'litecoin': return { extended_public_key: keys.litecoin };
    case 'ethereum': case 'ethereum-sepolia': case 'base': case 'arbitrum': case 'optimism': case 'polygon': case 'bnb-chain':
      return { extended_public_key: keys.evm };
    case 'tron': return { extended_public_key: keys.tron };
    case 'solana': return { address: keys.solana };
    default: return null;
  }
}
