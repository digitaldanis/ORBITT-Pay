import { findAsset, type AssetDefinition } from './assets.js';
import type { InvoiceStatus } from './invoice.js';
import { formatBaseUnits } from './money.js';

/** Column set shared by the API and the worker when reading an invoice row. */
export interface InvoiceRow {
  id: string;
  merchant_id: string;
  order_id: string | null;
  request_amount: string;
  request_currency: string;
  rate_used: string | null;
  crypto_amount: string | null;
  crypto_amount_base_units: string | null;
  received_amount_base_units: string;
  surplus_base_units: string;
  asset: string | null;
  network: string | null;
  address: string | null;
  address_mode: 'derived' | 'shared';
  status: InvoiceStatus;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
  required_confirmations: number | null;
  /** Lowest confirmation count among the invoice's transfers; null before any transfer. */
  confirmations: string | null;
}

export const INVOICE_COLUMNS = `id, merchant_id, order_id, request_amount, request_currency, rate_used,
  crypto_amount, crypto_amount_base_units, received_amount_base_units, surplus_base_units,
  asset, network, address, address_mode, status, expires_at, created_at, updated_at, metadata, required_confirmations,
  (SELECT min(p.confirmations)::text FROM invoice_payments p WHERE p.invoice_id = invoices.id) AS confirmations`;

/** Same columns, qualified with the `i.` alias for joins. */
export const INVOICE_COLUMNS_I = `i.id, i.merchant_id, i.order_id, i.request_amount, i.request_currency, i.rate_used,
  i.crypto_amount, i.crypto_amount_base_units, i.received_amount_base_units, i.surplus_base_units,
  i.asset, i.network, i.address, i.address_mode, i.status, i.expires_at, i.created_at, i.updated_at, i.metadata, i.required_confirmations,
  (SELECT min(p.confirmations)::text FROM invoice_payments p WHERE p.invoice_id = i.id) AS confirmations`;

export interface InvoiceResource {
  id: string;
  order_id: string | null;
  amount: string;
  currency: string;
  crypto_amount: string | null;
  asset: string | null;
  network: string | null;
  address: string | null;
  status: InvoiceStatus;
  checkout_url: string;
  received_amount: string;
  surplus_amount: string;
  exchange_rate: string | null;
  /** Confirmations seen on the least-confirmed transfer; null until a transfer is seen. */
  confirmations: number | null;
  /** Confirmations needed before the invoice is paid; null until a coin is chosen. */
  required_confirmations: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export function checkoutBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.CHECKOUT_BASE_URL ?? env.PUBLIC_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}

/** The invoice object returned by the merchant API and embedded in webhook payloads. */
export function serializeInvoice(row: InvoiceRow, catalog: readonly AssetDefinition[], baseUrl = checkoutBaseUrl()): InvoiceResource {
  const decimals = row.asset && row.network ? findAsset(catalog, row.asset, row.network)?.decimals : undefined;
  const format = (value: string) => decimals === undefined ? value : formatBaseUnits(BigInt(value), decimals);
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
    checkout_url: `${baseUrl}/checkout/${row.id}`,
    received_amount: format(row.received_amount_base_units),
    surplus_amount: format(row.surplus_base_units),
    exchange_rate: row.rate_used,
    confirmations: row.confirmations === null ? null : Number(row.confirmations),
    required_confirmations: row.required_confirmations,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    metadata: row.metadata ?? {},
  };
}
