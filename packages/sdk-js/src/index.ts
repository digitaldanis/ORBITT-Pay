export const invoiceStatuses = [
  'created', 'awaiting_payment', 'detected', 'confirming', 'paid',
  'underpaid', 'overpaid', 'expired', 'late_payment', 'cancelled',
] as const;

export type InvoiceStatus = typeof invoiceStatuses[number];

export interface Invoice {
  id: string;
  order_id: string | null;
  /** Requested amount as a decimal string, in `currency`. */
  amount: string;
  currency: string;
  /** Exact crypto amount to send. Null until the customer picks a coin at checkout. */
  crypto_amount: string | null;
  asset: string | null;
  network: string | null;
  address: string | null;
  status: InvoiceStatus;
  checkout_url: string;
  /** Cumulative amount received on chain, in `asset`. */
  received_amount: string;
  /** Amount received beyond `crypto_amount`, in `asset`. */
  surplus_amount: string;
  /** Fiat price of one `asset` unit used for the quote, when priced in fiat. */
  exchange_rate: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface InvoicePayment {
  transaction_id: string;
  asset: string;
  amount: string;
  confirmations: string;
  block_number: string | null;
  observed_at: string;
}

export interface Asset {
  asset: string;
  network: string;
  name: string;
  network_name: string;
  decimals: number;
  contract: string | null;
  wallet_asset: string;
  family: 'utxo' | 'evm' | 'tron' | 'solana';
  address_mode: 'derived' | 'shared';
  enabled: boolean;
  /** True when the merchant has a wallet for it and its network scanner is live. */
  available: boolean;
}

export interface CreateInvoiceInput {
  amount: string;
  currency: string;
  asset?: string;
  network?: string;
  order_id?: string;
  success_url?: string;
  cancel_url?: string;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
}

export interface InvoiceList {
  data: Invoice[];
  next_cursor: string | null;
}

export type WebhookEventType =
  | 'invoice.created'
  | 'invoice.detected'
  | 'invoice.paid'
  | 'invoice.underpaid'
  | 'invoice.overpaid'
  | 'invoice.expired'
  | 'invoice.late_payment'
  | 'invoice.cancelled'
  | 'webhook.test';

export interface WebhookEvent {
  event: WebhookEventType;
  created_at: string;
  invoice: Invoice | null;
}

export interface OrbittClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export interface OrbittErrorBody {
  error?: { code?: string; message?: string; param?: string };
}

export class OrbittApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly param: string | undefined;

  constructor(status: number, body: OrbittErrorBody) {
    super(body.error?.message ?? `ORBITT PAY request failed with status ${status}.`);
    this.name = 'OrbittApiError';
    this.status = status;
    this.code = body.error?.code;
    this.param = body.error?.param;
  }
}

export class OrbittClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OrbittClientOptions) {
    if (!options.apiKey.trim()) throw new TypeError('apiKey is required.');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error('A Fetch API implementation is required.');
  }

  async createInvoice(input: CreateInvoiceInput, idempotencyKey: string): Promise<Invoice> {
    if (!idempotencyKey.trim()) throw new TypeError('idempotencyKey is required.');
    return this.request<Invoice>('/v1/invoices', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  }

  getInvoice(id: string): Promise<Invoice> {
    return this.request<Invoice>(`/v1/invoices/${encodeURIComponent(id)}`);
  }

  listInvoices(options: { status?: InvoiceStatus; search?: string; limit?: number; cursor?: string } = {}): Promise<InvoiceList> {
    const query = new URLSearchParams();
    if (options.status) query.set('status', options.status);
    if (options.search) query.set('search', options.search);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', options.cursor);
    const suffix = query.size ? `?${query.toString()}` : '';
    return this.request<InvoiceList>(`/v1/invoices${suffix}`);
  }

  cancelInvoice(id: string): Promise<Invoice> {
    return this.request<Invoice>(`/v1/invoices/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  listPayments(id: string): Promise<InvoicePayment[]> {
    return this.request<InvoicePayment[]>(`/v1/invoices/${encodeURIComponent(id)}/payments`);
  }

  listAssets(): Promise<Asset[]> {
    return this.request<Asset[]>('/v1/assets');
  }

  sendTestWebhook(): Promise<{ accepted: boolean }> {
    return this.request('/v1/webhooks/test', { method: 'POST' });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new OrbittApiError(response.status, isRecord(body) ? body as OrbittErrorBody : {});
    return body as T;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

/** Verifies an ORBITT-Signature header against the exact raw request body. */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string | Uint8Array,
  signatureHeader: string,
  options: { toleranceSeconds?: number; now?: number; crypto?: Crypto } = {},
): Promise<boolean> {
  const timestampMatch = /(?:^|,)\s*t=(\d+)(?:,|$)/.exec(signatureHeader);
  const timestamp = timestampMatch ? Number(timestampMatch[1]) : NaN;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(now) || !Number.isSafeInteger(tolerance) || tolerance < 0 || Math.abs(now - timestamp) > tolerance) return false;

  const candidates = [...signatureHeader.matchAll(/(?:^|,)\s*v1=([a-f0-9]{64})(?=,|$)/gi)]
    .map((match) => decodeHex(match[1]!))
    .filter((value): value is Uint8Array => value !== null);
  if (!candidates.length) return false;

  const cryptoApi = options.crypto ?? globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('Web Crypto is required to verify webhook signatures.');
  const key = await cryptoApi.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const body = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody;
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  const expected = new Uint8Array(await cryptoApi.subtle.sign('HMAC', key, message));

  return candidates.some((candidate) => {
    let difference = 0;
    for (let i = 0; i < expected.length; i += 1) difference |= expected[i]! ^ candidate[i]!;
    return difference === 0;
  });
}

/**
 * Verifies the signature and parses the event in one step. Throws when the signature is
 * invalid or stale, so handlers never act on an unverified body.
 */
export async function constructWebhookEvent(
  secret: string,
  rawBody: string | Uint8Array,
  signatureHeader: string,
  options: { toleranceSeconds?: number; now?: number; crypto?: Crypto } = {},
): Promise<WebhookEvent> {
  if (!await verifyWebhookSignature(secret, rawBody, signatureHeader, options)) {
    throw new Error('Invalid ORBITT-Signature header.');
  }
  const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  const event: unknown = JSON.parse(text);
  if (!isRecord(event) || typeof event.event !== 'string') throw new Error('Webhook body is not an ORBITT PAY event.');
  return event as unknown as WebhookEvent;
}
