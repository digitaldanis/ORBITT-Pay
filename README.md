# ORBITT PAY

![ORBITT PAY — Payments for every chain](./orbittpaybanner.png)

**Payments for every chain.** ORBITT PAY is a self-hosted, non-custodial crypto payment processor for online shops. Merchants connect public wallet keys; ORBITT PAY quotes an exact amount, gives every invoice its own receiving address, watches the chain, and tells the shop through signed webhooks when the payment is confirmed. Funds go straight to the merchant's wallets.

## What it does

- **24 coins and tokens on 10 mainnets** (plus Bitcoin testnet and Sepolia for testing): BTC, LTC, ETH (Ethereum, Base, Arbitrum, Optimism), POL, BNB, TRX, SOL, plus USDT and USDC wherever they exist natively, including TRC-20 and SPL.
- **Customer picks the coin.** Create a payment link with just a fiat amount; the customer chooses coin and network at checkout and the price locks at that moment. Shops can also preselect a coin through the API.
- **Exact amounts.** Quotes are rounded up to at most 8 decimals, so the merchant never receives less than the asking price. Underpaid, overpaid and late payments are tracked separately, and the customer sees the remaining amount.
- **A unique address per invoice.** BIP84 (BTC, LTC), BIP44 (EVM, TRON) child addresses come from the merchant's account xpub. Solana has no public derivation, so each invoice gets a unique amount on the merchant's address instead.
- **Hosted checkout** in English and German: QR codes with wallet deep links (BIP21, EIP-681, Solana Pay), copy buttons, a live countdown and a confirmation timeline.
- **Merchant dashboard:** volume chart, invoice search and detail drawer with on-chain payments and webhook history, payment links, wallet setup per network with live scanner health, webhook retries and API keys.
- **Signed webhooks** (HMAC-SHA256) through a PostgreSQL outbox with retries and an encrypted signing secret.
- **JavaScript SDK** with a typed client and a webhook verifier.

## Architecture

```mermaid
flowchart LR
  Shop[Merchant shop] -->|REST API + SDK| API[Fastify API]
  Customer -->|Hosted checkout| Checkout[React checkout]
  Checkout -->|Public invoice API| API
  Dashboard[Merchant dashboard] -->|Session API| API
  API --> DB[(PostgreSQL)]
  Worker[Worker] --> DB
  Worker -->|Esplora| UTXO[Bitcoin / Litecoin]
  Worker -->|JSON-RPC| EVM[Ethereum / L2s / Polygon / BNB]
  Worker -->|TronGrid| TRON
  Worker -->|JSON-RPC| Solana
  Worker -->|Signed delivery| Hook[Merchant webhook]
```

| Path | Purpose |
| --- | --- |
| `apps/api` | Merchant, public and dashboard API, migrations, CLIs |
| `apps/worker` | Chain scanner for every network, expiry, webhook delivery |
| `apps/checkout` | Hosted customer checkout |
| `apps/dashboard` | Merchant dashboard |
| `packages/core` | Asset catalog, money math, invoice state machine |
| `packages/chains` | Address derivation and chain watchers |
| `packages/rates` | CoinGecko rates with Kraken fallback |
| `packages/webhooks` | Signing, encryption, outbox |
| `packages/ui` | Brand mark, coin icons, design tokens |
| `packages/sdk-js` | `@orbitt/sdk` |
| `config/assets.json` | Enabled coins, networks, contracts and decimals |

## Quick start

Requirements: Docker Engine and the Compose plugin.

```sh
cp .env.example .env
# Set POSTGRES_PASSWORD and APP_ENCRYPTION_KEY (openssl rand -base64 32) in .env,
# and the chain endpoints for the networks you want to accept.
docker compose up --build -d
docker compose exec api npm run api-key:create --workspace apps/api -- "Example Shop"
```

Checkout runs on `http://localhost:8080`, the dashboard on `http://localhost:8081`, and API docs at `http://localhost:8080/docs`. Create a dashboard user as described in [the dashboard guide](./docs/dashboard.md), then connect a wallet per network under **Assets**.

See [deployment](./docs/deployment.md) for HTTPS, backups and restores, and the [integration guide](./docs/integration.md) to connect a shop.

## Development

Requirements: Node.js 22 or newer, npm and Docker.

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```

The PostgreSQL integration test runs the full payment flow (coin selection, partial and full payment, confirmations, webhooks, Solana unique amounts, expiry and late payments) when `TEST_DATABASE_URL` is set:

```sh
docker run -d --name orbitt-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
```

For a local demo with sample data, migrate a database and run `npm run demo:seed --workspace apps/api`, then start the API with `CHECKOUT_REQUIRE_LIVE_SCANNER=false` and the frontends with `npm run dev --workspace apps/checkout` and `npm run dev --workspace apps/dashboard`.

## Before taking real payments

- Run the worker against your own RPC providers and make test payments on each network you enable.
- EVM, TRON and Solana transfers are accepted after the configured confirmations, but a transfer that a chain reorganization removes later is not rolled back automatically. Keep confirmation counts conservative.
- Internal EVM transfers (value sent by a contract) are not detected; customers must pay from a regular wallet or exchange withdrawal that makes a direct transfer.
- Dashboard two-factor authentication is not implemented yet.

Read the [chain watcher notes](./docs/chain-watchers.md), [security and legal notes](./docs/legal.md) and [architecture decisions](./docs/decisions.md).

## Security

Never put private keys, seed phrases, production API keys or a populated `.env` in this repository. ORBITT PAY accepts only public keys and addresses and rejects anything that looks like a private key or seed phrase. See the [security notes](./docs/legal.md).

## License

Proprietary. All rights reserved. W-Digital (hallo@w-digital.eu). See [LICENSE](./LICENSE).
