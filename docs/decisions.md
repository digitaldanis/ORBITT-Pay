# Architecture decisions

Authorship: W-Digital (hallo@w-digital.eu)

## Initial defaults

- Runtime: Node.js 22 LTS with strict TypeScript.
- Workspaces: npm workspaces to keep the initial toolchain small and broadly available.
- API framework, database ORM, and queue implementation are recorded below as milestones select them.
- Quote window: 15 minutes.
- Fiat base currencies: EUR, USD, GBP and CHF.
- Fee model: configurable, default 0%.
- Overpayment: accepted as paid, with surplus recorded for merchant review.
- License: proprietary, all rights reserved, by W-Digital.

## Repository setup

The repository starts as an npm workspace monorepo. Applications and packages are added as each milestone is implemented.

## Core domain and persistence

- API framework: Fastify, with schemas used to publish the OpenAPI contract.
- Database: PostgreSQL with Drizzle schema definitions and SQL migrations. Transaction paths use parameterized `pg` queries where explicit advisory locks and row locks are required for idempotency and address allocation.
- Queue and scheduling: PostgreSQL outbox tables and a polling worker for chain scanning, expiry and webhook delivery. This avoids a Redis dependency in the self-hosted stack.
- Exchange rates are expressed as fiat major units per one crypto unit; conversions divide fiat value by that rate and round the required base-unit amount upward.
- Initial rate sources: CoinGecko Simple Price with Kraken public ticker fallback. Cache for 20 seconds and reject source data older than 120 seconds by default.
- Webhook delivery: PostgreSQL outbox and `FOR UPDATE SKIP LOCKED` worker; signing secrets are encrypted at rest with AES-256-GCM under `APP_ENCRYPTION_KEY`, and each queued delivery retains its encrypted signing-key snapshot across rotations.
- Dashboard authentication: Argon2id password hashes, eight-hour random server-side sessions stored by token hash, HTTP-only `SameSite=Strict` cookies, and double-submit CSRF checks for state-changing requests.
- Deployment: Docker Compose with PostgreSQL as the only persistent service, separate API and worker Node processes, and Nginx static containers for checkout and dashboard. TLS is terminated by an external reverse proxy.
- SDK: `@orbitt/sdk` is an ESM TypeScript package with a Fetch-based client and Web Crypto webhook verifier. Publishing to a package registry is outside this repository build.

## Multi-chain checkout

- Asset catalog: `config/assets.json` is the single source for coins, networks, contracts, decimals and address mode. API, worker, checkout and dashboard all read it through `parseAssetCatalog`. Token entries point to the native wallet of their network (`wallet_asset`), so one key covers a chain's coin and tokens.
- Coin choice at checkout: invoices may be created with only a fiat amount (`created`). The customer's choice locks the quote. This keeps shop integrations to a single call and lets customers use what they hold.
- Quote precision: amounts are rounded up to at most 8 decimals. 18-decimal tails make amounts hard to check and type without adding safety.
- Solana uses one merchant address with unique amounts, because ed25519 has no public child derivation. Offsets are random, stay below `max_offset_base_units`, and are never reused by open invoices or invoices from the last 24 hours.
- TRON derives addresses from an account xpub at `m/44'/195'/0'`, like EVM, and settles TRC-20 tokens to the same address.
- Availability: a coin appears at checkout only if the merchant has a wallet for it and the network scanner reported healthy in the last 10 minutes. Customers are never sent to an unwatched chain.
- Address reuse: a derived address is never handed out twice on a network, even after a key change resets the derivation index. Transfers older than the coin selection are ignored.
- Webhook ordering: outbox rows use `clock_timestamp()` so several events from one transaction keep their order.
- Shared UI: `@orbitt/ui` holds the orbit mark, coin icons, explorer links and design tokens for checkout and dashboard.
- Wallet creation happens in the browser: the dashboard generates the BIP39 phrase, verifies the backup and uploads only public keys. The server never sees a secret, so a database leak cannot move funds. A custodial model with automatic forwarding was not chosen because it would hold customer money and private keys on the server.
- Required confirmations are stored on the invoice when the coin is picked (`required_confirmations`), so changing `CONFIRMATIONS_<NETWORK>` never changes the rule for an invoice already being paid. `invoice.confirming` fires once the full amount is seen.
- Known limit: transfers removed by a chain reorganization after being counted are not rolled back automatically; confirmation depth is the safeguard.

## Ledger and audit

- Status history is written by a database trigger (`invoice_status_history`), not by application code, so the API, the worker and manual SQL all leave the same trace. It backs the invoice timeline.
- `paid_at` and `closed_at` are set by trigger when an invoice first becomes paid or final. Reporting groups by `paid_at`; `updated_at` keeps moving when a late transfer or a confirmation refresh touches the row and is not a payment date.
- Amount columns stay `text` (no float ever touches money) but carry `CHECK` constraints: base units are non-negative integers, request amounts plain decimals.
- The audit log is append-only by trigger and hash-chained per merchant (`sha256(previous_hash | fields | created_at)`), with writers serialised by a per-merchant advisory lock. This makes tampering detectable without an external service. It does not stop a database superuser from rewriting the whole chain; for that, export `orbitt_verify_audit_log` results or the latest hash to separate storage.
- API-created invoices are not audited individually; their lifecycle is in the status history and the audit log stays readable at shop volume.
- The worker runs hourly maintenance: expired idempotency keys are deleted, sessions a week after they expired or were revoked.
- Connection pools set `statement_timeout` and `idle_in_transaction_session_timeout`, so a stuck query cannot hold invoice row locks. Migrations lift the statement timeout for backfills.
