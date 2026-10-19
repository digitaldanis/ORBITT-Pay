import {
  sql,
} from 'drizzle-orm';
import {
  bigint,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const invoiceStatus = pgEnum('invoice_status', [
  'created', 'awaiting_payment', 'detected', 'confirming', 'paid',
  'underpaid', 'overpaid', 'expired', 'late_payment', 'cancelled',
]);

export const merchants = pgTable('merchants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  defaultWebhookUrl: text('default_webhook_url'),
  webhookSecretCiphertext: text('webhook_secret_ciphertext'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  name: varchar('name', { length: 120 }).notNull(),
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
  keyPrefix: varchar('key_prefix', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const invoices = pgTable('invoices', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  orderId: varchar('order_id', { length: 255 }),
  requestAmount: text('request_amount').notNull(),
  requestCurrency: varchar('request_currency', { length: 12 }).notNull(),
  fiatAmount: text('fiat_amount'),
  fiatCurrency: varchar('fiat_currency', { length: 3 }),
  rateUsed: text('rate_used'),
  rateTimestamp: timestamp('rate_timestamp', { withTimezone: true }),
  cryptoAmountBaseUnits: text('crypto_amount_base_units').notNull(),
  cryptoAmount: text('crypto_amount').notNull(),
  receivedAmountBaseUnits: text('received_amount_base_units').notNull().default('0'),
  surplusBaseUnits: text('surplus_base_units').notNull().default('0'),
  asset: varchar('asset', { length: 32 }).notNull(),
  network: varchar('network', { length: 48 }).notNull(),
  address: text('address'),
  derivationPath: text('derivation_path'),
  successUrl: text('success_url'),
  cancelUrl: text('cancel_url'),
  webhookUrl: text('webhook_url'),
  status: invoiceStatus('status').notNull().default('created'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  addressStatusIndex: uniqueIndex('invoices_open_address_unique')
    .on(table.address, table.asset, table.network)
    .where(sql`${table.address} IS NOT NULL AND ${table.status} IN ('created', 'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid')`),
}));

export const invoicePayments = pgTable('invoice_payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  transactionId: varchar('transaction_id', { length: 128 }).notNull(),
  asset: varchar('asset', { length: 32 }).notNull(),
  amountBaseUnits: text('amount_base_units').notNull(),
  confirmations: bigint('confirmations', { mode: 'bigint' }).notNull().default(0n),
  blockNumber: bigint('block_number', { mode: 'bigint' }),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  transactionUnique: uniqueIndex('invoice_payments_transaction_unique').on(table.invoiceId, table.transactionId, table.asset),
}));

export const chainScanCursors = pgTable('chain_scan_cursors', {
  network: varchar('network', { length: 48 }).primaryKey(),
  cursorBlock: bigint('cursor_block', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  key: varchar('key', { length: 255 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  response: jsonb('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => ({
  merchantKeyUnique: uniqueIndex('idempotency_keys_merchant_key_unique').on(table.merchantId, table.key),
}));

export const merchantWallets = pgTable('merchant_wallets', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  asset: varchar('asset', { length: 32 }).notNull(),
  network: varchar('network', { length: 48 }).notNull(),
  extendedPublicKey: text('extended_public_key'),
  address: text('address'),
  nextDerivationIndex: bigint('next_derivation_index', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  merchantAssetNetworkUnique: uniqueIndex('merchant_wallets_merchant_asset_network_unique').on(table.merchantId, table.asset, table.network),
}));

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  eventType: varchar('event_type', { length: 80 }).notNull(),
  targetUrl: text('target_url').notNull(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  lastHttpStatus: integer('last_http_status'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const webhookDeliveryAttempts = pgTable('webhook_delivery_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  deliveryId: uuid('delivery_id').notNull().references(() => webhookDeliveries.id, { onDelete: 'cascade' }),
  attemptNumber: integer('attempt_number').notNull(),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).defaultNow().notNull(),
  httpStatus: integer('http_status'),
  responseExcerpt: text('response_excerpt'),
  error: text('error'),
}, (table) => ({
  deliveryAttemptUnique: uniqueIndex('webhook_delivery_attempts_delivery_attempt_unique').on(table.deliveryId, table.attemptNumber),
}));

export const merchantUsers = pgTable('merchant_users', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  email: varchar('email', { length: 320 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

export const dashboardSessions = pgTable('dashboard_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => merchantUsers.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  csrfHash: varchar('csrf_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
