import { describe, expect, it } from 'vitest';
import { buildPaymentUri } from './payment-uri.js';

describe('wallet payment URIs', () => {
  it('builds BIP21 and Litecoin payment links with the exact amount', () => {
    expect(buildPaymentUri({ asset: 'BTC', network: 'bitcoin', address: 'bc1qabc', amount: '0.001', baseUnits: '100000' }))
      .toBe('bitcoin:bc1qabc?amount=0.001');
    expect(buildPaymentUri({ asset: 'LTC', network: 'litecoin', address: 'ltc1abc', amount: '2.5', baseUnits: '250000000' }))
      .toBe('litecoin:ltc1abc?amount=2.5');
  });

  it('builds EIP-681 for native EVM payments and falls back to the address otherwise', () => {
    expect(buildPaymentUri({ asset: 'ETH', network: 'base', address: '0x1111111111111111111111111111111111111111', amount: '0.01', baseUnits: '10000000000000000' }))
      .toBe('ethereum:0x1111111111111111111111111111111111111111@8453?value=10000000000000000');
    expect(buildPaymentUri({ asset: 'SOL', network: 'solana', address: 'wallet', amount: '1', baseUnits: '1000000000' })).toBe('wallet');
  });
});
