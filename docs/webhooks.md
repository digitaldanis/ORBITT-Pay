# Webhooks

Webhook deliveries use a PostgreSQL outbox. Every invoice change and its event are committed in one transaction, so an event is never lost or sent for a change that rolled back. The worker claims due deliveries with `FOR UPDATE SKIP LOCKED`, records each attempt, and recovers expired worker leases.

## Configure

Set `APP_ENCRYPTION_KEY` to a canonical base64 value containing 32 random bytes. Generate one with:

```sh
openssl rand -base64 32
```

Send `PUT /v1/account/webhook` with `{"url":"https://shop.example/webhooks/orbitt"}`. The first configuration returns a `signing_secret` once; store it in the merchant's secret manager. The API encrypts the secret with AES-256-GCM before storing it. Rotating with `{"url":"https://shop.example/webhooks/orbitt","rotate_secret":true}` returns a new secret once. Pending deliveries retain an encrypted snapshot of the secret that was active when the event was queued.

Production webhook targets must use HTTPS and cannot contain URL credentials. The worker rejects localhost and private-network DNS/IP targets, does not follow redirects, and limits each request to ten seconds. An invoice can override the account webhook URL with `webhook_url` while using the account signing secret.

## Signature verification

The request body is JSON. `ORBITT-Signature` has `t=<unix-seconds>,v1=<hex-hmac>`. Compute HMAC-SHA256 over the exact raw request bytes prefixed by the timestamp and a period:

```text
HMAC_SHA256(signing_secret, timestamp + "." + raw_body)
```

Compare the digest with `v1` using a constant-time comparison and reject timestamps more than five minutes from the current time. Verify before parsing or reserializing the body. `ORBITT-Event` contains the event name, and `ORBITT-Delivery` is a stable delivery ID across retries.

## Events

Every event body is `{ "event": "...", "created_at": "...", "invoice": { ...invoice object } }` with the same invoice shape as the API.

| Event | When |
| --- | --- |
| `invoice.created` | Invoice created through the API or dashboard |
| `invoice.detected` | First transfer seen, not yet confirmed |
| `invoice.confirming` | Full amount seen, waiting for `required_confirmations`; `invoice.confirmations` shows progress |
| `invoice.underpaid` | Less than the quoted amount arrived |
| `invoice.overpaid` | More than the quoted amount arrived |
| `invoice.paid` | Full amount confirmed: fulfil the order |
| `invoice.expired` | Window closed without full payment |
| `invoice.late_payment` | New funds after expiry or cancellation |
| `invoice.cancelled` | Cancelled by merchant or customer |
| `webhook.test` | Sent from the dashboard or `POST /v1/webhooks/test` |

Events written in one database transaction (for example `invoice.detected` followed by `invoice.underpaid`) are queued in that order. Only `invoice.paid` should release goods.

## Retries

Any 2xx response counts as delivered. Other responses and network errors retry after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, then the delivery is marked `failed`. Failed or delivered events can be sent again from the dashboard (**Webhooks → Retry**, or the invoice drawer). Delivery is at least once: deduplicate with `ORBITT-Delivery`.

For local development against a webhook receiver on `localhost`, set `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`. The setting is ignored when `NODE_ENV=production`.

Each attempt stores its timestamp, HTTP status, and a sanitized error code. Response bodies and signing secrets are not logged. The webhook package exposes `signWebhook`, `verifyWebhookSignature`, `encryptSecret`, `decryptSecret` and `enqueueInvoiceEvent` for trusted server-side use. Shops should use `constructWebhookEvent` from `@orbitt/sdk`.
