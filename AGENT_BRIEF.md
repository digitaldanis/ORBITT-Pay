# ORBITT PAY — Agent Brief

Build **ORBITT PAY**: a self-hosted, non-custodial crypto payment processor for online shops. Merchants create payment invoices through an API or hosted checkout page; customers pay the exact crypto amount to a unique address shown as a QR code; the system detects the payment on-chain and notifies the merchant via webhook.

Benchmark: NOWPayments and HoodPay, but cleaner, faster, more transparent, and easier to self-host.

Tagline: **PAYMENTS FOR EVERY CHAIN**

---

## 0. Non-negotiable rules

### Git and repository
- Repository: `https://github.com/digitaldanis/ORBITT-Pay`
- **Commit and push everything to this repository.** Work on `main` (or feature branches merged to `main`).
- Git identity for every commit: author and committer **hallo@w-digital.eu**. Set it locally in the repo:
  ```
  git config user.email "hallo@w-digital.eu"
  git config user.name "ORBITT PAY"
  ```
- **Never add `Co-Authored-By` trailers, "Generated with" lines, or any other co-author or AI attribution** to commits, PR descriptions, README, docs, or code comments.
- Commit messages: short, imperative, English, describe the change (e.g. `Add invoice expiry worker`).
- Commit in small logical steps. Push after each working milestone.

### Project documentation
- Do not mention AI, LLMs, or any AI tool as the author of this project anywhere in the repository (README, CONTRIBUTING, CHANGELOG, license headers, docs).
- Authorship in all docs: **W-Digital (hallo@w-digital.eu)**.

### Security and custody
- **Non-custodial by design.** The server never stores or sees merchant private keys or seed phrases. Merchants supply *public* keys (xpub/zpub, EVM address, Solana/Tron addresses). The system only derives and watches addresses.
- Never log secrets, API keys in full, webhook secrets, or private data.
- Never commit `.env` files, keys, mnemonics, or real API credentials. Provide `.env.example` only.

---

## 1. Product scope

### Core flow
1. Merchant creates an **invoice** via API: `amount` + `currency` (fiat, e.g. EUR/USD) or a crypto amount, plus `order_id`, optional `success_url`, `cancel_url`, `metadata`, and `webhook_url`.
2. System **locks a quote**: fiat → crypto rate at creation time, valid for a fixed window (default 15 minutes, configurable). The exact crypto amount is stored on the invoice.
3. Customer chooses a coin/network on the hosted checkout page (or it is pre-selected via API).
4. System assigns a **unique receiving address** to the invoice (see §3).
5. Checkout page shows: exact amount, address, QR code, countdown timer, status (waiting → detected → confirming → paid / expired / underpaid / overpaid).
6. Watcher detects incoming transfers, counts confirmations, and updates invoice status.
7. On `paid`, system sends a **signed webhook** to the merchant. Merchant can also poll `GET /invoices/{id}`.

### Supported assets (phase 1)
- **Bitcoin** (BTC) — native SegWit, Taproot
- **Litecoin** (LTC)
- **Ethereum** (ETH) and **EVM networks**: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain
- **ERC-20 / EVM tokens**: USDT, USDC (per network), with token contract config per network
- **Solana** (SOL, USDC/USDT SPL)
- **Tron** (TRX, USDT-TRC20)
- Coin list must be **config-driven** (JSON/YAML), so new coins are added without code changes where possible.

### Phase 2 (design for it, do not build yet)
- Monero (view-key based watching), XRP, more L2s, Lightning (via LNbits/LND adapter)
- Shopify / WooCommerce / Shopify plugin
- Payouts / auto-conversion
- Multi-user team accounts

---

## 2. Architecture

Monorepo, TypeScript end-to-end.

```
ORBITT-Pay/
├── apps/
│   ├── api/            # REST API (merchant API + internal)
│   ├── dashboard/      # Merchant dashboard (Apple-style UI, see §6)
│   ├── checkout/       # Hosted checkout page (public, customer-facing)
│   └── worker/         # Chain watchers, confirmation tracker, webhook dispatcher, expiry jobs
├── packages/
│   ├── core/           # Domain logic: invoices, quotes, status machine, amounts (bigint / decimal math)
│   ├── chains/         # Chain adapters: derivation + watching, one module per chain family
│   ├── rates/          # Price feeds with fallback and caching
│   ├── webhooks/       # Signing, delivery, retry
│   ├── sdk-js/         # Official Node/browser client for merchants
│   └── ui/             # Shared design tokens and components
├── docker/             # docker-compose: api, worker, postgres, redis
├── docs/               # API reference, integration guide, architecture
├── .env.example
├── README.md
└── AGENT_BRIEF.md
```

### Stack (defaults — change only with a written reason in `docs/decisions.md`)
- Runtime: Node.js 22 LTS, TypeScript strict mode
- API: Fastify (or Hono), OpenAPI spec generated from schemas
- DB: PostgreSQL + Drizzle ORM (or Prisma)
- Queue / scheduling: Redis + BullMQ (or pg-boss to reduce moving parts)
- Dashboard and checkout: Next.js (App Router) or Vite + React
- Tests: Vitest for unit and integration; Playwright for checkout E2E
- Container: Docker + docker-compose for one-command self-hosting

### Money handling (critical)
- **Never use JavaScript floats for money.** Store amounts as integers in the smallest unit (`satoshi`, `wei`, `lamports`, token base units) as `bigint` or string-encoded integers.
- Exchange rates use decimal math (e.g. `decimal.js` or `big.js`), rounded **up** to the coin's smallest unit when computing the amount the customer must send.
- Every invoice stores: `fiat_amount`, `fiat_currency`, `rate_used`, `rate_timestamp`, `crypto_amount_base_units`, `asset`, `network`, `address`, `expires_at`.

---

## 3. Exact-amount and address logic

This is the core. Follow these rules exactly.

### 3.1 Address assignment
- **Preferred: one unique address per invoice.**
  - UTXO chains (BTC, LTC): derive from the merchant's **xpub/zpub** at the next unused index (BIP32/BIP84). Track `derivation_index` per merchant per chain. Address is reserved for the invoice until it is `expired` or `closed`, then it may be reused only after the funds are confirmed as final.
  - EVM chains: derive child addresses from the merchant's xpub (BIP44 path `m/44'/60'/0'/0/{index}`) or from a merchant-provided EVM address with a per-invoice amount offset (fallback, see 3.2).
  - Solana and Tron: derive per-invoice addresses from the merchant's seed-derived public key set, or use the per-invoice amount-offset method.
- Derivation must be **deterministic and auditable**: store the derivation path with each invoice.
- **Never** reuse an address for two open invoices on the same asset and network.

### 3.2 Amount matching (when addresses cannot be unique)
- If a shared address must be used, make the **amount unique** by adding a small, invoice-specific offset in base units, so the payment identifies the invoice uniquely.
- The offset must stay within a configured tolerance (e.g. ≤ 0.5% or a fixed max in fiat) and must not collide with another open invoice on the same address.
- Document the trade-off clearly in the docs.

### 3.3 Payment matching rules
For each invoice, the watcher evaluates incoming transfers to the invoice's address:

| Received amount | Result |
|---|---|
| `= expected` | `paid` (after required confirmations) |
| `< expected` | `underpaid`; keep the address open until expiry; allow top-up within the window |
| `> expected` | `overpaid`; mark as paid, record surplus, flag for merchant review. Configurable: accept or treat as paid with surplus |
| Multiple transfers | Sum them within the window. Status depends on the total |
| Transfer after expiry | `late_payment`; record it, notify merchant, do not auto-credit |
| Token transfer, wrong token | Ignore for this invoice, record as `unmatched_transfer` |

- Required confirmations are **per asset/network** and configurable (e.g. BTC 2, ETH 12, SOL finalized, TRX 19, EVM L2 1).
- Status machine: `created → awaiting_payment → detected → confirming → paid`, plus `underpaid`, `overpaid`, `expired`, `late_payment`, `cancelled`. Transitions are enforced in `packages/core`, not in the API layer.

### 3.4 Expiry
- Invoice expires after its window. A background job sets `expired` and releases the address for reuse, unless a transfer is already `detected`.

---

## 4. QR codes and payment URIs

- Generate QR codes server-side (SVG preferred for crisp rendering) and client-side as fallback.
- Use standard URIs so wallets pre-fill address and amount:
  - Bitcoin: `bitcoin:<address>?amount=<BTC decimal>` (BIP21)
  - Litecoin: `litecoin:<address>?amount=<LTC decimal>`
  - Ethereum / EVM native: EIP-681 `ethereum:<address>@<chainId>?value=<wei>`
  - EVM token: EIP-681 `ethereum:<tokenContract>@<chainId>/transfer?address=<recipient>&uint256=<base units>`
  - Solana: Solana Pay `solana:<address>?amount=<decimal>&spl-token=<mint>`
  - Tron: `tron:<address>?amount=<decimal>` (best effort, document wallet support gaps)
- The page always shows the **exact amount** with a copy button, the **address** with a copy button, and a **countdown** until expiry.
- Show a clear warning: send only on the selected network. Wrong-network sends are not recoverable by the system.

---

## 5. API (merchant-facing)

Base path: `/v1`. Auth: `Authorization: Bearer <secret_key>`. Publishable keys for client-side use.

Endpoints:
- `POST /v1/invoices` — create invoice; returns `id`, `checkout_url`, quote, expiry
- `GET /v1/invoices/{id}` — status and details
- `GET /v1/invoices?status=&limit=&cursor=` — list, cursor pagination
- `POST /v1/invoices/{id}/cancel`
- `GET /v1/assets` — enabled coins and networks
- `POST /v1/webhooks/test` — send test event
- `GET /v1/account` — merchant settings (addresses/xpubs, confirmations, fees)
- `PUT /v1/account/wallets` — set xpub/zpub and EVM/Solana/Tron payout or derivation addresses per asset

Requirements:
- Idempotency keys on `POST` (`Idempotency-Key` header), stored for 24 h
- Consistent error format: `{ "error": { "code": "...", "message": "...", "param": "..." } }`
- Rate limiting per key
- OpenAPI 3.1 spec auto-published at `/v1/openapi.json`
- All timestamps in ISO 8601 UTC

### Webhooks
- Events: `invoice.created`, `invoice.detected`, `invoice.paid`, `invoice.underpaid`, `invoice.overpaid`, `invoice.expired`, `invoice.late_payment`, `invoice.cancelled`
- Signed with HMAC-SHA256 over `timestamp.body`, header `ORBITT-Signature: t=...,v1=...`
- Replay protection: reject timestamps older than 5 minutes in the SDK verifier
- Retries with exponential backoff (e.g. 1 min, 5 min, 30 min, 2 h, 12 h, then stop). Every attempt logged; manual redeliver in dashboard.
- Webhook payloads always include the full invoice object and the `event` type.

### SDK
- `@orbitt/sdk` (TypeScript): create invoice, verify webhook signature, typed events.
- Minimal integration example in `docs/integration.md` for a generic shop (Node/Express) and a plain HTML snippet.

---

## 6. Design — Apple style, ORBITT brand

Reference: the banner at `/home/link/orbittpay/orbittpaybanner.png`. The logo is the orbit mark (purple-to-blue gradient ring with a small blue planet dot), the wordmark `ORBITT PAY` (white `ORBITT` + gradient `PAY`), and the tagline `PAYMENTS FOR EVERY CHAIN` in widely tracked uppercase grey. Background is near-black with a soft blue-violet planet glow and thin orbit lines.

### Brand tokens (approximate, sampled from the banner)
```
--ob-bg:          #04050C   /* base background */
--ob-surface:     #0B0F1A   /* cards */
--ob-surface-2:   #121829   /* elevated / hover */
--ob-border:      rgba(255,255,255,0.08)
--ob-text:        #F5F7FF
--ob-text-muted:  #8A90A8
--ob-violet:      #7B5CFA
--ob-blue:        #4AA8F5
--ob-gradient:    linear-gradient(90deg, #7B5CFA 0%, #4AA8F5 100%)
--ob-success:     #34D399
--ob-warning:     #FBBF24
--ob-danger:      #F87171
```
Light mode: optional, same tokens inverted, keep the gradient accent.

### Visual rules
- Apple-like: generous whitespace, large clear typography, subtle depth (soft shadows, 1 px hairline borders, light blur on overlays), rounded corners 16–24 px, smooth 200–300 ms easing.
- Font: SF Pro on Apple devices, otherwise **Inter** (or Montserrat to match the banner wordmark for headings). Tight tracking on headlines, wide tracking on uppercase labels.
- One accent gradient, used sparingly: primary buttons, the `PAY` wordmark part, progress indicators.
- Iconography: SF Symbols style, 1.5 px stroke, consistent size.
- Motion: subtle orbit animation on the logo mark while a payment is pending; a checkmark animation on `paid`.
- Dark mode is the default. Respect `prefers-color-scheme`.
- No stock photos. Use the banner as hero art on the landing page and checkout header.

### Hosted checkout page
- Single centered card, max width 420 px.
- Top: merchant name and order ID. Middle: exact amount in large type, coin and network badge, QR code, address with copy button, countdown ring. Bottom: status timeline and "Cancel" link.
- Must work perfectly on a phone (QR is most important there).
- Accessible: WCAG AA contrast, keyboard navigable, live region for status changes.

### Merchant dashboard
- Sidebar navigation: Overview, Invoices, Payments, Webhooks, Assets, API keys, Settings.
- Overview: volume by day, paid / pending / expired counts, recent invoices.
- Invoice detail: timeline of events, on-chain transactions with explorer links, webhook delivery log with redeliver button.
- Settings: wallets (xpub/zpub and addresses), confirmation thresholds, underpayment/overpayment policy, expiry window, webhook URL and secret rotation.

---

## 7. Security checklist

- API keys: generated with 256 bits of entropy, shown once, stored as hashed values only.
- Dashboard auth: email + password (argon2id) with optional TOTP 2FA. Sessions in httpOnly, Secure, SameSite=Strict cookies.
- CSRF protection on all state-changing dashboard routes.
- Input validation on every endpoint (zod or equivalent). Reject unknown fields on write endpoints.
- Rate limits on auth, invoice creation, and webhook test endpoints.
- Blockchain data is untrusted input. Validate addresses, amounts, and token contracts before writing to the DB.
- Chain watchers use multiple RPC providers with failover and compare results when a payment is high value.
- Dependency audit in CI (`npm audit` or equivalent). Lockfile committed.
- Logs must not include full API keys, webhook secrets, or xpubs in full (show a masked form).
- Backups: documented procedure for PostgreSQL; invoices and derivation indexes are critical data.

---

## 8. Testing and quality

- Unit tests for: amount math (rounding up, base units), status machine transitions, address derivation (test vectors from BIP32/BIP84 specs), webhook signing and verification, QR URI generation.
- Integration tests with local chain nodes or recorded RPC fixtures for each chain family.
- Testnets for development: Bitcoin testnet/signet, Sepolia, Solana devnet, Tron Nile.
- E2E test: create invoice → pay on testnet → webhook delivered → status `paid`.
- CI on every push: typecheck, lint, unit tests, build, Docker build.
- Coverage target for `packages/core` and `packages/chains`: at least 85%.

---

## 9. Deliverables and order of work

Work in this order. Commit and push after each step.

1. **Repo setup**: monorepo, TypeScript strict, lint, test runner, CI workflow, `.env.example`, README skeleton with banner and logo.
2. **Core domain**: amount math, status machine, invoice model, DB schema and migrations.
3. **Address derivation**: BIP32/BIP84 for BTC/LTC, BIP44 for EVM, with test vectors.
4. **Rates service**: at least two price sources, caching, fallback, staleness check.
5. **Chain watchers**: BTC, EVM (native + ERC-20), Solana, Tron. Each with confirmation tracking.
6. **Merchant API** + OpenAPI spec + idempotency.
7. **Webhooks**: signing, delivery worker, retries, delivery log.
8. **Hosted checkout** with QR codes, countdown, live status updates (SSE or polling).
9. **Merchant dashboard** in the Apple style described in §6.
10. **Docker compose** for one-command self-hosting, deployment docs.
11. **SDK** and integration docs.
12. **Security pass** against §7, then end-to-end tests on testnets.
13. **README** with banner, feature list, quick start, architecture diagram, and license.

Each step must leave the repo in a working state with passing tests.

---

## 10. Open decisions to confirm with the owner

Do not block on these. Use the defaults below, record each choice in `docs/decisions.md`, and continue.

- **Quote window**: default 15 minutes.
- **Overpayment**: default = accept as `paid`, record surplus, flag for review.
- **Fiat base currencies**: EUR and USD. Other currencies via config.
- **Fees**: default 0% in the code. Fee model is a config value, not hard-coded.
- **License**: default proprietary, all rights reserved, by W-Digital. Change only if told.
- **Regulatory note**: a non-custodial processor may still fall under payment or crypto-asset regulation (e.g. EU MiCA, German KWG/ZAG) depending on how it is operated and marketed. Add a short disclaimer in `docs/legal.md` and flag this for legal review. Do not present it as legal advice.

---

## 11. Definition of done

- A merchant can sign up, add an xpub, create an invoice via API, pay on testnet with the exact amount shown in the QR code, and receive a verified webhook with status `paid`.
- All code, docs, and commits live in `https://github.com/digitaldanis/ORBITT-Pay`, authored by **hallo@w-digital.eu**, with no AI or co-author attribution anywhere.
- Tests pass in CI. README and docs are complete. The UI matches §6.
