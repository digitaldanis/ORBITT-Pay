import { describe, expect, it } from 'vitest';
import { deriveEvmReceiveAddress } from './evm.js';
import { associatedTokenAddress, isSolanaWalletAddress } from './solana.js';
import { deriveTronReceiveAddress, isTronAddress } from './tron.js';

// Account xpubs for the BIP39 test mnemonic "abandon abandon … about" (empty passphrase).
const TRON_ACCOUNT_XPUB = 'xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd';
const EVM_ACCOUNT_XPUB = 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('TRON derivation', () => {
  it('matches the well-known first address of the BIP39 test mnemonic', () => {
    const derived = deriveTronReceiveAddress(TRON_ACCOUNT_XPUB, 0);
    expect(derived.address).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
    expect(derived.derivationPath).toBe("m/44'/195'/0'/0/0");
    expect(isTronAddress(derived.address)).toBe(true);
  });

  it('derives distinct addresses per index', () => {
    expect(deriveTronReceiveAddress(TRON_ACCOUNT_XPUB, 1).address).not.toBe(deriveTronReceiveAddress(TRON_ACCOUNT_XPUB, 0).address);
    expect(isTronAddress('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdX')).toBe(false);
  });
});

describe('EVM derivation vector', () => {
  it('matches the well-known first Ethereum address of the BIP39 test mnemonic', () => {
    expect(deriveEvmReceiveAddress(EVM_ACCOUNT_XPUB, 0).address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  });
});

describe('Solana helpers', () => {
  it('computes associated token accounts like the SPL program (mainnet vectors)', () => {
    expect(associatedTokenAddress('J6SzzpZHZbq38N46r63NmTkFB4MtasHGicvp83pf9WkF', USDC_MINT)).toBe('9juyArd2hoJCiYATMHwdRhaWkk8RKd1RzN3F2MWv21tp');
    expect(associatedTokenAddress('67K433dso6AYvGMepJfbkcLgwVKeUqgLMTV7MPeYVs2v', USDC_MINT)).toBe('HsT1ncdqdQucdg6uFVQGfwW8mnb3rMTZPXcWZGXbfax6');
  });

  it('accepts on-curve wallet addresses and rejects program-derived or malformed keys', () => {
    expect(isSolanaWalletAddress('J6SzzpZHZbq38N46r63NmTkFB4MtasHGicvp83pf9WkF')).toBe(true);
    expect(isSolanaWalletAddress('9juyArd2hoJCiYATMHwdRhaWkk8RKd1RzN3F2MWv21tp')).toBe(false);
    expect(isSolanaWalletAddress('not-a-key')).toBe(false);
  });
});
