# Architecture decisions

Authorship: W-Digital (hallo@w-digital.eu)

## Initial defaults

- Runtime: Node.js 22 LTS with strict TypeScript.
- Workspaces: npm workspaces to keep the initial toolchain small and broadly available.
- API framework, database ORM, and queue implementation are recorded below as milestones select them.
- Quote window: 15 minutes.
- Fiat base currencies: EUR and USD.
- Fee model: configurable, default 0%.
- Overpayment: accepted as paid, with surplus recorded for merchant review.
- License: proprietary, all rights reserved, by W-Digital.

## Repository setup

The repository starts as an npm workspace monorepo. Applications and packages are added as each milestone is implemented.

## Core domain and persistence

- API framework: Fastify, with schemas used to publish the OpenAPI contract.
- Database: PostgreSQL with Drizzle schema definitions and SQL migrations. Transaction paths use parameterized `pg` queries where explicit advisory locks and row locks are required for idempotency and address allocation.
- Queue and scheduling: PostgreSQL outbox tables and a polling webhook worker. This avoids a Redis dependency in the initial self-hosted stack. Chain scanning, expiry scheduling, and confirmation tracking remain unimplemented.
- Exchange rates are expressed as fiat major units per one crypto unit; conversions divide fiat value by that rate and round the required base-unit amount upward.
- Initial rate sources: CoinGecko Simple Price with Kraken public ticker fallback. Cache for 20 seconds and reject source data older than 120 seconds by default.
- Webhook delivery: PostgreSQL outbox and `FOR UPDATE SKIP LOCKED` worker; signing secrets are encrypted at rest with AES-256-GCM under `APP_ENCRYPTION_KEY`, and each queued delivery retains its encrypted signing-key snapshot across rotations.
- Dashboard authentication: Argon2id password hashes, eight-hour random server-side sessions stored by token hash, HTTP-only `SameSite=Strict` cookies, and double-submit CSRF checks for state-changing requests.
- Deployment: Docker Compose with PostgreSQL as the only persistent service, separate API and worker Node processes, and Nginx static containers for checkout and dashboard. TLS is terminated by an external reverse proxy.
- SDK: `@orbitt/sdk` is an ESM TypeScript package with a Fetch-based client and Web Crypto webhook verifier. Publishing to a package registry is outside this repository build.
- Product boundary: the worker scans BTC/LTC/native ETH invoice addresses, updates transfer and confirmation state, expires invoices, and dispatches webhook outbox entries. Token, Solana, and Tron scanning plus reorganization recovery are future work.
