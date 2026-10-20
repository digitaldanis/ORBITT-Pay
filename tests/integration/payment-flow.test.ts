/**
 * End-to-end payment flow against a real PostgreSQL database.
 * Runs only when TEST_DATABASE_URL points at a disposable database, for example:
 *   docker run -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAssetCatalog } from '@orbitt/core';
import type { RateService } from '@orbitt/rates';
import { verifyWebhookSignature } from '@orbitt/webhooks';
import { migrateDatabase } from '../../apps/api/src/db/migrate.js';
import { PostgresApiServices } from '../../apps/api/src/db/postgres-services.js';
import { PostgresInvoicePreparer } from '../../apps/api/src/invoices/preparer.js';
import { ChainScanner, type OpenInvoice } from '../../apps/worker/src/chain-scanner.js';
import { WebhookWorker } from '../../apps/worker/src/webhook-worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const catalog = parseAssetCatalog(JSON.parse(readFileSync(new URL('../../config/assets.json', import.meta.url), 'utf8')));
const zpub = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const tronXpub = 'xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd';
const solanaAddress = 'J6SzzpZHZbq38N46r63NmTkFB4MtasHGicvp83pf9WkF';
const rates = {
  getRate: async ({ asset }: { asset: string }) => ({
    asset, fiatCurrency: 'EUR', rate: asset === 'BTC' ? '50000' : asset === 'SOL' ? '100' : '1', source: 'test',
    timestamp: new Date(), fetchedAt: new Date(), stale: false,
  }),
} as unknown as RateService;

describe.skipIf(!databaseUrl)('payment flow (PostgreSQL)', () => {
  let pool: Pool;
  let services: PostgresApiServices;
  let scanner: ChainScanner;
  let merchant: { id: string; name: string };
  let hook: Server;
  const received: Array<{ body: string; signature: string }> = [];
  let signingSecret = '';

  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = 'true';
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrateDatabase(pool);
    services = new PostgresApiServices(pool, new PostgresInvoicePreparer(catalog, rates), catalog);
    scanner = new ChainScanner(pool, catalog, {});
    const inserted = await pool.query<{ id: string; name: string }>("INSERT INTO merchants (name) VALUES ('Orbit Store') RETURNING id, name");
    merchant = inserted.rows[0]!;
    await services.updateWallets(merchant, [
      { asset: 'BTC', network: 'bitcoin', extended_public_key: zpub },
      { asset: 'TRX', network: 'tron', extended_public_key: tronXpub },
      { asset: 'SOL', network: 'solana', address: solanaAddress },
    ]);
    hook = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        received.push({ body, signature: String(request.headers['orbitt-signature']) });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const port = (hook.address() as { port: number }).port;
    signingSecret = (await services.setWebhook(merchant, `http://127.0.0.1:${port}/hooks`, false)).signing_secret!;
  });

  afterAll(async () => {
    await new Promise((resolve) => hook?.close(resolve));
    await pool?.end();
  });

  const openInvoice = async (id: string) => (await pool.query<OpenInvoice>(
    `SELECT id, merchant_id, crypto_amount_base_units, received_amount_base_units, surplus_base_units, asset, network, address,
     address_mode, status, expires_at, created_at, payment_selected_at FROM invoices WHERE id = $1`, [id],
  )).rows[0]!;
  const events = async (id: string) => (await pool.query<{ event_type: string }>(
    'SELECT event_type FROM webhook_deliveries WHERE invoice_id = $1 ORDER BY created_at, id', [id],
  )).rows.map((row) => row.event_type);

  it('lets the customer choose a coin, then tracks partial, full and confirmed payment', async () => {
    const created = await services.createInvoice(merchant, 'order-1001', { amount: '25.00', currency: 'EUR', order_id: '1001' });
    expect(created.status).toBe('created');
    expect(created.asset).toBeNull();
    expect(await services.createInvoice(merchant, 'order-1001', { amount: '25.00', currency: 'EUR', order_id: '1001' })).toEqual(created);

    const publicView = await services.getPublicInvoice(created.id);
    expect(publicView!.payment_options.map((option) => `${option.asset}:${option.network}`))
      .toEqual(['BTC:bitcoin', 'TRX:tron', 'USDT:tron', 'SOL:solana', 'USDC:solana', 'USDT:solana']);

    const selected = await services.selectPublicPayment(created.id, 'btc', 'bitcoin');
    expect(selected).toMatchObject({ status: 'awaiting_payment', crypto_amount: '0.0005', address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', payment_options: [] });
    await expect(services.selectPublicPayment(created.id, 'SOL', 'solana')).rejects.toMatchObject({ code: 'payment_already_selected' });

    const transfer = (id: string, amount: bigint, confirmations: bigint) => ({
      transactionId: id, asset: 'BTC', network: 'bitcoin', address: selected!.address!, amountBaseUnits: amount,
      blockNumber: confirmations ? 900_000n : null, confirmations, observedAt: new Date(),
    });
    await scanner.applyTransfers(await openInvoice(created.id), [transfer('a'.repeat(64), 20_000n, 0n)], 'bitcoin');
    expect((await openInvoice(created.id)).status).toBe('underpaid');
    expect((await services.getPublicInvoice(created.id))!.remaining_amount).toBe('0.0003');

    await scanner.applyTransfers(await openInvoice(created.id), [transfer('b'.repeat(64), 30_000n, 1n)], 'bitcoin');
    expect((await openInvoice(created.id)).status).toBe('confirming');
    // The first transfer is still unconfirmed, so the invoice waits for both to reach 2 on Bitcoin.
    expect(await services.getPublicInvoice(created.id)).toMatchObject({
      status: 'confirming', confirmations: 0, required_confirmations: 2, confirmation_eta_seconds: 1200,
      transactions: [{ amount: '0.0002', confirmations: 0 }, { amount: '0.0003', confirmations: 1 }],
    });

    await scanner.applyTransfers(await openInvoice(created.id), [transfer('a'.repeat(64), 20_000n, 3n), transfer('b'.repeat(64), 30_000n, 2n)], 'bitcoin');
    const paid = await services.getInvoiceDetail(merchant, created.id);
    expect(paid!.invoice).toMatchObject({ status: 'paid', received_amount: '0.0005', surplus_amount: '0', confirmations: 2, required_confirmations: 2 });
    expect(paid!.derivation_path).toBe("m/84'/0'/0'/0/0");
    expect(paid!.payments).toHaveLength(2);
    expect((await services.getPublicInvoice(created.id))!.confirmation_eta_seconds).toBeNull();
    expect(await events(created.id)).toEqual(['invoice.created', 'invoice.detected', 'invoice.underpaid', 'invoice.confirming', 'invoice.paid']);
  });

  it('delivers signed webhooks that verify with the merchant secret', async () => {
    const worker = new WebhookWorker(pool, process.env.APP_ENCRYPTION_KEY!);
    while (await worker.runOnce()) { /* drain the outbox */ }
    expect(received.length).toBeGreaterThanOrEqual(4);
    const paidEvent = received.find((item) => JSON.parse(item.body).event === 'invoice.paid')!;
    expect(verifyWebhookSignature(signingSecret, paidEvent.body, paidEvent.signature)).toBe(true);
    expect(JSON.parse(paidEvent.body).invoice).toMatchObject({ status: 'paid', received_amount: '0.0005', order_id: '1001' });
  });

  it('gives each open invoice on a shared Solana address a unique amount and matches by amount', async () => {
    const first = await services.createInvoice(merchant, 'sol-1', { amount: '10', currency: 'EUR', asset: 'SOL', network: 'solana' });
    const second = await services.createInvoice(merchant, 'sol-2', { amount: '10', currency: 'EUR', asset: 'SOL', network: 'solana' });
    expect(first.address).toBe(solanaAddress);
    expect(second.address).toBe(solanaAddress);
    expect(first.crypto_amount).not.toBe(second.crypto_amount);
    const secondRow = await openInvoice(second.id);
    await scanner.applyTransfers(secondRow, [{
      transactionId: '5'.repeat(88), asset: 'SOL', network: 'solana', address: solanaAddress,
      amountBaseUnits: BigInt(secondRow.crypto_amount_base_units), blockNumber: 1n, confirmations: 1n, observedAt: new Date(),
    }], 'solana');
    expect((await openInvoice(second.id)).status).toBe('paid');
    expect((await openInvoice(first.id)).status).toBe('awaiting_payment');
  });

  it('derives TRC-20 addresses from the TRX wallet without reusing earlier addresses', async () => {
    const trx = await services.createInvoice(merchant, 'trx-1', { amount: '5', currency: 'EUR', asset: 'TRX', network: 'tron' });
    const usdt = await services.createInvoice(merchant, 'usdt-1', { amount: '5', currency: 'EUR', asset: 'USDT', network: 'tron' });
    expect(trx.address).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
    expect(usdt.address).not.toBe(trx.address);
    expect(usdt.crypto_amount).toBe('5');
    // Re-entering the same key resets nothing; replacing it while invoices are open is refused.
    await expect(services.updateWallets(merchant, [{ asset: 'TRX', network: 'tron', extended_public_key: zpub }])).rejects.toMatchObject({ code: 'wallet_in_use' });
    await expect(services.updateWallets(merchant, [{ asset: 'USDT', network: 'tron', extended_public_key: tronXpub }])).rejects.toMatchObject({ code: 'wallet_asset_mismatch' });
  });

  it('expires unpaid invoices and only flags genuinely new funds as late payments', async () => {
    const invoice = await services.createInvoice(merchant, 'late-1', { amount: '10', currency: 'EUR', asset: 'BTC', network: 'bitcoin' });
    const row = await openInvoice(invoice.id);
    const short = { transactionId: 'c'.repeat(64), asset: 'BTC', network: 'bitcoin', address: row.address, amountBaseUnits: 1_000n, blockNumber: 900_001n, confirmations: 3n, observedAt: new Date() };
    await scanner.applyTransfers(row, [short], 'bitcoin');
    await pool.query("UPDATE invoices SET expires_at = now() - interval '1 minute' WHERE id = $1", [invoice.id]);
    await scanner.runOnce();
    expect((await openInvoice(invoice.id)).status).toBe('expired');

    await scanner.applyTransfers(await openInvoice(invoice.id), [short], 'bitcoin');
    expect((await openInvoice(invoice.id)).status).toBe('expired');

    await scanner.applyTransfers(await openInvoice(invoice.id), [{ ...short, transactionId: 'd'.repeat(64), amountBaseUnits: 19_000n }], 'bitcoin');
    expect((await openInvoice(invoice.id)).status).toBe('late_payment');
    expect(await events(invoice.id)).toEqual(['invoice.created', 'invoice.detected', 'invoice.underpaid', 'invoice.expired', 'invoice.late_payment']);
  });

  it('ignores chain history that predates the invoice on a pre-used address', async () => {
    const invoice = await services.createInvoice(merchant, 'history-1', { amount: '10', currency: 'EUR', asset: 'BTC', network: 'bitcoin' });
    const row = await openInvoice(invoice.id);
    const old = { transactionId: 'e'.repeat(64), asset: 'BTC', network: 'bitcoin', address: row.address, amountBaseUnits: 20_000n, blockNumber: 800_000n, confirmations: 900n, observedAt: new Date('2024-01-01T00:00:00Z') };
    const { transferIsEligible } = await import('../../apps/worker/src/chain-scanner.js');
    expect(transferIsEligible(row, old, 'utxo')).toBe(false);
  });

  it('serves dashboard overview, assets and redelivery', async () => {
    const overview = await services.getDashboardOverview(merchant) as { summary: { paid: number }; volume: unknown[] };
    expect(overview.summary.paid).toBeGreaterThanOrEqual(2);
    expect(overview.volume.length).toBeGreaterThan(0);
    const assets = await services.getAssets(merchant);
    expect(assets.find((asset) => asset.asset === 'USDT' && asset.network === 'tron')?.available).toBe(true);
    expect(assets.find((asset) => asset.asset === 'ETH' && asset.network === 'ethereum')?.available).toBe(false);
    const deliveries = await services.listDashboardWebhooks(merchant);
    expect(await services.redeliverWebhook(merchant, deliveries[0]!.id as string)).toBe(true);
    const search = await services.listInvoices(merchant, { limit: 10, search: '1001' });
    expect(search.data).toHaveLength(1);
  });

  it('pages through invoices created within the same millisecond without skipping any', async () => {
    const other = (await pool.query<{ id: string; name: string }>("INSERT INTO merchants (name) VALUES ('Paging Store') RETURNING id, name")).rows[0]!;
    await pool.query(
      `INSERT INTO invoices (merchant_id, request_amount, request_currency, expires_at, created_at)
       SELECT $1, '1', 'EUR', now() + interval '1 hour', '2026-01-01T00:00:00.123Z'::timestamptz + (g * interval '1 microsecond')
       FROM generate_series(1, 7) g`, [other.id],
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await services.listInvoices(other, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.data.map((invoice) => invoice.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('filters invoices by several statuses at once', async () => {
    const open = await services.listInvoices(merchant, { limit: 100, status: ['awaiting_payment', 'created'] });
    expect(open.data.length).toBeGreaterThan(0);
    expect(open.data.every((invoice) => ['awaiting_payment', 'created'].includes(invoice.status))).toBe(true);
  });
});
