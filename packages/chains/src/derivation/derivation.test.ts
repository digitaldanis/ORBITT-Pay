import { describe, expect, it } from 'vitest';
import { deriveEvmReceiveAddress } from './evm.js';
import { deriveUtxoReceiveAddress } from './utxo.js';

const BIP84_ACCOUNT_0_ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const EVM_ACCOUNT_0_XPUB = 'xpub6CwasPN7q9x45iih2mG6QgxJNbSwDbuPA2pPSFYmbMneQdHy17tGBMdYcCr4MKpRneAFc157vDcTPXzscREvFG8tXaUYut4X3fT2mguurMQ';

describe('public address derivation', () => {
  it('matches the BIP84 first Bitcoin receiving address vector', () => {
    expect(deriveUtxoReceiveAddress(BIP84_ACCOUNT_0_ZPUB, 'BTC', 'mainnet', 0)).toMatchObject({
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      derivationPath: "m/84'/0'/0'/0/0",
      publicKeyHex: '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c',
    });
  });

  it('derives a checksummed EVM address from an account xpub', () => {
    const result = deriveEvmReceiveAddress(EVM_ACCOUNT_0_XPUB, 0);
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.address).not.toBe(result.address.toLowerCase());
    expect(result.derivationPath).toBe("m/44'/60'/0'/0/0");
  });

  it('rejects invalid indexes and non-account extended keys', () => {
    expect(() => deriveUtxoReceiveAddress(BIP84_ACCOUNT_0_ZPUB, 'BTC', 'mainnet', -1)).toThrow(RangeError);
    expect(() => deriveEvmReceiveAddress('not-an-xpub', 0)).toThrow(TypeError);
  });
});
