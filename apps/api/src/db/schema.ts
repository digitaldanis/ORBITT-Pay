import {
  sql,
} from 'drizzle-orm';
import {
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

export const invoices = pgTable('invoices', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  orderId: varchar('order_id', { length: 255 }),
  fiatAmount: text('fiat_amount'),
  fiatCurrency: varchar('fiat_currency', { length: 3 }),
  rateUsed: text('rate_used'),
  rateTimestamp: timestamp('rate_timestamp', { withTimezone: true }),
  cryptoAmountBaseUnits: text('crypto_amount_base_units').notNull(),
  receivedAmountBaseUnits: text('received_amount_base_units').notNull().default('0'),
  surplusBaseUnits: text('surplus_base_units').notNull().default('0'),
  asset: varchar('asset', { length: 32 }).notNull(),
  network: varchar('network', { length: 48 }).notNull(),
  address: text('address'),
  derivationPath: text('derivation_path'),
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
