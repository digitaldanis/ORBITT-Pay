import { describe, expect, it } from 'vitest';
import { buildPaymentUri, explorerTransactionUrl, toBaseUnits } from './payment-uri.js';

const evm = '0x1111111111111111111111111111111111111111';

describe('wallet payment URIs', () => {
  it('builds BIP21 and Litecoin payment links with the exact amount', () => {
    expect(buildPaymentUri({ asset: 'BTC', network: 'bitcoin', address: 'bc1qabc', amount: '0.001', baseUnits: '100000' }))
      .toBe('bitcoin:bc1qabc?amount=0.001');
    expect(buildPaymentUri({ asset: 'LTC', network: 'litecoin', address: 'ltc1abc', amount: '2.5', baseUnits: '250000000' }))
      .toBe('litecoin:ltc1abc?amount=2.5');
  });

  it('builds EIP-681 for native coins on every EVM chain', () => {
    expect(buildPaymentUri({ asset: 'ETH', network: 'base', address: evm, amount: '0.01', baseUnits: '10000000000000000' }))
      .toBe(`ethereum:${evm}@8453?value=10000000000000000`);
    expect(buildPaymentUri({ asset: 'POL', network: 'polygon', address: evm, amount: '2', baseUnits: '2000000000000000000' }))
      .toBe(`ethereum:${evm}@137?value=2000000000000000000`);
  });

  it('encodes only the recipient for EVM and TRON tokens so no wallet can misroute funds', () => {
    expect(buildPaymentUri({ asset: 'USDT', network: 'ethereum', address: evm, amount: '5', baseUnits: '5000000', tokenContract: '0xdAC17F958D2ee523a2206206994597C13D831ec7' })).toBe(evm);
    expect(buildPaymentUri({ asset: 'USDT', network: 'tron', address: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', amount: '5', baseUnits: '5000000', tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }))
      .toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  });

  it('builds Solana Pay transfer requests for SOL and SPL tokens', () => {
    expect(buildPaymentUri({ asset: 'SOL', network: 'solana', address: 'Wallet111', amount: '1.000042', baseUnits: '1000042000' }))
      .toBe('solana:Wallet111?amount=1.000042');
    expect(buildPaymentUri({ asset: 'USDC', network: 'solana', address: 'Wallet111', amount: '9.5031', baseUnits: '9503100', tokenContract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }))
      .toBe('solana:Wallet111?amount=9.5031&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('converts decimal amounts to base units without floats', () => {
    expect(toBaseUnits('0.0003', 8)).toBe('30000');
    expect(toBaseUnits('12', 18)).toBe('12000000000000000000');
    expect(() => toBaseUnits('0.1234567', 6)).toThrow(RangeError);
  });

  it('links transactions to a block explorer', () => {
    expect(explorerTransactionUrl('tron', 'abc')).toBe('https://tronscan.org/#/transaction/abc');
    expect(explorerTransactionUrl('unknown', 'abc')).toBeNull();
  });
});
