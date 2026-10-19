import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { deriveEvmReceiveAddress } from '../derivation/evm.js';
import { isSolanaWalletAddress } from '../derivation/solana.js';
import { deriveTronReceiveAddress } from '../derivation/tron.js';
import { deriveUtxoReceiveAddress } from '../derivation/utxo.js';
import { createRecoveryPhrase, deriveEd25519, deriveWalletPublicKeys, isValidRecoveryPhrase, walletKeyForNetwork } from './setup.js';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('in-browser wallet setup', () => {
  it('derives the standard account keys for the BIP39 test phrase', () => {
    const keys = deriveWalletPublicKeys(TEST_PHRASE);
    // BIP84 reference vector.
    expect(keys.bitcoin).toBe('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs');
    expect(deriveUtxoReceiveAddress(keys.bitcoin, 'BTC', 'mainnet', 0).address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(keys.evm).toBe('xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt');
    expect(deriveEvmReceiveAddress(keys.evm, 0).address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(keys.tron).toBe('xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd');
    expect(deriveTronReceiveAddress(keys.tron, 0).address).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
    expect(deriveUtxoReceiveAddress(keys.litecoin, 'LTC', 'mainnet', 0).address).toMatch(/^ltc1q/);
    expect(deriveUtxoReceiveAddress(keys.bitcoinTestnet, 'BTC', 'testnet', 0).address).toMatch(/^tb1q/);
    // Same address Phantom shows for this phrase.
    expect(keys.solana).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
    expect(isSolanaWalletAddress(keys.solana)).toBe(true);
  });

  it('implements SLIP-0010 ed25519 (test vector 1)', () => {
    const seed = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const master = deriveEd25519(seed, 'm');
    expect(bytesToHex(master)).toBe('2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
    expect(bytesToHex(ed25519.getPublicKey(master))).toBe('a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed');
    expect(bytesToHex(deriveEd25519(seed, "m/0'"))).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
    expect(() => deriveEd25519(seed, 'm/0')).toThrow(/hardened/);
  });

  it('creates valid, unique phrases and rejects broken ones', () => {
    const first = createRecoveryPhrase();
    expect(first.split(' ')).toHaveLength(12);
    expect(createRecoveryPhrase(24).split(' ')).toHaveLength(24);
    expect(isValidRecoveryPhrase(first)).toBe(true);
    expect(first).not.toBe(createRecoveryPhrase());
    expect(isValidRecoveryPhrase(TEST_PHRASE.replace('about', 'abandon'))).toBe(false);
    expect(() => deriveWalletPublicKeys('not a phrase')).toThrow(/invalid/);
  });

  it('maps every catalog network to the right public key', () => {
    const keys = deriveWalletPublicKeys(TEST_PHRASE);
    expect(walletKeyForNetwork(keys, 'base')).toEqual({ extended_public_key: keys.evm });
    expect(walletKeyForNetwork(keys, 'solana')).toEqual({ address: keys.solana });
    expect(walletKeyForNetwork(keys, 'unknown')).toBeNull();
  });
});
