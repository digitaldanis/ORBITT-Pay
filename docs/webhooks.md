# Webhooks

Webhook deliveries use a PostgreSQL outbox. Invoice creation and its `invoice.created` outbox record are committed in one transaction. The worker claims due deliveries with `FOR UPDATE SKIP LOCKED`, records each attempt, and recovers expired worker leases.

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

## Events and retry schedule

`invoice.created` is queued with the full invoice object. `POST /v1/webhooks/test` queues a `webhook.test` event. The worker considers any 2xx response delivered; other responses and network errors retry after 1 minute, 5 minutes, 30 minutes, 2 hours, and 12 hours, then stop. This is at least once delivery: merchant handlers should deduplicate using `ORBITT-Delivery`.

Each attempt stores its timestamp, HTTP status, and a sanitized error code. Response bodies and signing secrets are not logged. The webhook package exposes `signWebhook`, `verifyWebhookSignature`, `encryptSecret`, and `decryptSecret` for trusted server-side use.
