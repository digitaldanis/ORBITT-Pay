import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { hash as hashPassword, verify as verifyPassword, Algorithm } from '@node-rs/argon2';
import type { Pool, PoolClient } from 'pg';
import { isSolanaWalletAddress, parseAccountPublicKey } from '@orbitt/chains';
import { confirmationEta, findAsset, formatBaseUnits, INVOICE_COLUMNS, INVOICE_COLUMNS_I, serializeInvoice } from '@orbitt/core';
import type { AddressMode, AssetDefinition, InvoiceRow } from '@orbitt/core';
import { encryptSecret, enqueueInvoiceEvent } from '@orbitt/webhooks';
import { createApiKey } from '../auth/api-key.js';
import { ApiError } from '../errors.js';
import type {
  ApiServices, AssetRecord, AuditEntry, CreateInvoiceInput, DashboardLogin, DashboardSession, InvoiceDetail, InvoiceListQuery,
  InvoiceRecord, InvoiceTimelineEntry, MerchantContext, PublicInvoiceRecord, WalletInput,
} from '../server.js';

export interface PaymentSelection {
  asset: string;
  network: string;
  cryptoAmount: string;
  cryptoAmountBaseUnits: bigint;
  address: string;
  derivationPath: string | null;
  addressMode: AddressMode;
  rateUsed: string | null;
  rateTimestamp: Date | null;
  expiresAt: Date;
  requiredConfirmations: number;
}

export interface PaymentOption {
  asset: string;
  network: string;
  name: string;
  network_name: string;
  decimals: number;
  contract: string | null;
}

export interface PreparedInvoice {
  amount: string;
  currency: string;
  fiatAmount: string | null;
  fiatCurrency: string | null;
  /** Null when the customer chooses the coin on hosted checkout. */
  payment: PaymentSelection | null;
  expiresAt: Date;
  successUrl: string | null;
  cancelUrl: string | null;
  webhookUrl: string | null;
}

export interface InvoicePreparer {
  prepare(client: PoolClient, merchant: MerchantContext, input: CreateInvoiceInput): Promise<PreparedInvoice>;
  selectPayment(client: PoolClient, merchant: MerchantContext, request: { amount: string; currency: string }, asset: string, network: string): Promise<PaymentSelection>;
  paymentOptions(client: PoolClient, merchantId: string): Promise<PaymentOption[]>;
}

const OPEN_STATUSES = `('created', 'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid')`;

type PublicInvoiceRow = InvoiceRow & { merchant_name: string; success_url: string | null; cancel_url: string | null };

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

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const DUMMY_PASSWORD_HASH = hashPassword('invalid dashboard password placeholder', { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });

type Queryable = Pool | PoolClient;

interface AuditTarget { type: string; id: string }

/** Writes one audit entry; the database links it into the merchant's hash chain. */
async function audit(db: Queryable, merchant: MerchantContext, action: string, target: AuditTarget | null = null, details: Record<string, unknown> = {}): Promise<void> {
  const actor = merchant.actor ?? { type: 'system' as const, id: null, label: null };
  const ip = actor.ip && isIP(actor.ip) ? actor.ip : null;
  await db.query(
    `INSERT INTO audit_log (merchant_id, actor_type, actor_id, actor_label, action, target_type, target_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [merchant.id, actor.type, actor.id, actor.label, action, target?.type ?? null, target?.id ?? null, JSON.stringify(details), ip],
  );
}

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

export class PostgresApiServices implements ApiServices {
  constructor(
    private readonly pool: Pool,
    private readonly preparer: InvoicePreparer,
    private readonly catalog: readonly AssetDefinition[],
  ) {}

  private toInvoice(row: InvoiceRow): InvoiceRecord {
    return serializeInvoice(row, this.catalog);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticateKey(keyHash: string): Promise<MerchantContext | null> {
    const result = await this.pool.query<{ id: string; name: string; key_id: string; key_prefix: string }>(
      `WITH used AS (
         UPDATE api_keys SET last_used_at = now()
         WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, merchant_id, key_prefix
       )
       SELECT m.id, m.name, used.id AS key_id, used.key_prefix FROM merchants m JOIN used ON used.merchant_id = m.id`, [keyHash],
    );
    const row = result.rows[0];
    return row ? { id: row.id, name: row.name, actor: { type: 'api_key', id: row.key_id, label: `${row.key_prefix}…` } } : null;
  }

  async loginDashboard(email: string, password: string, ip?: string): Promise<DashboardLogin | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const userResult = await this.pool.query<{ user_id: string; merchant_id: string; email: string; password_hash: string; disabled_at: Date | null; merchant_name: string }>(
      `SELECT u.id AS user_id, u.merchant_id, u.email, u.password_hash, u.disabled_at, m.name AS merchant_name
       FROM merchant_users u JOIN merchants m ON m.id = u.merchant_id WHERE lower(u.email) = $1`, [normalizedEmail],
    );
    const user = userResult.rows[0];
    let valid = false;
    try { valid = await verifyPassword(user?.password_hash ?? await DUMMY_PASSWORD_HASH, password); }
    catch { valid = false; }
    if (user && (user.disabled_at || !valid)) {
      await audit(this.pool, { id: user.merchant_id, name: user.merchant_name, actor: { type: 'user', id: user.user_id, label: user.email, ip: ip ?? null } },
        'user.sign_in_failed', { type: 'user', id: user.user_id }, { reason: user.disabled_at ? 'disabled' : 'invalid_password' });
    }
    if (!user || user.disabled_at || !valid) return null;

    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO dashboard_sessions (user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '8 hours')`,
      [user.user_id, sha256Hex(sessionToken), sha256Hex(csrfToken)],
    );
    const merchant: MerchantContext = { id: user.merchant_id, name: user.merchant_name, actor: { type: 'user', id: user.user_id, label: user.email, ip: ip ?? null } };
    await audit(this.pool, merchant, 'user.signed_in', { type: 'user', id: user.user_id });
    return { sessionToken, csrfToken, merchant: { id: user.merchant_id, name: user.merchant_name }, email: user.email };
  }

  async authenticateDashboardSession(sessionToken: string): Promise<DashboardSession | null> {
    const result = await this.pool.query<{ id: string; name: string; user_id: string; email: string; csrf_hash: string }>(
      `SELECT m.id, m.name, u.id AS user_id, u.email, s.csrf_hash FROM dashboard_sessions s
       JOIN merchant_users u ON u.id = s.user_id JOIN merchants m ON m.id = u.merchant_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [sha256Hex(sessionToken)],
    );
    const row = result.rows[0];
    return row ? { merchant: { id: row.id, name: row.name, actor: { type: 'user', id: row.user_id, label: row.email } }, email: row.email, csrfHash: row.csrf_hash } : null;
  }

  async revokeDashboardSession(sessionToken: string): Promise<void> {
    const revoked = await this.pool.query<{ user_id: string; merchant_id: string; email: string }>(
      `UPDATE dashboard_sessions s SET revoked_at = now() FROM merchant_users u
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.id = s.user_id
       RETURNING s.user_id, u.merchant_id, u.email`,
      [sha256Hex(sessionToken)],
    );
    const row = revoked.rows[0];
    if (row) await audit(this.pool, { id: row.merchant_id, name: '', actor: { type: 'user', id: row.user_id, label: row.email } }, 'user.signed_out', { type: 'user', id: row.user_id });
  }

  async getDashboardOverview(merchant: MerchantContext): Promise<Record<string, unknown>> {
    const counts = await this.pool.query<{ total: number; paid: number; pending: number; expired: number; paid_today: number; attention: number }>(
      `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'paid')::int AS paid,
       count(*) FILTER (WHERE status IN ${OPEN_STATUSES})::int AS pending,
       count(*) FILTER (WHERE status = 'expired')::int AS expired,
       count(*) FILTER (WHERE status IN ('underpaid', 'late_payment') OR (status = 'paid' AND surplus_base_units <> '0'))::int AS attention,
       count(*) FILTER (WHERE status = 'paid' AND paid_at >= date_trunc('day', now()))::int AS paid_today
       FROM invoices WHERE merchant_id = $1`, [merchant.id],
    );
    const volume = await this.pool.query<{ day: string; currency: string; amount: string; count: number }>(
      `SELECT to_char(date_trunc('day', paid_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       request_currency AS currency, sum(request_amount::numeric)::text AS amount, count(*)::int AS count
       FROM invoices WHERE merchant_id = $1 AND status = 'paid' AND paid_at > now() - interval '14 days'
       GROUP BY 1, 2 ORDER BY 1`, [merchant.id],
    );
    const recent = await this.listInvoices(merchant, { limit: 8 });
    return {
      summary: counts.rows[0] ?? { total: 0, paid: 0, pending: 0, expired: 0, paid_today: 0, attention: 0 },
      volume: volume.rows,
      recent: recent.data,
    };
  }

  async listDashboardWebhooks(merchant: MerchantContext, invoiceId?: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<{
      id: string; invoice_id: string | null; event_type: string; status: string; attempts: number; last_http_status: number | null;
      last_error: string | null; created_at: Date; delivered_at: Date | null; next_attempt_at: Date;
    }>(
      `SELECT id, invoice_id, event_type, status, attempts, last_http_status, last_error, created_at, delivered_at, next_attempt_at
       FROM webhook_deliveries WHERE merchant_id = $1 AND ($2::uuid IS NULL OR invoice_id = $2)
       ORDER BY created_at DESC LIMIT 50`, [merchant.id, invoiceId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id, invoice_id: row.invoice_id, event: row.event_type, status: row.status, attempts: row.attempts,
      http_status: row.last_http_status, last_error: row.last_error,
      created_at: row.created_at.toISOString(), delivered_at: row.delivered_at?.toISOString() ?? null,
      next_attempt_at: row.status === 'pending' ? row.next_attempt_at.toISOString() : null,
    }));
  }

  async redeliverWebhook(merchant: MerchantContext, deliveryId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query<{ event_type: string; invoice_id: string | null }>(
        `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now(), locked_until = NULL
         WHERE merchant_id = $1 AND id = $2 AND status IN ('delivered', 'failed', 'pending') RETURNING event_type, invoice_id`, [merchant.id, deliveryId],
      );
      const row = result.rows[0];
      if (!row) return false;
      await audit(client, merchant, 'webhook.redelivered', { type: 'webhook_delivery', id: deliveryId }, { event: row.event_type, invoice_id: row.invoice_id });
      return true;
    });
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
    return this.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO api_keys (merchant_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4) RETURNING id`,
        [merchant.id, name.trim(), key.hash, key.prefix],
      );
      const id = result.rows[0]!.id;
      await audit(client, merchant, 'api_key.created', { type: 'api_key', id }, { name: name.trim(), key_prefix: key.prefix });
      return { id, name: name.trim(), key_prefix: key.prefix, secret: key.secret };
    });
  }

  async revokeDashboardApiKey(merchant: MerchantContext, id: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query<{ name: string; key_prefix: string }>(
        `UPDATE api_keys SET revoked_at = now() WHERE merchant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING name, key_prefix`,
        [merchant.id, id],
      );
      const row = result.rows[0];
      if (!row) return false;
      await audit(client, merchant, 'api_key.revoked', { type: 'api_key', id }, { name: row.name, key_prefix: row.key_prefix });
      return true;
    });
  }

  async createInvoice(merchant: MerchantContext, idempotencyKey: string, input: CreateInvoiceInput): Promise<InvoiceRecord> {
    try {
      return await this.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${merchant.id}:${idempotencyKey}`]);
        const hash = requestHash(input);
        const existing = await client.query<{ request_hash: string; response: InvoiceRecord; expires_at: Date }>(
          `SELECT request_hash, response, expires_at FROM idempotency_keys
           WHERE merchant_id = $1 AND key = $2 FOR UPDATE`, [merchant.id, idempotencyKey],
        );
        const row = existing.rows[0];
        if (row && row.expires_at.getTime() > Date.now()) {
          if (row.request_hash !== hash) throw new ApiError(409, 'idempotency_key_conflict', 'This idempotency key was already used with a different request.');
          return row.response;
        }
        if (row) await client.query('DELETE FROM idempotency_keys WHERE merchant_id = $1 AND key = $2', [merchant.id, idempotencyKey]);

        const webhookSettings = await client.query<{ default_webhook_url: string | null; webhook_secret_ciphertext: string | null }>(
          'SELECT default_webhook_url, webhook_secret_ciphertext FROM merchants WHERE id = $1', [merchant.id],
        );
        const webhookUrl = input.webhook_url ?? webhookSettings.rows[0]?.default_webhook_url ?? null;
        if (webhookUrl) assertWebhookUrl(webhookUrl);
        if (input.webhook_url && !webhookSettings.rows[0]?.webhook_secret_ciphertext) {
          throw new ApiError(422, 'webhook_secret_missing', 'Configure a webhook signing secret before setting an invoice webhook URL.', 'webhook_url');
        }

        const prepared = await this.preparer.prepare(client, merchant, input);
        const payment = prepared.payment;
        const insert = await client.query<InvoiceRow>(
          `INSERT INTO invoices (
             merchant_id, order_id, request_amount, request_currency, fiat_amount, fiat_currency,
             rate_used, rate_timestamp, crypto_amount_base_units, crypto_amount, asset, network,
             address, address_mode, derivation_path, success_url, cancel_url, webhook_url, status, expires_at, metadata,
             payment_selected_at, required_confirmations
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
           RETURNING ${INVOICE_COLUMNS}`,
          [merchant.id, input.order_id ?? null, prepared.amount, prepared.currency, prepared.fiatAmount, prepared.fiatCurrency,
            payment?.rateUsed ?? null, payment?.rateTimestamp ?? null, payment?.cryptoAmountBaseUnits.toString() ?? null,
            payment?.cryptoAmount ?? null, payment?.asset ?? null, payment?.network ?? null, payment?.address ?? null,
            payment?.addressMode ?? 'derived', payment?.derivationPath ?? null, prepared.successUrl, prepared.cancelUrl,
            prepared.webhookUrl, payment ? 'awaiting_payment' : 'created', prepared.expiresAt, input.metadata ?? {},
            payment ? new Date() : null, payment?.requiredConfirmations ?? null],
        );
        const invoice = this.toInvoice(insert.rows[0]!);
        await enqueueInvoiceEvent(client, this.catalog, invoice.id, 'invoice.created');
        // API keys create invoices at shop volume; only payment links made by people are audited.
        if (merchant.actor?.type === 'user') {
          await audit(client, merchant, 'invoice.created', { type: 'invoice', id: invoice.id }, { amount: invoice.amount, currency: invoice.currency, order_id: invoice.order_id });
        }
        await client.query(
          `INSERT INTO idempotency_keys (merchant_id, key, request_hash, response, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '24 hours')`, [merchant.id, idempotencyKey, hash, JSON.stringify(invoice)],
        );
        return invoice;
      });
    } catch (error) {
      throw this.mapAddressConflict(error);
    }
  }

  private mapAddressConflict(error: unknown): unknown {
    if (error instanceof Error && /invoices_open_(address|shared_amount)_unique/.test(error.message)) {
      return new ApiError(409, 'address_already_in_use', 'A unique payment address could not be reserved. Retry the request.');
    }
    return error;
  }

  async getInvoice(merchant: MerchantContext, id: string): Promise<InvoiceRecord | null> {
    const result = await this.pool.query<InvoiceRow>(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE merchant_id = $1 AND id = $2`, [merchant.id, id],
    );
    return result.rows[0] ? this.toInvoice(result.rows[0]) : null;
  }

  async getInvoiceDetail(merchant: MerchantContext, id: string): Promise<InvoiceDetail | null> {
    const invoice = await this.getInvoice(merchant, id);
    if (!invoice) return null;
    const asset = invoice.asset && invoice.network ? findAsset(this.catalog, invoice.asset, invoice.network) : undefined;
    const payments = await this.pool.query<{ transaction_id: string; asset: string; amount_base_units: string; confirmations: string; block_number: string | null; observed_at: Date }>(
      `SELECT transaction_id, asset, amount_base_units, confirmations::text, block_number::text, observed_at
       FROM invoice_payments WHERE invoice_id = $1 ORDER BY observed_at`, [id],
    );
    const path = await this.pool.query<{ derivation_path: string | null }>('SELECT derivation_path FROM invoices WHERE merchant_id = $1 AND id = $2', [merchant.id, id]);
    const history = await this.pool.query<{ from_status: InvoiceTimelineEntry['from_status']; to_status: InvoiceTimelineEntry['status']; received_amount_base_units: string; created_at: Date }>(
      `SELECT from_status, to_status, received_amount_base_units, created_at FROM invoice_status_history
       WHERE invoice_id = $1 ORDER BY id`, [id],
    );
    return {
      invoice,
      timeline: history.rows.map((row) => ({
        status: row.to_status,
        from_status: row.from_status,
        received_amount: asset ? formatBaseUnits(BigInt(row.received_amount_base_units), asset.decimals) : row.received_amount_base_units,
        at: row.created_at.toISOString(),
      })),
      derivation_path: path.rows[0]?.derivation_path ?? null,
      payments: payments.rows.map((row) => ({
        transaction_id: row.transaction_id,
        asset: row.asset,
        amount: asset ? formatBaseUnits(BigInt(row.amount_base_units), asset.decimals) : row.amount_base_units,
        confirmations: row.confirmations,
        block_number: row.block_number,
        observed_at: row.observed_at.toISOString(),
      })),
      webhooks: await this.listDashboardWebhooks(merchant, id),
    };
  }

  private async readPublicInvoice(client: Pool | PoolClient, id: string): Promise<PublicInvoiceRecord | null> {
    const result = await client.query<PublicInvoiceRow>(
      `SELECT ${INVOICE_COLUMNS_I}, m.name AS merchant_name, i.success_url, i.cancel_url
       FROM invoices i JOIN merchants m ON m.id = i.merchant_id WHERE i.id = $1`, [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const asset = row.asset && row.network ? findAsset(this.catalog, row.asset, row.network) : undefined;
    const expected = row.crypto_amount_base_units ? BigInt(row.crypto_amount_base_units) : 0n;
    const received = BigInt(row.received_amount_base_units);
    const format = (value: bigint) => asset ? formatBaseUnits(value, asset.decimals) : value.toString();
    const options = row.status === 'created' && row.expires_at.getTime() > Date.now()
      ? await this.withClient(client, (connection) => this.preparer.paymentOptions(connection, row.merchant_id))
      : [];
    const transfers = await client.query<{ transaction_id: string; amount_base_units: string; confirmations: string; observed_at: Date }>(
      `SELECT transaction_id, amount_base_units, confirmations::text, observed_at
       FROM invoice_payments WHERE invoice_id = $1 ORDER BY observed_at`, [id],
    );
    const confirmations = row.confirmations === null ? null : Number(row.confirmations);
    const required = row.required_confirmations;
    const waiting = ['detected', 'confirming', 'overpaid'].includes(row.status) && required !== null && row.network !== null;
    return {
      id: row.id,
      merchant_name: row.merchant_name,
      order_id: row.order_id,
      request_amount: row.request_amount,
      request_currency: row.request_currency,
      crypto_amount: row.crypto_amount,
      crypto_amount_base_units: row.crypto_amount_base_units,
      asset: row.asset,
      asset_name: asset?.name ?? null,
      asset_decimals: asset?.decimals ?? null,
      network: row.network,
      network_name: asset?.networkName ?? null,
      token_contract: asset?.contract ?? null,
      address: row.address,
      address_mode: row.address_mode,
      received_amount: format(received),
      remaining_amount: format(expected > received ? expected - received : 0n),
      status: row.status,
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
      success_url: row.success_url,
      cancel_url: row.cancel_url,
      payment_options: options,
      confirmations,
      required_confirmations: required,
      confirmation_eta_seconds: waiting ? confirmationEta(row.network!, required! - (confirmations ?? 0)) : null,
      transactions: transfers.rows.map((transfer) => ({
        transaction_id: transfer.transaction_id,
        amount: format(BigInt(transfer.amount_base_units)),
        confirmations: Number(transfer.confirmations),
        observed_at: transfer.observed_at.toISOString(),
      })),
    };
  }

  private async withClient<T>(client: Pool | PoolClient, work: (connection: PoolClient) => Promise<T>): Promise<T> {
    if ('release' in client) return work(client as PoolClient);
    const connection = await this.pool.connect();
    try { return await work(connection); } finally { connection.release(); }
  }

  async getPublicInvoice(id: string): Promise<PublicInvoiceRecord | null> {
    return this.readPublicInvoice(this.pool, id);
  }

  async selectPublicPayment(id: string, assetCode: string, network: string): Promise<PublicInvoiceRecord | null> {
    try {
      return await this.transaction(async (client) => {
        const locked = await client.query<{ merchant_id: string; merchant_name: string; status: string; request_amount: string; request_currency: string; expires_at: Date }>(
          `SELECT i.merchant_id, m.name AS merchant_name, i.status, i.request_amount, i.request_currency, i.expires_at
           FROM invoices i JOIN merchants m ON m.id = i.merchant_id WHERE i.id = $1 FOR UPDATE OF i`, [id],
        );
        const invoice = locked.rows[0];
        if (!invoice) return null;
        if (invoice.status !== 'created') throw new ApiError(409, 'payment_already_selected', 'A payment method was already chosen for this invoice.');
        if (invoice.expires_at.getTime() <= Date.now()) throw new ApiError(409, 'invoice_expired', 'This invoice has expired.');
        const options = await this.preparer.paymentOptions(client, invoice.merchant_id);
        const normalizedAsset = assetCode.trim().toUpperCase();
        const normalizedNetwork = network.trim().toLowerCase();
        if (!options.some((option) => option.asset === normalizedAsset && option.network === normalizedNetwork)) {
          throw new ApiError(422, 'unsupported_asset_network', 'This payment method is not available for the invoice.', 'network');
        }
        const payment = await this.preparer.selectPayment(
          client, { id: invoice.merchant_id, name: invoice.merchant_name },
          { amount: invoice.request_amount, currency: invoice.request_currency }, normalizedAsset, normalizedNetwork,
        );
        await client.query(
          `UPDATE invoices SET asset = $2, network = $3, crypto_amount = $4, crypto_amount_base_units = $5, address = $6,
             address_mode = $7, derivation_path = $8, rate_used = $9, rate_timestamp = $10, expires_at = $11,
             required_confirmations = $12, status = 'awaiting_payment', payment_selected_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, payment.asset, payment.network, payment.cryptoAmount, payment.cryptoAmountBaseUnits.toString(), payment.address,
            payment.addressMode, payment.derivationPath, payment.rateUsed, payment.rateTimestamp, payment.expiresAt,
            payment.requiredConfirmations],
        );
        return this.readPublicInvoice(client, id);
      });
    } catch (error) {
      throw this.mapAddressConflict(error);
    }
  }

  async cancelPublicInvoice(id: string): Promise<PublicInvoiceRecord | null> {
    return this.transaction(async (client) => {
      const updated = await client.query<{ merchant_id: string }>(
        `UPDATE invoices SET status = 'cancelled', updated_at = now()
         WHERE id = $1 AND status IN ('created', 'awaiting_payment') AND received_amount_base_units = '0' RETURNING merchant_id`, [id],
      );
      if (updated.rows[0]) {
        await enqueueInvoiceEvent(client, this.catalog, id, 'invoice.cancelled');
        return this.readPublicInvoice(client, id);
      }
      const existing = await client.query('SELECT 1 FROM invoices WHERE id = $1', [id]);
      if (existing.rowCount) throw new ApiError(409, 'invoice_not_cancellable', 'Only unpaid invoices can be cancelled.');
      return null;
    });
  }

  async listInvoices(merchant: MerchantContext, query: InvoiceListQuery): Promise<{ data: InvoiceRecord[]; next_cursor: string | null }> {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    const params: unknown[] = [merchant.id];
    let where = 'merchant_id = $1';
    const statuses = query.status === undefined ? [] : Array.isArray(query.status) ? query.status : [query.status];
    if (statuses.length) { params.push(statuses); where += ` AND status = ANY($${params.length}::invoice_status[])`; }
    if (query.search) {
      params.push(`%${query.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
      where += ` AND (order_id ILIKE $${params.length} OR id::text ILIKE $${params.length} OR address ILIKE $${params.length})`;
    }
    if (cursor) { params.push(cursor.createdAt, cursor.id); where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; }
    params.push(query.limit + 1);
    // The cursor carries created_at with microseconds: a JavaScript Date keeps only milliseconds,
    // which would skip invoices created within the same millisecond as the last row of a page.
    const result = await this.pool.query<InvoiceRow & { cursor_created_at: string }>(
      `SELECT ${INVOICE_COLUMNS}, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM invoices WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return { data: rows.map((row) => this.toInvoice(row)), next_cursor: hasMore && last ? this.encodeCursor(last) : null };
  }

  async cancelInvoice(merchant: MerchantContext, id: string): Promise<InvoiceRecord | null> {
    return this.transaction(async (client) => {
      const result = await client.query<InvoiceRow>(
        `UPDATE invoices SET status = 'cancelled', updated_at = now()
         WHERE merchant_id = $1 AND id = $2 AND status IN ('created', 'awaiting_payment') AND received_amount_base_units = '0'
         RETURNING ${INVOICE_COLUMNS}`, [merchant.id, id],
      );
      if (result.rows[0]) {
        await enqueueInvoiceEvent(client, this.catalog, id, 'invoice.cancelled');
        await audit(client, merchant, 'invoice.cancelled', { type: 'invoice', id }, { order_id: result.rows[0].order_id });
        return this.toInvoice(result.rows[0]);
      }
      const existing = await client.query('SELECT 1 FROM invoices WHERE merchant_id = $1 AND id = $2', [merchant.id, id]);
      if (existing.rowCount) throw new ApiError(409, 'invoice_not_cancellable', 'Only unpaid invoices can be cancelled.');
      return null;
    });
  }

  async getAssets(merchant: MerchantContext): Promise<AssetRecord[]> {
    const client = await this.pool.connect();
    try {
      const available = await this.preparer.paymentOptions(client, merchant.id);
      return this.catalog.map((asset) => ({
        asset: asset.asset,
        network: asset.network,
        name: asset.name,
        network_name: asset.networkName,
        decimals: asset.decimals,
        contract: asset.contract,
        wallet_asset: asset.walletAsset,
        family: asset.family,
        address_mode: asset.addressMode,
        enabled: asset.enabled,
        available: available.some((option) => option.asset === asset.asset && option.network === asset.network),
      }));
    } finally {
      client.release();
    }
  }

  async getNetworkStatus(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<{ network: string; head_block: string | null; last_scan_at: Date; last_error: string | null }>(
      'SELECT network, head_block, last_scan_at, last_error FROM network_scanner_status ORDER BY network',
    );
    return result.rows.map((row) => ({
      network: row.network,
      head_block: row.head_block,
      last_scan_at: row.last_scan_at.toISOString(),
      healthy: !row.last_error && Date.now() - row.last_scan_at.getTime() < 10 * 60_000,
      last_error: row.last_error,
    }));
  }

  async getAccount(merchant: MerchantContext): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ asset: string; network: string; extended_public_key: string | null; address: string | null; next_derivation_index: string }>(
      `SELECT asset, network, extended_public_key, address, next_derivation_index
       FROM merchant_wallets WHERE merchant_id = $1 ORDER BY asset, network`, [merchant.id],
    );
    const webhook = await this.pool.query<{ default_webhook_url: string | null; secret_configured: boolean }>(
      'SELECT default_webhook_url, webhook_secret_ciphertext IS NOT NULL AS secret_configured FROM merchants WHERE id = $1', [merchant.id],
    );
    const mask = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
    return {
      merchant: { id: merchant.id, name: merchant.name },
      webhook: { url: webhook.rows[0]?.default_webhook_url ?? null, secret_configured: webhook.rows[0]?.secret_configured ?? false },
      wallets: result.rows.map((row) => ({
        asset: row.asset,
        network: row.network,
        configured: true,
        source: row.extended_public_key ? 'extended_public_key' : 'address',
        public_key_hint: mask(row.extended_public_key ?? row.address ?? ''),
        next_derivation_index: String(row.next_derivation_index),
        assets: this.catalog.filter((asset) => asset.walletAsset === row.asset && asset.network === row.network).map((asset) => asset.asset),
      })),
    };
  }

  private validateWallet(wallet: WalletInput): { asset: string; network: string; xpub: string | null; address: string | null } {
    const asset = wallet.asset.trim().toUpperCase();
    const network = wallet.network.trim().toLowerCase();
    const definition = findAsset(this.catalog, asset, network);
    if (!definition) throw new ApiError(422, 'unsupported_asset_network', `${asset} on ${network} is not in the asset catalog.`, 'wallets');
    if (definition.walletAsset !== asset) {
      throw new ApiError(422, 'wallet_asset_mismatch', `${asset} on ${definition.networkName} uses the ${definition.walletAsset} wallet. Configure ${definition.walletAsset} instead.`, 'wallets');
    }
    const xpub = wallet.extended_public_key?.trim() || null;
    const address = wallet.address?.trim() || null;
    if ((xpub === null) === (address === null)) throw new ApiError(422, 'invalid_wallet', 'Provide exactly one public key or address.', 'wallets');
    if (xpub && /^[a-z]prv/i.test(xpub)) throw new ApiError(422, 'private_key_rejected', 'Private keys and seed phrases are never accepted.', 'wallets');
    if (/\s/.test(xpub ?? address ?? '') ) throw new ApiError(422, 'private_key_rejected', 'Seed phrases are never accepted. Provide a public key or address.', 'wallets');
    if (definition.addressMode === 'derived') {
      if (!xpub) throw new ApiError(422, 'extended_public_key_required', `${definition.networkName} needs an account-level extended public key so every invoice gets its own address.`, 'wallets');
      try { parseAccountPublicKey(xpub); }
      catch { throw new ApiError(422, 'invalid_extended_public_key', 'Provide a valid account-level public key; private keys are not accepted.', 'wallets'); }
    } else {
      if (!address) throw new ApiError(422, 'address_required', `${definition.networkName} uses your public wallet address. Provide the address.`, 'wallets');
      if (definition.family === 'solana' && !isSolanaWalletAddress(address)) {
        throw new ApiError(422, 'invalid_address', 'Provide a regular Solana wallet address (not a token account).', 'wallets');
      }
    }
    return { asset, network, xpub, address };
  }

  async updateWallets(merchant: MerchantContext, wallets: WalletInput[]): Promise<Record<string, unknown>> {
    await this.transaction(async (client) => {
      for (const input of wallets) {
        const wallet = this.validateWallet(input);
        const current = await client.query<{ extended_public_key: string | null; address: string | null }>(
          `SELECT extended_public_key, address FROM merchant_wallets
           WHERE merchant_id = $1 AND asset = $2 AND network = $3 FOR UPDATE`,
          [merchant.id, wallet.asset, wallet.network],
        );
        const previous = current.rows[0];
        const changed = previous && (previous.extended_public_key !== wallet.xpub || previous.address !== wallet.address);
        if (changed) {
          const sharing = this.catalog.filter((asset) => asset.walletAsset === wallet.asset && asset.network === wallet.network).map((asset) => asset.asset);
          const openInvoices = await client.query(
            `SELECT 1 FROM invoices WHERE merchant_id = $1 AND asset = ANY($2::text[]) AND network = $3
             AND status IN ${OPEN_STATUSES} LIMIT 1`,
            [merchant.id, sharing, wallet.network],
          );
          if (openInvoices.rowCount) throw new ApiError(409, 'wallet_in_use', 'A receiving key cannot change while invoices for this network are open.', 'wallets');
        }
        await client.query(
          `INSERT INTO merchant_wallets (merchant_id, asset, network, extended_public_key, address)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (merchant_id, asset, network) DO UPDATE SET
             extended_public_key = EXCLUDED.extended_public_key, address = EXCLUDED.address,
             next_derivation_index = CASE WHEN merchant_wallets.extended_public_key IS DISTINCT FROM EXCLUDED.extended_public_key
               THEN 0 ELSE merchant_wallets.next_derivation_index END,
             updated_at = now()`,
          [merchant.id, wallet.asset, wallet.network, wallet.xpub, wallet.address],
        );
        if (!previous || changed) {
          const key = wallet.xpub ?? wallet.address ?? '';
          await audit(client, merchant, previous ? 'wallet.replaced' : 'wallet.added', { type: 'wallet', id: `${wallet.asset}:${wallet.network}` }, {
            asset: wallet.asset, network: wallet.network, source: wallet.xpub ? 'extended_public_key' : 'address',
            public_key_hint: key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key,
          });
        }
      }
    });
    return this.getAccount(merchant);
  }

  async deleteWallet(merchant: MerchantContext, asset: string, network: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const sharing = this.catalog.filter((item) => item.walletAsset === asset && item.network === network).map((item) => item.asset);
      const open = await client.query(
        `SELECT 1 FROM invoices WHERE merchant_id = $1 AND asset = ANY($2::text[]) AND network = $3 AND status IN ${OPEN_STATUSES} LIMIT 1`,
        [merchant.id, sharing.length ? sharing : [asset], network],
      );
      if (open.rowCount) throw new ApiError(409, 'wallet_in_use', 'Close open invoices on this network before removing its wallet.', 'wallets');
      const removed = await client.query('DELETE FROM merchant_wallets WHERE merchant_id = $1 AND asset = $2 AND network = $3', [merchant.id, asset, network]);
      if (removed.rowCount !== 1) return false;
      await audit(client, merchant, 'wallet.removed', { type: 'wallet', id: `${asset}:${network}` }, { asset, network });
      return true;
    });
  }

  async setWebhook(merchant: MerchantContext, url: string | null, rotateSecret: boolean): Promise<{ webhook_url: string | null; signing_secret?: string }> {
    if (url !== null) assertWebhookUrl(url);
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
    await this.transaction(async (client) => {
      const before = await client.query<{ default_webhook_url: string | null }>('SELECT default_webhook_url FROM merchants WHERE id = $1 FOR UPDATE', [merchant.id]);
      await client.query(
        'UPDATE merchants SET default_webhook_url = $2, webhook_secret_ciphertext = $3 WHERE id = $1',
        [merchant.id, url, encryptedSecret],
      );
      if (before.rows[0]?.default_webhook_url !== url) await audit(client, merchant, 'webhook.updated', { type: 'webhook', id: 'default' }, { url, previous_url: before.rows[0]?.default_webhook_url ?? null });
      if (signingSecret) await audit(client, merchant, 'webhook.secret_rotated', { type: 'webhook', id: 'default' });
    });
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
    await audit(this.pool, merchant, 'webhook.test_sent', { type: 'webhook', id: 'default' }, { url: config.default_webhook_url });
    return { accepted: true };
  }

  async listAuditLog(merchant: MerchantContext, query: { limit: number; cursor?: string; action?: string }): Promise<{ data: AuditEntry[]; next_cursor: string | null }> {
    const params: unknown[] = [merchant.id];
    let where = 'merchant_id = $1';
    if (query.cursor) { params.push(query.cursor); where += ` AND id < $${params.length}::bigint`; }
    if (query.action) {
      params.push(query.action);
      // "wallet" matches every wallet.* action, "wallet.added" only that one.
      where += query.action.includes('.') ? ` AND action = $${params.length}` : ` AND split_part(action, '.', 1) = $${params.length}`;
    }
    params.push(query.limit + 1);
    const result = await this.pool.query<{
      id: string; action: string; actor_type: AuditEntry['actor']['type']; actor_id: string | null; actor_label: string | null;
      target_type: string | null; target_id: string | null; details: Record<string, unknown>; ip: string | null; created_at: Date;
    }>(
      `SELECT id::text, action, actor_type, actor_id, actor_label, target_type, target_id, details, host(ip) AS ip, created_at
       FROM audit_log WHERE ${where} ORDER BY audit_log.id DESC LIMIT $${params.length}`, params,
    );
    const rows = result.rows.slice(0, query.limit);
    return {
      data: rows.map((row) => ({
        id: row.id,
        action: row.action,
        actor: { type: row.actor_type, id: row.actor_id, label: row.actor_label },
        target: row.target_type && row.target_id ? { type: row.target_type, id: row.target_id } : null,
        details: row.details,
        ip: row.ip,
        created_at: row.created_at.toISOString(),
      })),
      next_cursor: result.rows.length > query.limit ? rows.at(-1)!.id : null,
    };
  }

  async verifyAuditLog(merchant: MerchantContext): Promise<{ intact: boolean; entries: number; broken_at: string | null }> {
    const result = await this.pool.query<{ broken_at: string | null; entries: number }>(
      `SELECT orbitt_verify_audit_log($1)::text AS broken_at, (SELECT count(*)::int FROM audit_log WHERE merchant_id = $1) AS entries`,
      [merchant.id],
    );
    const row = result.rows[0]!;
    return { intact: row.broken_at === null, entries: row.entries, broken_at: row.broken_at };
  }

  private encodeCursor(row: InvoiceRow & { cursor_created_at: string }): string {
    return Buffer.from(`${row.cursor_created_at}|${row.id}`).toString('base64url');
  }

  private decodeCursor(value: string): { createdAt: string; id: string } {
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const separator = decoded.lastIndexOf('|');
      const createdAt = decoded.slice(0, separator);
      const id = decoded.slice(separator + 1);
      // Accepts the microsecond form and the millisecond form issued by earlier versions.
      if (separator < 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))
        || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error();
      return { createdAt, id };
    } catch {
      throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is invalid.', 'cursor');
    }
  }
}
