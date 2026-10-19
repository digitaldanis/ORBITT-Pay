import { createHash, randomBytes } from 'node:crypto';
import { hash as hashPassword, verify as verifyPassword, Algorithm } from '@node-rs/argon2';
import type { Pool, PoolClient } from 'pg';
import { parseAccountPublicKey } from '@orbitt/chains';
import { encryptSecret } from '@orbitt/webhooks';
import { createApiKey } from '../auth/api-key.js';
import { ApiError } from '../errors.js';
import type { ApiServices, CreateInvoiceInput, DashboardLogin, DashboardSession, InvoiceListQuery, InvoiceRecord, MerchantContext, PublicInvoiceRecord } from '../server.js';

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

type PublicInvoiceRow = {
  id: string;
  merchant_name: string;
  order_id: string | null;
  request_amount: string;
  request_currency: string;
  crypto_amount: string;
  crypto_amount_base_units: string;
  asset: string;
  network: string;
  address: string | null;
  status: PublicInvoiceRecord['status'];
  created_at: Date;
  expires_at: Date;
  success_url: string | null;
  cancel_url: string | null;
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

const DUMMY_PASSWORD_HASH = hashPassword('invalid dashboard password placeholder', { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });

function assertWebhookUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, 'invalid_webhook_url', 'Webhook URL must be a valid HTTP or HTTPS URL.', 'webhook_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ApiError(422, 'invalid_webhook_url', 'Webhook URL must use HTTP(S) and cannot include credentials.', 'webhook_url');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new ApiError(422, 'https_required', 'HTTPS is required for webhook URLs in production.', 'webhook_url');
  }
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
    checkout_url: `${process.env.CHECKOUT_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173'}/checkout/${row.id}`,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    metadata: row.metadata ?? {},
  };
}

function toPublicInvoice(row: PublicInvoiceRow): PublicInvoiceRecord {
  return {
    id: row.id,
    merchant_name: row.merchant_name,
    order_id: row.order_id,
    request_amount: row.request_amount,
    request_currency: row.request_currency,
    crypto_amount: row.crypto_amount,
    crypto_amount_base_units: row.crypto_amount_base_units,
    asset: row.asset,
    network: row.network,
    address: row.address,
    status: row.status,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    success_url: row.success_url,
    cancel_url: row.cancel_url,
  };
}

export class PostgresApiServices implements ApiServices {
  constructor(
    private readonly pool: Pool,
    private readonly preparer: InvoicePreparer,
    private readonly enabledAssets: Array<{ asset: string; network: string; enabled: boolean }>,
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

  async loginDashboard(email: string, password: string): Promise<DashboardLogin | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const userResult = await this.pool.query<{ user_id: string; merchant_id: string; email: string; password_hash: string; disabled_at: Date | null; merchant_name: string }>(
      `SELECT u.id AS user_id, u.merchant_id, u.email, u.password_hash, u.disabled_at, m.name AS merchant_name
       FROM merchant_users u JOIN merchants m ON m.id = u.merchant_id WHERE lower(u.email) = $1`, [normalizedEmail],
    );
    const user = userResult.rows[0];
    let valid = false;
    try { valid = await verifyPassword(user?.password_hash ?? await DUMMY_PASSWORD_HASH, password); }
    catch { valid = false; }
    if (!user || user.disabled_at || !valid) return null;

    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO dashboard_sessions (user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '8 hours')`,
      [user.user_id, createHash('sha256').update(sessionToken).digest('hex'), createHash('sha256').update(csrfToken).digest('hex')],
    );
    return { sessionToken, csrfToken, merchant: { id: user.merchant_id, name: user.merchant_name }, email: user.email };
  }

  async authenticateDashboardSession(sessionToken: string): Promise<DashboardSession | null> {
    const result = await this.pool.query<{ id: string; name: string; email: string; csrf_hash: string }>(
      `SELECT m.id, m.name, u.email, s.csrf_hash FROM dashboard_sessions s
       JOIN merchant_users u ON u.id = s.user_id JOIN merchants m ON m.id = u.merchant_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [createHash('sha256').update(sessionToken).digest('hex')],
    );
    const row = result.rows[0];
    return row ? { merchant: { id: row.id, name: row.name }, email: row.email, csrfHash: row.csrf_hash } : null;
  }

  async revokeDashboardSession(sessionToken: string): Promise<void> {
    await this.pool.query(
      'UPDATE dashboard_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [createHash('sha256').update(sessionToken).digest('hex')],
    );
  }

  async getDashboardOverview(merchant: MerchantContext): Promise<Record<string, unknown>> {
    const counts = await this.pool.query<{ total: number; paid: number; pending: number; expired: number; paid_today: number }>(
      `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'paid')::int AS paid,
       count(*) FILTER (WHERE status IN ('created','awaiting_payment','detected','confirming','underpaid','overpaid'))::int AS pending,
       count(*) FILTER (WHERE status = 'expired')::int AS expired,
       count(*) FILTER (WHERE status = 'paid' AND updated_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::int AS paid_today
       FROM invoices WHERE merchant_id = $1`, [merchant.id],
    );
    const recent = await this.listInvoices(merchant, { limit: 8 });
    return { summary: counts.rows[0] ?? { total: 0, paid: 0, pending: 0, expired: 0, paid_today: 0 }, recent: recent.data };
  }

  async listDashboardWebhooks(merchant: MerchantContext): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<{
      id: string; event_type: string; status: string; attempts: number; last_http_status: number | null;
      last_error: string | null; created_at: Date; delivered_at: Date | null;
    }>(
      `SELECT id, event_type, status, attempts, last_http_status, last_error, created_at, delivered_at
       FROM webhook_deliveries WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 25`, [merchant.id],
    );
    return result.rows.map((row) => ({
      id: row.id, event: row.event_type, status: row.status, attempts: row.attempts,
      http_status: row.last_http_status, last_error: row.last_error,
      created_at: row.created_at.toISOString(), delivered_at: row.delivered_at?.toISOString() ?? null,
    }));
  }

  async listDashboardApiKeys(merchant: MerchantContext): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<{
      id: string; name: string; key_prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
    }>(
      `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE merchant_id = $1 ORDER BY created_at DESC`, [merchant.id],
    );
    return result.rows.map((row) => ({
      id: row.id, name: row.name, key_prefix: row.key_prefix,
      created_at: row.created_at.toISOString(), last_used_at: row.last_used_at?.toISOString() ?? null,
      revoked_at: row.revoked_at?.toISOString() ?? null,
    }));
  }

  async createDashboardApiKey(merchant: MerchantContext, name: string): Promise<{ id: string; name: string; key_prefix: string; secret: string }> {
    const key = createApiKey();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO api_keys (merchant_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4) RETURNING id`,
      [merchant.id, name.trim(), key.hash, key.prefix],
    );
    return { id: result.rows[0]!.id, name: name.trim(), key_prefix: key.prefix, secret: key.secret };
  }

  async revokeDashboardApiKey(merchant: MerchantContext, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_keys SET revoked_at = now() WHERE merchant_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [merchant.id, id],
    );
    return result.rowCount === 1;
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

      const webhookSettings = await client.query<{ default_webhook_url: string | null; webhook_secret_ciphertext: string | null }>(
        'SELECT default_webhook_url, webhook_secret_ciphertext FROM merchants WHERE id = $1', [merchant.id],
      );
      const webhookUrl = input.webhook_url ?? webhookSettings.rows[0]?.default_webhook_url ?? null;
      const encryptedSecret = webhookSettings.rows[0]?.webhook_secret_ciphertext ?? null;
      if (webhookUrl) assertWebhookUrl(webhookUrl);
      if (webhookUrl && !encryptedSecret) throw new ApiError(422, 'webhook_secret_missing', 'Configure a webhook signing secret before setting an invoice webhook URL.', 'webhook_url');

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
      await this.enqueueInvoiceEvent(client, merchant.id, invoice.id, 'invoice.created');
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

  async getPublicInvoice(id: string): Promise<PublicInvoiceRecord | null> {
    const result = await this.pool.query<PublicInvoiceRow>(
      `SELECT i.id, m.name AS merchant_name, i.order_id, i.request_amount, i.request_currency,
       i.crypto_amount, i.crypto_amount_base_units, i.asset, i.network, i.address, i.status,
       i.created_at, i.expires_at, i.success_url, i.cancel_url
       FROM invoices i JOIN merchants m ON m.id = i.merchant_id WHERE i.id = $1`, [id],
    );
    return result.rows[0] ? toPublicInvoice(result.rows[0]) : null;
  }

  async cancelPublicInvoice(id: string): Promise<PublicInvoiceRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<{ merchant_id: string }>(
        `UPDATE invoices SET status = 'cancelled', updated_at = now()
         WHERE id = $1 AND status IN ('created', 'awaiting_payment') RETURNING merchant_id`, [id],
      );
      if (updated.rows[0]) {
        await this.enqueueInvoiceEvent(client, updated.rows[0].merchant_id, id, 'invoice.cancelled');
        const selected = await client.query<PublicInvoiceRow>(
          `SELECT i.id, m.name AS merchant_name, i.order_id, i.request_amount, i.request_currency,
           i.crypto_amount, i.crypto_amount_base_units, i.asset, i.network, i.address, i.status,
           i.created_at, i.expires_at, i.success_url, i.cancel_url
           FROM invoices i JOIN merchants m ON m.id = i.merchant_id WHERE i.id = $1`, [id],
        );
        await client.query('COMMIT');
        return selected.rows[0] ? toPublicInvoice(selected.rows[0]) : null;
      }
      const existing = await client.query('SELECT 1 FROM invoices WHERE id = $1', [id]);
      await client.query('COMMIT');
      if (existing.rowCount) throw new ApiError(409, 'invoice_not_cancellable', 'Only unpaid invoices can be cancelled.');
      return null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<InvoiceRow>(
        `UPDATE invoices SET status = 'cancelled', updated_at = now()
         WHERE merchant_id = $1 AND id = $2 AND status IN ('created', 'awaiting_payment')
         RETURNING id, order_id, request_amount, request_currency, crypto_amount, asset, network,
         address, status, expires_at, created_at, metadata`, [merchant.id, id],
      );
      if (result.rows[0]) {
        await this.enqueueInvoiceEvent(client, merchant.id, id, 'invoice.cancelled');
        await client.query('COMMIT');
        return toInvoice(result.rows[0]);
      }
      const existing = await client.query('SELECT 1 FROM invoices WHERE merchant_id = $1 AND id = $2', [merchant.id, id]);
      await client.query('COMMIT');
      if (existing.rowCount) throw new ApiError(409, 'invoice_not_cancellable', 'Only unpaid invoices can be cancelled.');
      return null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getAssets() { return this.enabledAssets; }

  async getAccount(merchant: MerchantContext): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT asset, network, extended_public_key, address, next_derivation_index
       FROM merchant_wallets WHERE merchant_id = $1 ORDER BY asset, network`, [merchant.id],
    );
    const webhook = await this.pool.query<{ default_webhook_url: string | null; secret_configured: boolean }>(
      'SELECT default_webhook_url, webhook_secret_ciphertext IS NOT NULL AS secret_configured FROM merchants WHERE id = $1', [merchant.id],
    );
    return { merchant: { id: merchant.id, name: merchant.name }, webhook: { url: webhook.rows[0]?.default_webhook_url ?? null, secret_configured: webhook.rows[0]?.secret_configured ?? false }, wallets: result.rows.map((row) => ({
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

  async setWebhook(merchant: MerchantContext, url: string | null, rotateSecret: boolean): Promise<{ webhook_url: string | null; signing_secret?: string }> {
    if (url !== null) {
      assertWebhookUrl(url);
    }
    const existing = await this.pool.query<{ webhook_secret_ciphertext: string | null }>(
      'SELECT webhook_secret_ciphertext FROM merchants WHERE id = $1', [merchant.id],
    );
    if (!existing.rows[0]) throw new ApiError(404, 'account_not_found', 'Merchant account not found.');
    let encryptedSecret = existing.rows[0].webhook_secret_ciphertext;
    let signingSecret: string | undefined;
    if (rotateSecret || (url !== null && !encryptedSecret)) {
      const encryptionKey = process.env.APP_ENCRYPTION_KEY;
      if (!encryptionKey) throw new ApiError(500, 'encryption_not_configured', 'Set APP_ENCRYPTION_KEY before configuring webhook signing.');
      signingSecret = `whsec_${randomBytes(32).toString('base64url')}`;
      encryptedSecret = encryptSecret(signingSecret, encryptionKey);
    }
    await this.pool.query(
      'UPDATE merchants SET default_webhook_url = $2, webhook_secret_ciphertext = $3 WHERE id = $1',
      [merchant.id, url, encryptedSecret],
    );
    return { webhook_url: url, ...(signingSecret ? { signing_secret: signingSecret } : {}) };
  }

  async sendTestWebhook(merchant: MerchantContext): Promise<{ accepted: boolean }> {
    const settings = await this.pool.query<{ default_webhook_url: string | null; webhook_secret_ciphertext: string | null }>(
      'SELECT default_webhook_url, webhook_secret_ciphertext FROM merchants WHERE id = $1', [merchant.id],
    );
    const config = settings.rows[0];
    if (!config?.default_webhook_url || !config.webhook_secret_ciphertext) {
      throw new ApiError(422, 'webhook_not_configured', 'Configure a webhook URL and signing secret before requesting a test event.');
    }
    const payload = { event: 'webhook.test', created_at: new Date().toISOString(), invoice: null };
    await this.pool.query(
      `INSERT INTO webhook_deliveries (merchant_id, event_type, target_url, secret_ciphertext, payload)
       VALUES ($1, 'webhook.test', $2, $3, $4)`,
      [merchant.id, config.default_webhook_url, config.webhook_secret_ciphertext, JSON.stringify(payload)],
    );
    return { accepted: true };
  }

  private async enqueueInvoiceEvent(client: PoolClient, merchantId: string, invoiceId: string, eventType: string): Promise<void> {
    const selected = await client.query<InvoiceRow & { webhook_url: string | null; default_webhook_url: string | null; webhook_secret_ciphertext: string | null }>(
      `SELECT i.id, i.order_id, i.request_amount, i.request_currency, i.crypto_amount, i.asset, i.network,
       i.address, i.status, i.expires_at, i.created_at, i.metadata, i.webhook_url,
       m.default_webhook_url, m.webhook_secret_ciphertext
       FROM invoices i JOIN merchants m ON m.id = i.merchant_id
       WHERE i.merchant_id = $1 AND i.id = $2`, [merchantId, invoiceId],
    );
    const row = selected.rows[0];
    const targetUrl = row?.webhook_url ?? row?.default_webhook_url ?? null;
    if (!row || !targetUrl || !row.webhook_secret_ciphertext) return;
    const invoice = toInvoice(row);
    const payload = { event: eventType, created_at: new Date().toISOString(), invoice };
    await client.query(
      `INSERT INTO webhook_deliveries (merchant_id, invoice_id, event_type, target_url, secret_ciphertext, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [merchantId, invoiceId, eventType, targetUrl, row.webhook_secret_ciphertext, JSON.stringify(payload)],
    );
  }

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
