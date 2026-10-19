import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { parseAssetCatalog } from '@orbitt/core';
import { PostgresInvoicePreparer } from './preparer.js';
import type { RateService } from '@orbitt/rates';
import type { MerchantContext } from '../server.js';

const zpub = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const tronXpub = 'xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd';
const solanaAddress = 'J6SzzpZHZbq38N46r63NmTkFB4MtasHGicvp83pf9WkF';
const merchant: MerchantContext = { id: '4ab9080f-5905-4dcb-a1d2-0d69edfbcf1e', name: 'Example Shop' };

const catalog = parseAssetCatalog([
  { asset: 'BTC', network: 'bitcoin', family: 'utxo', decimals: 8, derivation_asset: 'BTC', derivation_network: 'mainnet' },
  { asset: 'TRX', network: 'tron', family: 'tron', decimals: 6 },
  { asset: 'USDT', network: 'tron', family: 'tron', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', wallet_asset: 'TRX' },
  { asset: 'USDT', network: 'ethereum', family: 'evm', decimals: 6, contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', wallet_asset: 'ETH' },
  { asset: 'ETH', network: 'ethereum', family: 'evm', decimals: 18 },
  { asset: 'SOL', network: 'solana', family: 'solana', decimals: 9, max_offset_base_units: '99999' },
]);

interface Wallet { asset: string; network: string; extended_public_key: string | null; address: string | null; next_derivation_index: string }

function harness(rate = '50000', options: { usedAddresses?: string[]; reservedAmounts?: string[] } = {}) {
  const updates: unknown[][] = [];
  const wallets: Wallet[] = [
    { asset: 'BTC', network: 'bitcoin', extended_public_key: zpub, address: null, next_derivation_index: '0' },
    { asset: 'TRX', network: 'tron', extended_public_key: tronXpub, address: null, next_derivation_index: '0' },
    { asset: 'SOL', network: 'solana', extended_public_key: null, address: solanaAddress, next_derivation_index: '0' },
  ];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('SELECT extended_public_key')) {
        return { rows: wallets.filter((wallet) => wallet.asset === values[1] && wallet.network === values[2]) };
      }
      if (sql.includes('has_key')) {
        return { rows: wallets.map((wallet) => ({ asset: wallet.asset, network: wallet.network, has_key: !!wallet.extended_public_key, has_address: !!wallet.address })) };
      }
      if (sql.includes('lower(address) = lower($2)')) {
        return { rows: options.usedAddresses?.includes(values[1] as string) ? [{}] : [], rowCount: options.usedAddresses?.includes(values[1] as string) ? 1 : 0 };
      }
      if (sql.includes('crypto_amount_base_units AS amount')) return { rows: (options.reservedAmounts ?? []).map((amount) => ({ amount })) };
      if (sql.includes('UPDATE merchant_wallets')) updates.push(values);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const rateService = { getRate: async () => ({ rate, timestamp: new Date('2026-10-19T10:00:00Z'), source: 'test', asset: 'BTC', fiatCurrency: 'EUR', fetchedAt: new Date(), stale: false }) } as unknown as RateService;
  const preparer = new PostgresInvoicePreparer(catalog, rateService);
  return { client, preparer, updates };
}

describe('Postgres invoice preparation', () => {
  it('locks a fiat quote, rounds into base units, and allocates an auditable address', async () => {
    const { client, preparer, updates } = harness();
    const result = await preparer.prepare(client, merchant, { amount: '25.00', currency: 'EUR', asset: 'BTC', network: 'bitcoin' });
    expect(result.payment).toMatchObject({
      cryptoAmountBaseUnits: 50_000n,
      cryptoAmount: '0.0005',
      rateUsed: '50000',
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      derivationPath: "m/84'/0'/0'/0/0",
      addressMode: 'derived',
    });
    expect(updates[0]?.[3]).toBe(1);
  });

  it('accepts a crypto-denominated amount without an exchange rate', async () => {
    const { client, preparer } = harness();
    const result = await preparer.prepare(client, merchant, { amount: '0.00000002', currency: 'BTC' });
    expect(result.payment?.cryptoAmountBaseUnits).toBe(2n);
    expect(result.fiatAmount).toBeNull();
    expect(result.payment?.rateUsed).toBeNull();
  });

  it('defers the coin choice to hosted checkout when only a fiat amount is given', async () => {
    const { client, preparer } = harness();
    const result = await preparer.prepare(client, merchant, { amount: '19.99', currency: 'EUR' });
    expect(result.payment).toBeNull();
    expect(result.fiatAmount).toBe('19.99');
    const options = await preparer.paymentOptions(client, merchant.id);
    expect(options.map((option) => `${option.asset}:${option.network}`)).toEqual(['BTC:bitcoin', 'TRX:tron', 'USDT:tron', 'SOL:solana']);
  });

  it('derives TRC-20 token addresses from the TRX wallet and skips addresses used before', async () => {
    const { client, preparer, updates } = harness('0.9', { usedAddresses: ['TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'] });
    const payment = await preparer.selectPayment(client, merchant, { amount: '9.00', currency: 'EUR' }, 'USDT', 'tron');
    expect(payment.cryptoAmountBaseUnits).toBe(10_000_000n);
    expect(payment.derivationPath).toBe("m/44'/195'/0'/0/1");
    expect(payment.address).not.toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
    expect(updates[0]).toEqual([merchant.id, 'TRX', 'tron', 2]);
  });

  it('makes shared-address amounts unique per open invoice', async () => {
    const { client, preparer } = harness('100', { reservedAmounts: [] });
    const payment = await preparer.selectPayment(client, merchant, { amount: '10', currency: 'EUR' }, 'SOL', 'solana');
    expect(payment.address).toBe(solanaAddress);
    expect(payment.addressMode).toBe('shared');
    expect(payment.cryptoAmountBaseUnits).toBeGreaterThan(100_000_000n);
    expect(payment.cryptoAmountBaseUnits).toBeLessThanOrEqual(100_099_999n);
  });

  it('asks for a network when a token exists on several chains and rejects unconfigured wallets', async () => {
    const { client, preparer } = harness();
    await expect(preparer.prepare(client, merchant, { amount: '5', currency: 'EUR', asset: 'USDT' })).rejects.toMatchObject({ code: 'network_required' });
    await expect(preparer.prepare(client, merchant, { amount: '5', currency: 'EUR', asset: 'USDT', network: 'ethereum' })).rejects.toMatchObject({ code: 'wallet_not_configured' });
  });
});
