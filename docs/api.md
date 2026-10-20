# Merchant API

The API is versioned under `/v1`. The OpenAPI 3.1 document is served at `GET /v1/openapi.json` and Swagger UI at `/docs`. `GET /health` is public.

## Authentication

Send `Authorization: Bearer <secret_key>` on merchant endpoints. Keys carry 256 bits of entropy, are stored only as SHA-256 hashes, and are shown once at creation (`npm run api-key:create --workspace apps/api -- "Shop name"` or the dashboard). Rate limits are keyed by the hash, so the secret never appears in logs.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/invoices` | Create an invoice; requires `Idempotency-Key` |
| `GET` | `/v1/invoices` | List invoices; `status` (one status or a comma-separated list), `search`, `limit` (1–100) and `cursor` filters |
| `GET` | `/v1/invoices/{id}` | Read one invoice |
| `GET` | `/v1/invoices/{id}/payments` | On-chain transfers matched to the invoice |
| `POST` | `/v1/invoices/{id}/cancel` | Cancel an invoice that has received nothing |
| `GET` | `/v1/assets` | Asset catalog with `available` per coin and network |
| `GET` | `/v1/account` | Merchant settings and connected wallets (keys masked) |
| `PUT` | `/v1/account/wallets` | Connect public wallet keys or addresses |
| `PUT` | `/v1/account/webhook` | Set the webhook URL or rotate its signing secret |
| `POST` | `/v1/webhooks/test` | Queue a `webhook.test` event |
| `GET` | `/v1/public/invoices/{id}` | Checkout view of an invoice (no API key); adds `transactions` and `confirmation_eta_seconds` |
| `POST` | `/v1/public/invoices/{id}/payment` | Customer picks `asset` and `network` (no API key) |
| `POST` | `/v1/public/invoices/{id}/cancel` | Customer cancels an unpaid invoice (no API key) |

The dashboard uses the same services under `/v1/dashboard/*` with session cookies and CSRF protection instead of API keys. Dashboard-only routes include `GET /v1/dashboard/invoices/{id}` (invoice with `timeline`, on-chain payments and webhook deliveries), `GET /v1/dashboard/audit-log` (`limit`, `cursor`, and `action` as an area such as `wallet` or an exact action such as `wallet.added`) and `GET /v1/dashboard/audit-log/verify` (`{ intact, entries, broken_at }`).

## Creating invoices

`amount` (decimal string) and `currency` are required. `currency` is an ISO code such as `EUR`, `USD`, `GBP` or `CHF`, or the asset code itself for invoices priced in crypto. Optional fields are `asset`, `network`, `order_id`, `success_url`, `cancel_url`, `webhook_url` and `metadata`. Unknown fields are rejected.

- **Without `asset`/`network`** the invoice starts in `created`. The checkout shows every coin that is available to the merchant; when the customer picks one, the quote locks and the invoice moves to `awaiting_payment`. The customer has `CHECKOUT_SELECTION_MINUTES` (default 60) to choose, then `INVOICE_EXPIRY_MINUTES` (default 15) to pay.
- **With `asset` and `network`** the quote locks immediately. `network` is required when a coin exists on several networks.

Fiat quotes use the live rate, are rounded **up** to the asset's smallest unit and to at most 8 decimal places, so the merchant never receives less than asked. `exchange_rate` records the rate used.

A coin is `available` only when the merchant connected a wallet for its network and, unless `CHECKOUT_REQUIRE_LIVE_SCANNER=false`, the worker scanned that network without errors in the last 10 minutes. That way customers are never sent to a chain that nobody watches.

```http
POST /v1/invoices HTTP/1.1
Authorization: Bearer ob_live_<secret>
Idempotency-Key: order-1042
Content-Type: application/json

{"amount":"49.90","currency":"EUR","order_id":"1042","success_url":"https://shop.example/orders/1042"}
```

Reusing an idempotency key with the same body returns the original invoice; reusing it with a different body returns `409 idempotency_key_conflict`.

## Invoice object

```json
{
  "id": "2d02866f-8d21-42d3-b116-64e8340d7ed2",
  "order_id": "1042",
  "amount": "49.90",
  "currency": "EUR",
  "crypto_amount": "0.00067874",
  "asset": "BTC",
  "network": "bitcoin",
  "address": "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  "status": "awaiting_payment",
  "checkout_url": "https://pay.example/checkout/2d02866f-8d21-42d3-b116-64e8340d7ed2",
  "received_amount": "0",
  "surplus_amount": "0",
  "exchange_rate": "73519",
  "confirmations": null,
  "required_confirmations": 2,
  "expires_at": "2026-10-19T13:10:39.518Z",
  "created_at": "2026-10-19T12:55:39.354Z",
  "updated_at": "2026-10-19T12:55:39.354Z",
  "metadata": {}
}
```

`crypto_amount`, `asset`, `network`, `address`, `exchange_rate` and `required_confirmations` are `null` while the invoice is `created`. `confirmations` is the lowest confirmation count across the transfers seen so far (`null` before the first one); the invoice turns `paid` when it reaches `required_confirmations`, which is fixed when the coin is picked (defaults per network, override with `CONFIRMATIONS_<NETWORK>`, for example `CONFIRMATIONS_BITCOIN=3`). Amounts are strings in whole units of `asset`; timestamps are ISO 8601 UTC.

## Statuses

| Status | Meaning |
| --- | --- |
| `created` | Waiting for the customer to choose a coin |
| `awaiting_payment` | Quote locked, nothing received yet |
| `detected` | A transfer is seen but not yet confirmed |
| `confirming` | The full amount arrived and is collecting confirmations |
| `underpaid` | Less than the quoted amount arrived; the customer can send the rest |
| `overpaid` | More than the quoted amount arrived and is collecting confirmations |
| `paid` | The full amount is confirmed. Fulfil the order. A non-zero `surplus_amount` means the customer sent more |
| `expired` | The window closed without full payment |
| `late_payment` | New funds arrived after expiry or cancellation; review manually |
| `cancelled` | Cancelled before any funds arrived |

## Errors

Errors use `{ "error": { "code": "...", "message": "...", "param": "..." } }`. Common codes: `invalid_request`, `unauthorized`, `idempotency_key_conflict`, `unsupported_asset_network`, `network_required`, `wallet_not_configured`, `no_payment_options`, `unsupported_currency`, `rate_unavailable`, `invoice_not_found`, `invoice_not_cancellable`.

Webhook setup and delivery are described in [webhooks.md](./webhooks.md).
