import type { Pool, PoolClient } from 'pg';
import { EvmWatcher, EsploraWatcher } from '@orbitt/chains';
import type { ChainTransfer } from '@orbitt/chains';
import { recordPayment } from '@orbitt/core';
import type { Invoice, InvoiceStatus } from '@orbitt/core';

interface OpenInvoice {
  id: string;
  merchant_id: string;
  order_id: string | null;
  request_amount: string;
  request_currency: string;
  crypto_amount: string;
  crypto_amount_base_units: string;
  received_amount_base_units: string;
  surplus_base_units: string;
  asset: string;
  network: string;
  address: string;
  status: InvoiceStatus;
  expires_at: Date;
  created_at: Date;
  metadata: Record<string, unknown>;
}

const OPEN_STATUSES = "'created', 'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid'";
const EVM_NETWORKS: Record<string, { chainId: number; nativeAsset: string; env: string }> = {
  'ethereum-sepolia': { chainId: 11155111, nativeAsset: 'ETH', env: 'SEPOLIA_RPC_URL' },
  ethereum: { chainId: 1, nativeAsset: 'ETH', env: 'ETHEREUM_RPC_URL' },
  base: { chainId: 8453, nativeAsset: 'ETH', env: 'BASE_RPC_URL' },
  arbitrum: { chainId: 42161, nativeAsset: 'ETH', env: 'ARBITRUM_RPC_URL' },
  optimism: { chainId: 10, nativeAsset: 'ETH', env: 'OPTIMISM_RPC_URL' },
  polygon: { chainId: 137, nativeAsset: 'ETH', env: 'POLYGON_RPC_URL' },
  'bnb-chain': { chainId: 56, nativeAsset: 'ETH', env: 'BNB_RPC_URL' },
};
const REQUIRED_CONFIRMATIONS: Record<string, bigint> = {
  bitcoin: 2n, 'bitcoin-testnet': 2n, litecoin: 6n,
  'ethereum-sepolia': 2n, ethereum: 12n, base: 1n, arbitrum: 1n, optimism: 1n, polygon: 1n, 'bnb-chain': 1n,
};
const MAX_EVM_BLOCKS_PER_SCAN = 100n;
const SCAN_INTERVAL_MS = 10_000;
const LATE_PAYMENT_WINDOW_HOURS = 24;

function endpoints(variableName: string): string[] {
  return (process.env[variableName] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function requiredConfirmations(network: string): bigint {
  const override = process.env[`CONFIRMATIONS_${network.toUpperCase().replace(/-/g, '_')}`];
  if (override !== undefined && /^\d+$/.test(override)) return BigInt(override);
  return REQUIRED_CONFIRMATIONS[network] ?? 1n;
}

function toDomainInvoice(row: OpenInvoice): Invoice {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    orderId: row.order_id,
    fiatAmount: null,
    fiatCurrency: null,
    rateUsed: null,
    rateTimestamp: null,
    cryptoAmountBaseUnits: BigInt(row.crypto_amount_base_units),
    receivedAmountBaseUnits: BigInt(row.received_amount_base_units),
    surplusBaseUnits: BigInt(row.surplus_base_units),
    asset: row.asset,
    network: row.network,
    address: row.address,
    derivationPath: null,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.created_at,
    metadata: row.metadata ?? {},
  };
}

export function resolvePaymentStatus(row: OpenInvoice, total: bigint, confirmationsMet: boolean, at = new Date()): ReturnType<typeof recordPayment> {
  return recordPayment(toDomainInvoice(row), total, confirmationsMet, at);
}

export class ChainScanner {
  private nextScanAt = 0;

  constructor(private readonly pool: Pool) {}

  async runOnce(): Promise<boolean> {
    const now = Date.now();
    if (now < this.nextScanAt) return false;
    this.nextScanAt = now + SCAN_INTERVAL_MS;
    await this.expireInvoices();
    const openInvoices = await this.loadScannableInvoices();
    let didWork = false;

    const utxoGroups = groupInvoices(openInvoices.filter((invoice) => ['bitcoin', 'bitcoin-testnet', 'litecoin'].includes(invoice.network)));
    for (const [network, invoices] of utxoGroups) {
      const variable = network === 'litecoin' ? 'LITECOIN_RPC_URL'
        : network === 'bitcoin-testnet' ? 'BITCOIN_TESTNET_EXPLORER_URL' : 'BITCOIN_RPC_URL';
      const apiBases = endpoints(variable);
      if (!apiBases.length) continue;
      const asset = invoices[0]!.asset;
      const watcher = new EsploraWatcher({ asset: asset as 'BTC' | 'LTC', network, apiBases });
      const head = await watcher.getHeadBlock();
      for (let start = 0; start < invoices.length; start += 8) {
        const batch = invoices.slice(start, start + 8);
        const scanned = await Promise.allSettled(batch.map(async (invoice) => ({
          invoice,
          // Unique invoice addresses have short histories. Re-scan their address history to refresh confirmations.
          result: await watcher.scanAddress(invoice.address, head),
        })));
        for (const item of scanned) {
          if (item.status !== 'fulfilled') continue;
          for (const transfer of item.value.result.transfers) {
            await this.recordTransfer(item.value.invoice.id, transfer, requiredConfirmations(network));
            didWork = true;
          }
        }
      }
    }

    const evmGroups = groupInvoices(openInvoices.filter((invoice) => EVM_NETWORKS[invoice.network]?.nativeAsset === invoice.asset));
    for (const [network, invoices] of evmGroups) {
      const config = EVM_NETWORKS[network]!;
      const rpcUrls = endpoints(config.env);
      if (!rpcUrls.length) continue;
      const watcher = new EvmWatcher({ network, nativeAsset: config.nativeAsset, chainId: config.chainId, rpcUrls });
      try {
        await watcher.validateNetwork();
        const head = await watcher.getHeadBlock();
        const cursor = await this.getOrInitializeCursor(network, head);
        const from = cursor + 1n;
        const to = from > head ? head : minBigInt(head, from + MAX_EVM_BLOCKS_PER_SCAN - 1n);
        if (to >= from) {
          const transfers = watcher.withConfirmations(
            await watcher.scanBlockRange(from, to, invoices.map((invoice) => invoice.address)),
            head,
          );
          const invoiceByAddress = new Map(invoices.map((invoice) => [invoice.address.toLowerCase(), invoice]));
          for (const transfer of transfers) {
            const invoice = invoiceByAddress.get(transfer.address.toLowerCase());
            if (invoice) await this.recordTransfer(invoice.id, transfer, requiredConfirmations(network));
            didWork = true;
          }
          if (to > cursor) await this.storeCursor(network, to);
        }
        await this.refreshEvmConfirmations(network, head, invoices, requiredConfirmations(network));
      } catch {
        // Keep the durable block cursor unchanged so the same range is retried.
      }
    }
    return didWork;
  }

  private async loadScannableInvoices(): Promise<OpenInvoice[]> {
    const result = await this.pool.query<OpenInvoice>(
      `SELECT id, merchant_id, order_id, request_amount, request_currency, crypto_amount,
       crypto_amount_base_units, received_amount_base_units, surplus_base_units, asset, network,
       address, status, expires_at, created_at, metadata
       FROM invoices
       WHERE (status IN (${OPEN_STATUSES}) OR (status IN ('expired', 'cancelled') AND updated_at > now() - ($1 * interval '1 hour')))
         AND address IS NOT NULL
       ORDER BY created_at`, [LATE_PAYMENT_WINDOW_HOURS],
    );
    return result.rows;
  }

  private async expireInvoices(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const expired = await client.query<{ id: string }>(
        `UPDATE invoices SET status = 'expired', updated_at = now()
         WHERE status IN ('created', 'awaiting_payment', 'underpaid') AND expires_at <= now()
         RETURNING id`,
      );
      for (const row of expired.rows) await enqueueInvoiceEvent(client, row.id, 'invoice.expired');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordTransfer(invoiceId: string, transfer: ChainTransfer, required: bigint): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<OpenInvoice>(
        `SELECT id, merchant_id, order_id, request_amount, request_currency, crypto_amount,
         crypto_amount_base_units, received_amount_base_units, surplus_base_units, asset, network,
         address, status, expires_at, created_at, metadata
         FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId],
      );
      const invoice = result.rows[0];
      if (!invoice || invoice.asset !== transfer.asset || invoice.network !== transfer.network || invoice.address !== transfer.address) {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `INSERT INTO invoice_payments (invoice_id, transaction_id, asset, amount_base_units, confirmations, block_number, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (invoice_id, transaction_id, asset) DO UPDATE SET
           amount_base_units = EXCLUDED.amount_base_units,
           confirmations = EXCLUDED.confirmations,
           block_number = EXCLUDED.block_number,
           observed_at = EXCLUDED.observed_at,
           updated_at = now()`,
        [invoiceId, transfer.transactionId, transfer.asset, transfer.amountBaseUnits.toString(), transfer.confirmations.toString(), transfer.blockNumber?.toString() ?? null, transfer.observedAt],
      );
      const totals = await client.query<{ total: string; confirmations_met: boolean }>(
        `SELECT coalesce(sum(amount_base_units::numeric), 0)::text AS total,
         coalesce(bool_and(confirmations >= $2::bigint), false) AS confirmations_met
         FROM invoice_payments WHERE invoice_id = $1`, [invoiceId, required.toString()],
      );
      const total = BigInt(totals.rows[0]!.total);
      await applyPaymentState(client, invoice, total, totals.rows[0]!.confirmations_met, transfer.observedAt);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async refreshEvmConfirmations(network: string, head: bigint, invoices: OpenInvoice[], required: bigint): Promise<void> {
    if (!invoices.length) return;
    await this.pool.query(
      `UPDATE invoice_payments p SET confirmations = CASE
         WHEN $2::bigint >= p.block_number THEN $2::bigint - p.block_number + 1 ELSE 0 END,
         updated_at = now()
       FROM invoices i WHERE p.invoice_id = i.id AND i.network = $1 AND p.block_number IS NOT NULL
         AND i.id = ANY($3::uuid[])`,
      [network, head.toString(), invoices.map((invoice) => invoice.id)],
    );
    for (const invoice of invoices) await this.recomputeInvoice(invoice.id, required);
  }

  private async recomputeInvoice(invoiceId: string, required: bigint): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<OpenInvoice>(
        `SELECT id, merchant_id, order_id, request_amount, request_currency, crypto_amount,
         crypto_amount_base_units, received_amount_base_units, surplus_base_units, asset, network,
         address, status, expires_at, created_at, metadata
         FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId],
      );
      const invoice = selected.rows[0];
      if (invoice) {
        const totals = await client.query<{ total: string; confirmations_met: boolean }>(
          `SELECT coalesce(sum(amount_base_units::numeric), 0)::text AS total,
           coalesce(bool_and(confirmations >= $2::bigint), false) AS confirmations_met
           FROM invoice_payments WHERE invoice_id = $1`, [invoiceId, required.toString()],
        );
        await applyPaymentState(client, invoice, BigInt(totals.rows[0]!.total), totals.rows[0]!.confirmations_met, new Date());
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async getOrInitializeCursor(network: string, head: bigint): Promise<bigint> {
    const seeded = head > 99n ? head - 100n : 0n;
    const result = await this.pool.query<{ cursor_block: string }>(
      `INSERT INTO chain_scan_cursors (network, cursor_block) VALUES ($1, $2)
       ON CONFLICT (network) DO UPDATE SET updated_at = now()
       RETURNING cursor_block::text`, [network, seeded.toString()],
    );
    return BigInt(result.rows[0]!.cursor_block);
  }

  private async storeCursor(network: string, block: bigint): Promise<void> {
    await this.pool.query(
      `INSERT INTO chain_scan_cursors (network, cursor_block) VALUES ($1, $2)
       ON CONFLICT (network) DO UPDATE SET cursor_block = GREATEST(chain_scan_cursors.cursor_block, EXCLUDED.cursor_block), updated_at = now()`,
      [network, block.toString()],
    );
  }
}

function groupInvoices(invoices: OpenInvoice[]): Map<string, OpenInvoice[]> {
  const result = new Map<string, OpenInvoice[]>();
  for (const invoice of invoices) result.set(invoice.network, [...(result.get(invoice.network) ?? []), invoice]);
  return result;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

async function enqueueInvoiceEvent(client: PoolClient, invoiceId: string, eventType: string): Promise<void> {
  const selected = await client.query<OpenInvoice & { webhook_url: string | null; default_webhook_url: string | null; webhook_secret_ciphertext: string | null }>(
    `SELECT i.id, i.merchant_id, i.order_id, i.request_amount, i.request_currency, i.crypto_amount,
     i.crypto_amount_base_units, i.received_amount_base_units, i.surplus_base_units, i.asset, i.network,
     i.address, i.status, i.expires_at, i.created_at, i.metadata, i.webhook_url,
     m.default_webhook_url, m.webhook_secret_ciphertext
     FROM invoices i JOIN merchants m ON m.id = i.merchant_id WHERE i.id = $1`, [invoiceId],
  );
  const row = selected.rows[0];
  const targetUrl = row?.webhook_url ?? row?.default_webhook_url ?? null;
  if (!row || !targetUrl || !row.webhook_secret_ciphertext) return;
  const invoice = {
    id: row.id,
    order_id: row.order_id,
    amount: row.request_amount,
    currency: row.request_currency,
    crypto_amount: row.crypto_amount,
    asset: row.asset,
    network: row.network,
    address: row.address,
    status: row.status,
    checkout_url: `${process.env.CHECKOUT_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173'}/checkout/${row.id}`,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    metadata: row.metadata ?? {},
  };
  await client.query(
    `INSERT INTO webhook_deliveries (merchant_id, invoice_id, event_type, target_url, secret_ciphertext, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.merchant_id, invoiceId, eventType, targetUrl, row.webhook_secret_ciphertext, JSON.stringify({ event: eventType, created_at: new Date().toISOString(), invoice })],
  );
}

async function applyPaymentState(
  client: PoolClient,
  invoice: OpenInvoice,
  total: bigint,
  confirmationsMet: boolean,
  at: Date,
): Promise<void> {
  if (total === 0n) return;
  const expected = BigInt(invoice.crypto_amount_base_units);
  const priorStatus = invoice.status;
  const domainInvoice = toDomainInvoice(invoice);
  const updated = priorStatus === 'paid'
    ? { ...domainInvoice, receivedAmountBaseUnits: total, surplusBaseUnits: total > expected ? total - expected : 0n }
    : resolvePaymentStatus(invoice, total, confirmationsMet, at);
  if (updated.status === priorStatus && total.toString() === invoice.received_amount_base_units
    && updated.surplusBaseUnits.toString() === invoice.surplus_base_units) return;

  await client.query(
    `UPDATE invoices SET status = $2, received_amount_base_units = $3, surplus_base_units = $4, updated_at = now()
     WHERE id = $1`, [invoice.id, updated.status, total.toString(), updated.surplusBaseUnits.toString()],
  );
  if (priorStatus === 'awaiting_payment' && ['detected', 'underpaid', 'confirming', 'overpaid', 'paid'].includes(updated.status)) {
    await enqueueInvoiceEvent(client, invoice.id, 'invoice.detected');
  }
  if (updated.status !== priorStatus && ['paid', 'underpaid', 'overpaid', 'late_payment'].includes(updated.status)) {
    await enqueueInvoiceEvent(client, invoice.id, `invoice.${updated.status}`);
  }
}
