# Merchant API

The API is versioned under `/v1`. A Fastify server factory is exported by `@orbitt/api`; the deployment composition root supplies persistence and payment-domain services through `ApiServices`.

## Authentication

Send `Authorization: Bearer <secret_key>` on merchant endpoints. API keys are generated with 256 bits of random entropy by `createApiKey()`. Persist only the returned SHA-256 `hash`, `prefix`, merchant ID, and key name in `api_keys`; show the `secret` once and do not log it. Authentication uses the hash for lookup, and rate limits are keyed by the hash so the bearer value is never used as a log label. Revoke a key by setting `revoked_at`.

The public health endpoint is `GET /health`. The generated OpenAPI 3.1 document is available at `GET /v1/openapi.json`, and Swagger UI at `/docs`.

Initialize the database with `npm run db:migrate --workspace apps/api`, create the first merchant with `npm run api-key:create --workspace apps/api -- "Shop name"`, then start the API with `npm run start --workspace apps/api`. Set `DATABASE_URL`, `PUBLIC_BASE_URL`, and `PORT` in the environment. `ORBITT_ASSETS_FILE` and `ORBITT_RATE_ASSETS_FILE` can point to alternate JSON configurations.

The initial invoice preparer supports BTC and LTC receive derivation plus native ETH on the configured EVM networks. Each invoice requires a configured account-level public key (`zpub` for BTC, an accepted account xpub for LTC, or an account xpub for EVM). Fiat quotes currently use EUR/USD provider configuration. Add token contract and precision entries to the asset configuration before enabling token invoices. Address-only wallets are stored for later network integrations but cannot currently allocate unique invoice addresses.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/invoices` | Create an invoice; requires `Idempotency-Key` |
| `GET` | `/v1/invoices/{id}` | Read one merchant invoice |
| `GET` | `/v1/invoices` | List invoices with status and cursor filters |
| `POST` | `/v1/invoices/{id}/cancel` | Cancel an unpaid invoice |
| `GET` | `/v1/assets` | List enabled assets and networks |
| `GET` | `/v1/account` | Read merchant settings |
| `PUT` | `/v1/account/wallets` | Save public wallet configuration |
| `PUT` | `/v1/account/webhook` | Set webhook URL or rotate its signing secret |
| `POST` | `/v1/webhooks/test` | Request a test webhook |

Invoice create accepts a decimal string `amount` and `currency`, with optional `asset`, `network`, `order_id`, `success_url`, `cancel_url`, `webhook_url`, and `metadata`. Unknown top-level fields are rejected. Reusing an idempotency key with a different request must return `409 idempotency_key_conflict`; the service implementation is responsible for persisting the request hash and response for 24 hours as specified by the API contract.

Errors use `{ "error": { "code": "...", "message": "...", "param": "..." } }`. Amounts and timestamps are strings; timestamps are ISO 8601 UTC. The API layer does not compute rates, assign addresses, or decide invoice status; those operations belong to the injected domain services.

## Example

```http
POST /v1/invoices HTTP/1.1
Authorization: Bearer ob_live_<secret>
Idempotency-Key: order-1042
Content-Type: application/json

{"amount":"49.95","currency":"EUR","asset":"BTC","network":"bitcoin","order_id":"1042"}
```

The response includes the invoice ID, locked quote, checkout URL, status, and expiry. Keep the secret key on the merchant server; use the hosted checkout URL for the customer. Webhook URL and signing-secret setup, delivery, and retry behavior are described in [docs/webhooks.md](./webhooks.md).
