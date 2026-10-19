import type { Pool, PoolClient } from 'pg';
import { associatedTokenAddress, EsploraWatcher, EvmWatcher, SolanaWatcher, TronWatcher } from '@orbitt/chains';
import type { ChainTransfer, SolanaWatchTarget } from '@orbitt/chains';
import { findAsset, recordPayment, requiredConfirmations } from '@orbitt/core';
import type { AssetDefinition, Invoice, InvoiceStatus } from '@orbitt/core';
import { enqueueInvoiceEvent } from '@orbitt/webhooks';

export interface OpenInvoice {
  id: string;
  merchant_id: string;
  crypto_amount_base_units: string;
  received_amount_base_units: string;
  surplus_base_units: string;
  asset: string;
  network: string;
  address: string;
  address_mode: 'derived' | 'shared';
  status: InvoiceStatus;
  expires_at: Date;
  created_at: Date;
  payment_selected_at: Date | null;
  required_confirmations: number | null;
}

export interface ScannerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

const SCANNABLE_STATUSES = "'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid'";
const INVOICE_SELECT = `id, merchant_id, crypto_amount_base_units, received_amount_base_units, surplus_base_units,
  asset, network, address, address_mode, status, expires_at, created_at, payment_selected_at, required_confirmations`;

export const EVM_CHAINS: Readonly<Record<string, { chainId: number; env: string }>> = {
  ethereum: { chainId: 1, env: 'ETHEREUM_RPC_URL' },
  'ethereum-sepolia': { chainId: 11155111, env: 'SEPOLIA_RPC_URL' },
  base: { chainId: 8453, env: 'BASE_RPC_URL' },
  arbitrum: { chainId: 42161, env: 'ARBITRUM_RPC_URL' },
  optimism: { chainId: 10, env: 'OPTIMISM_RPC_URL' },
  polygon: { chainId: 137, env: 'POLYGON_RPC_URL' },
  'bnb-chain': { chainId: 56, env: 'BNB_RPC_URL' },
};

const UTXO_ENDPOINT_ENV: Readonly<Record<string, readonly string[]>> = {
  bitcoin: ['BITCOIN_ESPLORA_URL', 'BITCOIN_RPC_URL'],
  'bitcoin-testnet': ['BITCOIN_TESTNET_ESPLORA_URL', 'BITCOIN_TESTNET_EXPLORER_URL'],
  litecoin: ['LITECOIN_ESPLORA_URL', 'LITECOIN_RPC_URL'],
};

/** How far a transfer's chain timestamp may predate the invoice's coin selection and still count. */
const TIMESTAMP_SLACK_MS: Readonly<Record<AssetDefinition['family'], number>> = {
  utxo: 2 * 60 * 60_000, // Bitcoin block timestamps may lag real time by up to two hours.
  evm: Number.POSITIVE_INFINITY, // EVM is scanned by block range, so no historic transfers are read.
  tron: 10 * 60_000,
  solana: 5 * 60_000,
};

const MAX_EVM_BLOCKS_PER_SCAN = 100n;
const SCAN_INTERVAL_MS = 10_000;
const LATE_PAYMENT_WINDOW_HOURS = 24;

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  // Provider URLs can embed API keys; never persist them.
  return message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const group = result.get(key(item));
    if (group) group.push(item);
    else result.set(key(item), [item]);
  }
  return result;
}

function toDomainInvoice(row: OpenInvoice): Invoice {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    orderId: null,
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
    metadata: {},
  };
}

export function resolvePaymentStatus(row: OpenInvoice, total: bigint, confirmationsMet: boolean, at = new Date()): Invoice {
  return recordPayment(toDomainInvoice(row), total, confirmationsMet, at);
}

/**
 * Whether a transfer can belong to an invoice: it must not predate the moment the customer
 * received the address/amount (minus clock slack), so earlier history on a reused or
 * pre-used address is never counted as payment.
 */
export function transferIsEligible(invoice: Pick<OpenInvoice, 'payment_selected_at' | 'created_at'>, transfer: ChainTransfer, family: AssetDefinition['family']): boolean {
  // Watchers stamp unconfirmed transfers with the current time, so they always pass.
  const selectedAt = (invoice.payment_selected_at ?? invoice.created_at).getTime();
  return transfer.observedAt.getTime() >= selectedAt - TIMESTAMP_SLACK_MS[family];
}

export class ChainScanner {
  private nextScanAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly catalog: readonly AssetDefinition[],
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly log: ScannerLogger = { info: () => undefined, warn: () => undefined },
  ) {}

  private endpoints(...names: readonly string[]): string[] {
    for (const name of names) {
      const values = (this.env[name] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      if (values.length) return values;
    }
    return [];
  }

  private requiredConfirmations(invoice: OpenInvoice, network: string): number {
    // The count fixed at coin selection wins, so a later config change never moves the goalposts.
    return invoice.required_confirmations ?? requiredConfirmations(network, this.env);
  }

  private family(network: string): AssetDefinition['family'] | undefined {
    return this.catalog.find((asset) => asset.network === network)?.family;
  }

  async runOnce(): Promise<boolean> {
    const now = Date.now();
    if (now < this.nextScanAt) return false;
    this.nextScanAt = now + SCAN_INTERVAL_MS;
    await this.expireInvoices();
    const invoices = await this.loadScannableInvoices();
    const byNetwork = groupBy(invoices, (invoice) => invoice.network);
    const networks = new Set(this.catalog.filter((asset) => asset.enabled).map((asset) => asset.network));
    let didWork = false;
    for (const network of networks) {
      const family = this.family(network)!;
      const open = byNetwork.get(network) ?? [];
      try {
        let head: bigint | null;
        if (family === 'utxo') head = await this.scanUtxo(network, open);
        else if (family === 'evm') head = await this.scanEvm(network, open);
        else if (family === 'tron') head = await this.scanTron(network, open);
        else head = await this.scanSolana(network, open);
        if (head === null) continue; // network not configured on this worker
        await this.heartbeat(network, head, null);
        didWork ||= open.length > 0;
      } catch (error) {
        const message = sanitizeError(error);
        this.log.warn('chain scan failed', { network, error: message });
        await this.heartbeat(network, null, message).catch(() => undefined);
      }
    }
    return didWork;
  }

  private async heartbeat(network: string, head: bigint | null, error: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO network_scanner_status (network, head_block, last_scan_at, last_error) VALUES ($1, $2, now(), $3)
       ON CONFLICT (network) DO UPDATE SET head_block = COALESCE(EXCLUDED.head_block, network_scanner_status.head_block),
         last_scan_at = now(), last_error = EXCLUDED.last_error`,
      [network, head?.toString() ?? null, error],
    );
  }

  private async scanUtxo(network: string, invoices: OpenInvoice[]): Promise<bigint | null> {
    const apiBases = this.endpoints(...(UTXO_ENDPOINT_ENV[network] ?? []));
    if (!apiBases.length) return null;
    const native = this.catalog.find((asset) => asset.network === network && asset.contract === null)!;
    const watcher = new EsploraWatcher({ asset: native.asset as 'BTC' | 'LTC', network, apiBases });
    const head = await watcher.getHeadBlock();
    for (let start = 0; start < invoices.length; start += 8) {
      const batch = invoices.slice(start, start + 8);
      // Invoice addresses are unique and short-lived, so re-reading their history also refreshes confirmations.
      const scanned = await Promise.allSettled(batch.map(async (invoice) => ({ invoice, result: await watcher.scanAddress(invoice.address, head) })));
      for (const item of scanned) {
        if (item.status === 'rejected') {
          this.log.warn('address scan failed', { network, error: sanitizeError(item.reason) });
          continue;
        }
        const { invoice, result } = item.value;
        await this.applyTransfers(invoice, result.transfers.filter((transfer) => transferIsEligible(invoice, transfer, 'utxo')), network);
      }
    }
    return head;
  }

  private async scanEvm(network: string, invoices: OpenInvoice[]): Promise<bigint | null> {
    const chain = EVM_CHAINS[network];
    const rpcUrls = chain ? this.endpoints(chain.env) : [];
    if (!chain || !rpcUrls.length) return null;
    const assets = this.catalog.filter((asset) => asset.network === network);
    const native = assets.find((asset) => asset.contract === null)!;
    const openAssets = new Set(invoices.map((invoice) => invoice.asset));
    const tokens = assets.filter((asset) => asset.contract && openAssets.has(asset.asset))
      .map((asset) => ({ asset: asset.asset, contractAddress: asset.contract! }));
    const watcher = new EvmWatcher({ network, nativeAsset: native.asset, chainId: chain.chainId, rpcUrls, tokens });
    await watcher.validateNetwork();
    const head = await watcher.getHeadBlock();
    if (!invoices.length) {
      // Nothing to watch: keep the cursor at the tip so a new invoice never triggers a long catch-up.
      await this.storeCursor(network, head, true);
      return head;
    }
    const cursor = await this.getOrInitializeCursor(network, head);
    const from = cursor + 1n;
    const to = minBigInt(head, from + MAX_EVM_BLOCKS_PER_SCAN - 1n);
    if (to >= from) {
      const addresses = [...new Set(invoices.map((invoice) => invoice.address))];
      const transfers = watcher.withConfirmations(
        await watcher.scanBlockRange(from, to, addresses, { native: openAssets.has(native.asset) }),
        head,
      );
      const byAddress = groupBy(transfers, (transfer) => `${transfer.address.toLowerCase()}:${transfer.asset}`);
      for (const invoice of invoices) {
        const matched = byAddress.get(`${invoice.address.toLowerCase()}:${invoice.asset}`);
        if (matched) await this.applyTransfers(invoice, matched, network);
      }
      await this.storeCursor(network, to);
    }
    await this.refreshConfirmations(network, head, invoices);
    return head;
  }

  private async scanTron(network: string, invoices: OpenInvoice[]): Promise<bigint | null> {
    const apiBases = this.endpoints('TRON_API_URL', 'TRON_RPC_URL');
    if (!apiBases.length) return null;
    const apiKey = this.env.TRON_API_KEY;
    const apiKeyByBase = apiKey ? Object.fromEntries(apiBases.map((base) => [base, apiKey])) : undefined;
    const head = await new TronWatcher({ network, apiBases, ...(apiKeyByBase ? { apiKeyByBase } : {}) }).getSolidifiedHeadBlock();
    for (const invoice of invoices) {
      const asset = findAsset(this.catalog, invoice.asset, network);
      const tokens = asset?.contract ? [{ asset: asset.asset, contractAddress: asset.contract }] : [];
      const watcher = new TronWatcher({ network, apiBases, tokens, ...(apiKeyByBase ? { apiKeyByBase } : {}) });
      try {
        const result = await watcher.scanAddress(invoice.address, head);
        const transfers = result.transfers.filter((transfer) => transfer.asset === invoice.asset && transferIsEligible(invoice, transfer, 'tron'));
        await this.applyTransfers(invoice, transfers, network);
      } catch (error) {
        this.log.warn('address scan failed', { network, error: sanitizeError(error) });
      }
    }
    return head;
  }

  private async scanSolana(network: string, invoices: OpenInvoice[]): Promise<bigint | null> {
    const rpcUrls = this.endpoints('SOLANA_RPC_URL');
    if (!rpcUrls.length) return null;
    const watcher = new SolanaWatcher({ network, rpcUrls, commitment: 'finalized' });
    const slot = await watcher.getSlot();
    // Shared addresses: watch each (merchant address, asset) once and match transfers by exact amount.
    const groups = groupBy(invoices, (invoice) => `${invoice.address}:${invoice.asset}`);
    for (const group of groups.values()) {
      const sample = group[0]!;
      const asset = findAsset(this.catalog, sample.asset, network);
      if (!asset) continue;
      const target: SolanaWatchTarget = asset.contract
        ? { address: sample.address, watchAddress: associatedTokenAddress(sample.address, asset.contract), asset: asset.asset, kind: 'spl', mint: asset.contract, tokenDecimals: asset.decimals }
        : { address: sample.address, watchAddress: sample.address, asset: asset.asset, kind: 'native' };
      const cursor = await this.pool.query<{ cursor: string; updated_at: Date }>(
        'SELECT cursor, updated_at FROM address_scan_cursors WHERE network = $1 AND watch_address = $2', [network, target.watchAddress],
      );
      const oldest = group.reduce((min, invoice) => {
        const selected = invoice.payment_selected_at ?? invoice.created_at;
        return selected < min ? selected : min;
      }, new Date());
      const since = new Date(oldest.getTime() - TIMESTAMP_SLACK_MS.solana);
      // A cursor older than the oldest open invoice may sit behind a long history; reading
      // from `since` instead is equivalent because recording transfers is idempotent.
      const saved = cursor.rows[0];
      const savedCursor = saved && saved.updated_at >= since ? saved.cursor : undefined;
      const result = await watcher.scanTargets([target], savedCursor ? { [target.watchAddress]: savedCursor } : {}, since);
      const byAmount = groupBy(group, (invoice) => invoice.crypto_amount_base_units);
      for (const transfer of result.transfers) {
        const candidates = (byAmount.get(transfer.amountBaseUnits.toString()) ?? [])
          .filter((invoice) => transferIsEligible(invoice, transfer, 'solana'));
        // Exactly one open invoice can hold a given amount on a shared address (unique index).
        if (candidates.length === 1) await this.applyTransfers(candidates[0]!, [transfer], network);
      }
      const next = result.nextCursors[target.watchAddress];
      if (next) {
        await this.pool.query(
          `INSERT INTO address_scan_cursors (network, watch_address, cursor) VALUES ($1, $2, $3)
           ON CONFLICT (network, watch_address) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
          [network, target.watchAddress, next],
        );
      }
    }
    return slot;
  }

  private async loadScannableInvoices(): Promise<OpenInvoice[]> {
    const result = await this.pool.query<OpenInvoice>(
      `SELECT ${INVOICE_SELECT}
       FROM invoices
       WHERE (status IN (${SCANNABLE_STATUSES})
          OR (status IN ('expired', 'cancelled', 'late_payment', 'paid') AND updated_at > now() - ($1 * interval '1 hour')))
         AND address IS NOT NULL AND asset IS NOT NULL AND network IS NOT NULL AND crypto_amount_base_units IS NOT NULL
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
      for (const row of expired.rows) await enqueueInvoiceEvent(client, this.catalog, row.id, 'invoice.expired');
      await client.query('COMMIT');
      if (expired.rowCount) this.log.info('invoices expired', { count: expired.rowCount });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Records transfers for one invoice and recomputes its state in a single transaction. */
  async applyTransfers(invoice: OpenInvoice, transfers: readonly ChainTransfer[], network: string): Promise<void> {
    const relevant = transfers.filter((transfer) => transfer.asset === invoice.asset && transfer.network === invoice.network
      && transfer.address.toLowerCase() === invoice.address.toLowerCase());
    if (!relevant.length) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<OpenInvoice>(`SELECT ${INVOICE_SELECT} FROM invoices WHERE id = $1 FOR UPDATE`, [invoice.id]);
      const current = locked.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return;
      }
      for (const transfer of relevant) {
        await client.query(
          `INSERT INTO invoice_payments (invoice_id, transaction_id, asset, amount_base_units, confirmations, block_number, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (invoice_id, transaction_id, asset) DO UPDATE SET
             amount_base_units = EXCLUDED.amount_base_units,
             confirmations = GREATEST(invoice_payments.confirmations, EXCLUDED.confirmations),
             block_number = COALESCE(EXCLUDED.block_number, invoice_payments.block_number),
             updated_at = now()`,
          [invoice.id, transfer.transactionId, transfer.asset, transfer.amountBaseUnits.toString(), transfer.confirmations.toString(),
            transfer.blockNumber?.toString() ?? null, transfer.observedAt],
        );
      }
      await this.recompute(client, current, network, relevant.at(-1)!.observedAt);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async recompute(client: PoolClient, invoice: OpenInvoice, network: string, at: Date): Promise<void> {
    const totals = await client.query<{ total: string; confirmations_met: boolean }>(
      `SELECT coalesce(sum(amount_base_units::numeric), 0)::text AS total,
       coalesce(bool_and(confirmations >= $2::bigint), false) AS confirmations_met
       FROM invoice_payments WHERE invoice_id = $1`, [invoice.id, this.requiredConfirmations(invoice, network).toString()],
    );
    const total = BigInt(totals.rows[0]!.total);
    if (total === 0n) return;
    const updated = resolvePaymentStatus(invoice, total, totals.rows[0]!.confirmations_met, at);
    if (updated.status === invoice.status && total.toString() === invoice.received_amount_base_units
      && updated.surplusBaseUnits.toString() === invoice.surplus_base_units) return;

    await client.query(
      `UPDATE invoices SET status = $2, received_amount_base_units = $3, surplus_base_units = $4, updated_at = now()
       WHERE id = $1`, [invoice.id, updated.status, total.toString(), updated.surplusBaseUnits.toString()],
    );
    if (updated.status !== invoice.status) {
      this.log.info('invoice status changed', { invoice: invoice.id, from: invoice.status, to: updated.status });
      if (invoice.status === 'awaiting_payment') await enqueueInvoiceEvent(client, this.catalog, invoice.id, 'invoice.detected');
      if (['confirming', 'paid', 'underpaid', 'overpaid', 'late_payment'].includes(updated.status)) {
        await enqueueInvoiceEvent(client, this.catalog, invoice.id, `invoice.${updated.status}`);
      }
      if (updated.status === 'paid' && updated.surplusBaseUnits > 0n && invoice.status !== 'overpaid') {
        await enqueueInvoiceEvent(client, this.catalog, invoice.id, 'invoice.overpaid');
      }
    }
  }

  private async refreshConfirmations(network: string, head: bigint, invoices: OpenInvoice[]): Promise<void> {
    const pending = invoices.filter((invoice) => ['detected', 'confirming', 'underpaid', 'overpaid'].includes(invoice.status));
    if (!pending.length) return;
    await this.pool.query(
      `UPDATE invoice_payments SET confirmations = CASE WHEN $1::bigint >= block_number THEN $1::bigint - block_number + 1 ELSE 0 END,
         updated_at = now()
       WHERE block_number IS NOT NULL AND invoice_id = ANY($2::uuid[])`,
      [head.toString(), pending.map((invoice) => invoice.id)],
    );
    for (const invoice of pending) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<OpenInvoice>(`SELECT ${INVOICE_SELECT} FROM invoices WHERE id = $1 FOR UPDATE`, [invoice.id]);
        if (locked.rows[0]) await this.recompute(client, locked.rows[0], network, new Date());
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
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

  private async storeCursor(network: string, block: bigint, force = false): Promise<void> {
    await this.pool.query(
      `INSERT INTO chain_scan_cursors (network, cursor_block) VALUES ($1, $2)
       ON CONFLICT (network) DO UPDATE SET cursor_block = ${force ? 'EXCLUDED.cursor_block' : 'GREATEST(chain_scan_cursors.cursor_block, EXCLUDED.cursor_block)'}, updated_at = now()`,
      [network, block.toString()],
    );
  }
}
