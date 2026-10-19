import {
  sql,
} from 'drizzle-orm';
import {
  bigint,
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
