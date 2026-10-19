import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { PostgresInvoicePreparer } from './preparer.js';
import type { RateService } from '@orbitt/rates';
import type { MerchantContext } from '../server.js';

const zpub = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const merchant: MerchantContext = { id: '4ab9080f-5905-4dcb-a1d2-0d69edfbcf1e', name: 'Example Shop' };

function harness(rate = '50000') {
  const updates: unknown[][] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('SELECT extended_public_key')) return { rows: [{ extended_public_key: zpub, address: null, next_derivation_index: '0' }] };
      if (sql.includes('UPDATE merchant_wallets')) updates.push(values);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const rateService = { getRate: async () => ({ rate, timestamp: new Date('2026-10-19T10:00:00Z'), source: 'test', asset: 'BTC', fiatCurrency: 'EUR', fetchedAt: new Date(), stale: false }) } as unknown as RateService;
  const preparer = new PostgresInvoicePreparer([
    { asset: 'BTC', network: 'bitcoin', family: 'utxo', decimals: 8, enabled: true, derivation_asset: 'BTC', derivation_network: 'mainnet' },
  ], rateService);
  return { client, preparer, updates };
}

describe('Postgres invoice preparation', () => {
  it('locks a fiat quote, rounds into base units, and allocates an auditable address', async () => {
    const { client, preparer, updates } = harness();
    const result = await preparer.prepare(client, merchant, { amount: '25.00', currency: 'EUR', asset: 'BTC', network: 'bitcoin' });
    expect(result.cryptoAmountBaseUnits).toBe(50_000n);
    expect(result.cryptoAmount).toBe('0.0005');
    expect(result.rateUsed).toBe('50000');
    expect(result.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(result.derivationPath).toBe("m/84'/0'/0'/0/0");
    expect(updates[0]?.[3]).toBe(1);
  });

  it('accepts a crypto-denominated amount without an exchange rate', async () => {
    const { client, preparer } = harness();
    const result = await preparer.prepare(client, merchant, { amount: '0.00000002', currency: 'BTC' });
    expect(result.cryptoAmountBaseUnits).toBe(2n);
    expect(result.fiatAmount).toBeNull();
    expect(result.rateUsed).toBeNull();
  });
});
