import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parseAccountPublicKey } from '@orbitt/chains';
import { ApiError } from '../errors.js';
import type { ApiServices, CreateInvoiceInput, InvoiceListQuery, InvoiceRecord, MerchantContext } from '../server.js';

export interface PreparedInvoice {
  amount: string;
  currency: string;
  fiatAmount: string | null;
  fiatCurrency: string | null;
  rateUsed: string | null;
  rateTimestamp: Date | null;
  cryptoAmount: string;
  cryptoAmountBaseUnits: bigint;
  asset: string;
  network: string;
  address: string;
  derivationPath: string;
  expiresAt: Date;
  successUrl: string | null;
  cancelUrl: string | null;
  webhookUrl: string | null;
}

export interface InvoicePreparer {
  prepare(client: PoolClient, merchant: MerchantContext, input: CreateInvoiceInput): Promise<PreparedInvoice>;
}

type InvoiceRow = {
  id: string;
  order_id: string | null;
  request_amount: string;
  request_currency: string;
  crypto_amount: string;
  asset: string;
  network: string;
  address: string | null;
  status: InvoiceRecord['status'];
  expires_at: Date;
  created_at: Date;
  metadata: Record<string, unknown>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(input: CreateInvoiceInput): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

function toInvoice(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    order_id: row.order_id,
    amount: row.request_amount,
    currency: row.request_currency,
    crypto_amount: row.crypto_amount,
    asset: row.asset,
    network: row.network,
    address: row.address,
    status: row.status,
    checkout_url: `${process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'}/checkout/${row.id}`,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    metadata: row.metadata ?? {},
  };
}

export class PostgresApiServices implements ApiServices {
  constructor(
    private readonly pool: Pool,
    private readonly preparer: InvoicePreparer,
    private readonly enabledAssets: Array<{ asset: string; network: string; enabled: boolean }>,
    private readonly testWebhook: (merchant: MerchantContext) => Promise<{ accepted: boolean }>,
  ) {}

  async authenticateKey(keyHash: string): Promise<MerchantContext | null> {
    const result = await this.pool.query<{ id: string; name: string }>(
      `UPDATE api_keys SET last_used_at = now()
       WHERE key_hash = $1 AND revoked_at IS NULL
       RETURNING merchant_id AS id`, [keyHash],
    );
    if (result.rowCount !== 1) return null;
    const merchantResult = await this.pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM merchants WHERE id = $1', [result.rows[0]!.id],
    );
    return merchantResult.rows[0] ?? null;
  }

  async createInvoice(merchant: MerchantContext, idempotencyKey: string, input: CreateInvoiceInput): Promise<InvoiceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${merchant.id}:${idempotencyKey}`]);
      const hash = requestHash(input);
      const existing = await client.query<{ request_hash: string; response: InvoiceRecord; expires_at: Date }>(
        `SELECT request_hash, response, expires_at FROM idempotency_keys
         WHERE merchant_id = $1 AND key = $2 FOR UPDATE`, [merchant.id, idempotencyKey],
      );
      const row = existing.rows[0];
      if (row && row.expires_at.getTime() > Date.now()) {
        if (row.request_hash !== hash) throw new ApiError(409, 'idempotency_key_conflict', 'This idempotency key was already used with a different request.');
        await client.query('COMMIT');
        return row.response;
      }
      if (row) await client.query('DELETE FROM idempotency_keys WHERE merchant_id = $1 AND key = $2', [merchant.id, idempotencyKey]);

      const prepared = await this.preparer.prepare(client, merchant, input);
      const insert = await client.query<InvoiceRow>(
        `INSERT INTO invoices (
           merchant_id, order_id, request_amount, request_currency, fiat_amount, fiat_currency,
           rate_used, rate_timestamp, crypto_amount_base_units, crypto_amount, asset, network,
           address, derivation_path, success_url, cancel_url, webhook_url, status, expires_at, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'awaiting_payment', $18, $19)
         RETURNING id, order_id, request_amount, request_currency, crypto_amount, asset, network,
           address, status, expires_at, created_at, metadata`,
        [merchant.id, input.order_id ?? null, prepared.amount, prepared.currency, prepared.fiatAmount, prepared.fiatCurrency,
          prepared.rateUsed, prepared.rateTimestamp, prepared.cryptoAmountBaseUnits.toString(), prepared.cryptoAmount,
          prepared.asset, prepared.network, prepared.address, prepared.derivationPath, prepared.successUrl, prepared.cancelUrl,
          prepared.webhookUrl, prepared.expiresAt, input.metadata ?? {}],
      );
      const invoice = toInvoice(insert.rows[0]!);
      await client.query(
        `INSERT INTO idempotency_keys (merchant_id, key, request_hash, response, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '24 hours')`, [merchant.id, idempotencyKey, hash, JSON.stringify(invoice)],
      );
      await client.query('COMMIT');
      return invoice;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.message.includes('invoices_open_address_unique')) {
        throw new ApiError(409, 'address_already_in_use', 'A unique payment address could not be reserved. Retry the request.');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getInvoice(merchant: MerchantContext, id: string): Promise<InvoiceRecord | null> {
    const result = await this.pool.query<InvoiceRow>(
      `SELECT id, order_id, request_amount, request_currency, crypto_amount, asset, network, address,
       status, expires_at, created_at, metadata FROM invoices WHERE merchant_id = $1 AND id = $2`, [merchant.id, id],
    );
    return result.rows[0] ? toInvoice(result.rows[0]) : null;
  }

  async listInvoices(merchant: MerchantContext, query: InvoiceListQuery): Promise<{ data: InvoiceRecord[]; next_cursor: string | null }> {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    const params: unknown[] = [merchant.id];
    let where = 'merchant_id = $1';
    if (query.status) { params.push(query.status); where += ` AND status = $${params.length}`; }
    if (cursor) { params.push(cursor.createdAt, cursor.id); where += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`; }
    params.push(query.limit + 1);
    const result = await this.pool.query<InvoiceRow>(
      `SELECT id, order_id, request_amount, request_currency, crypto_amount, asset, network, address,
       status, expires_at, created_at, metadata FROM invoices WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return { data: rows.map(toInvoice), next_cursor: hasMore && last ? this.encodeCursor(last) : null };
  }

  async cancelInvoice(merchant: MerchantContext, id: string): Promise<InvoiceRecord | null> {
    const result = await this.pool.query<InvoiceRow>(
      `UPDATE invoices SET status = 'cancelled', updated_at = now()
       WHERE merchant_id = $1 AND id = $2 AND status IN ('created', 'awaiting_payment')
       RETURNING id, order_id, request_amount, request_currency, crypto_amount, asset, network,
       address, status, expires_at, created_at, metadata`, [merchant.id, id],
    );
    if (result.rows[0]) return toInvoice(result.rows[0]);
    const existing = await this.getInvoice(merchant, id);
    if (existing) throw new ApiError(409, 'invoice_not_cancellable', 'Only unpaid invoices can be cancelled.');
    return null;
  }

  async getAssets() { return this.enabledAssets; }

  async getAccount(merchant: MerchantContext): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT asset, network, extended_public_key, address, next_derivation_index
       FROM merchant_wallets WHERE merchant_id = $1 ORDER BY asset, network`, [merchant.id],
    );
    return { merchant: { id: merchant.id, name: merchant.name }, wallets: result.rows.map((row) => ({
      asset: row.asset, network: row.network, configured: true,
      source: row.extended_public_key ? 'extended_public_key' : 'address',
      next_derivation_index: String(row.next_derivation_index),
    })) };
  }

  async updateWallets(merchant: MerchantContext, wallets: Array<{ asset: string; network: string; extended_public_key?: string; address?: string }>): Promise<Record<string, unknown>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const wallet of wallets) {
        const xpub = wallet.extended_public_key?.trim() || null;
        const address = wallet.address?.trim() || null;
        if ((xpub === null) === (address === null)) throw new ApiError(422, 'invalid_wallet', 'Provide exactly one public key or address.', 'wallets');
        if (xpub && /^(xprv|tprv|zprv|vprv)/i.test(xpub)) throw new ApiError(422, 'private_key_rejected', 'Private keys and seed phrases are never accepted.', 'wallets');
        if (xpub && !/^[xyzv]pub|^tpub/.test(xpub)) throw new ApiError(422, 'invalid_extended_public_key', 'Provide an account-level extended public key.', 'wallets');
        if (xpub) {
          try { parseAccountPublicKey(xpub); }
          catch { throw new ApiError(422, 'invalid_extended_public_key', 'Provide a valid account-level public key; private keys are not accepted.', 'wallets'); }
        }
        const current = await client.query<{ extended_public_key: string | null }>(
          `SELECT extended_public_key FROM merchant_wallets
           WHERE merchant_id = $1 AND asset = $2 AND network = $3 FOR UPDATE`,
          [merchant.id, wallet.asset.toUpperCase(), wallet.network.toLowerCase()],
        );
        if (current.rows[0] && current.rows[0].extended_public_key !== xpub) {
          const openInvoices = await client.query(
            `SELECT 1 FROM invoices WHERE merchant_id = $1 AND asset = $2 AND network = $3
             AND status IN ('created', 'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid') LIMIT 1`,
            [merchant.id, wallet.asset.toUpperCase(), wallet.network.toLowerCase()],
          );
          if (openInvoices.rowCount) throw new ApiError(409, 'wallet_in_use', 'A receiving key cannot change while invoices for this network are open.', 'wallets');
        }
        await client.query(
          `INSERT INTO merchant_wallets (merchant_id, asset, network, extended_public_key, address)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (merchant_id, asset, network) DO UPDATE SET
             extended_public_key = EXCLUDED.extended_public_key, address = EXCLUDED.address,
             updated_at = now()`,
          [merchant.id, wallet.asset.toUpperCase(), wallet.network.toLowerCase(), xpub, address],
        );
      }
      await client.query('COMMIT');
      return this.getAccount(merchant);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  sendTestWebhook(merchant: MerchantContext) { return this.testWebhook(merchant); }

  private encodeCursor(row: InvoiceRow): string {
    return Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString('base64url');
  }

  private decodeCursor(value: string): { createdAt: Date; id: string } {
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const separator = decoded.lastIndexOf('|');
      const createdAt = new Date(decoded.slice(0, separator));
      const id = decoded.slice(separator + 1);
      if (separator < 0 || Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error();
      return { createdAt, id };
    } catch {
      throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is invalid.', 'cursor');
    }
  }
}
