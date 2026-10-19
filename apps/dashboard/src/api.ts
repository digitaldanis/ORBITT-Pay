export type InvoiceStatus = 'created' | 'awaiting_payment' | 'detected' | 'confirming' | 'paid' | 'underpaid' | 'overpaid' | 'expired' | 'late_payment' | 'cancelled';
export const INVOICE_STATUSES: InvoiceStatus[] = ['created', 'awaiting_payment', 'detected', 'confirming', 'paid', 'underpaid', 'overpaid', 'expired', 'late_payment', 'cancelled'];
export const OPEN_STATUSES: InvoiceStatus[] = ['created', 'awaiting_payment', 'detected', 'confirming', 'underpaid'];

export interface Invoice {
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
  confirmations: number | null;
  required_confirmations: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface Payment { transaction_id: string; asset: string; amount: string; confirmations: string; block_number: string | null; observed_at: string }

export interface WebhookDelivery {
  id: string;
  invoice_id: string | null;
  event: string;
  status: 'pending' | 'delivered' | 'failed' | string;
  attempts: number;
  http_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string | null;
}

export interface InvoiceDetail { invoice: Invoice; derivation_path: string | null; payments: Payment[]; webhooks: WebhookDelivery[] }

export interface Wallet {
  asset: string;
  network: string;
  configured: boolean;
  source: 'extended_public_key' | 'address';
  public_key_hint: string;
  next_derivation_index: string;
  assets: string[];
}

export interface Account {
  merchant: { id: string; name: string };
  webhook: { url: string | null; secret_configured: boolean };
  wallets: Wallet[];
}

export type AssetFamily = 'utxo' | 'evm' | 'tron' | 'solana';

export interface CatalogAsset {
  asset: string;
  network: string;
  name: string;
  network_name: string;
  decimals: number;
  contract: string | null;
  wallet_asset: string;
  family: AssetFamily;
  address_mode: 'derived' | 'shared';
  enabled: boolean;
  available: boolean;
}

export interface NetworkHealth { network: string; head_block: string | null; last_scan_at: string; healthy: boolean; last_error: string | null }

export interface ApiKeyRecord { id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export interface Overview {
  summary: { total: number; paid: number; pending: number; expired: number; paid_today: number; attention: number };
  volume: Array<{ day: string; currency: string; amount: string; count: number }>;
  recent: Invoice[];
}

export interface DashboardSession { merchant: { id: string; name: string }; email: string }

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

function readCookie(name: string): string | undefined {
  return document.cookie.split('; ').find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie('ob_csrf');
    if (csrf) headers.set('x-csrf-token', decodeURIComponent(csrf));
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, method, headers, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
    throw new ApiRequestError(body.error?.message ?? `Request failed (${response.status})`, response.status, body.error?.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
