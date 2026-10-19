# Architecture decisions

Authorship: W-Digital (hallo@w-digital.eu)

## Initial defaults

- Runtime: Node.js 22 LTS with strict TypeScript.
- Workspaces: npm workspaces to keep the initial toolchain small and broadly available.
- API framework, database ORM, and queue implementation will be recorded here when the core domain milestone selects them.
- Quote window: 15 minutes.
- Fiat base currencies: EUR and USD.
- Fee model: configurable, default 0%.
- Overpayment: accepted as paid, with surplus recorded for merchant review.
- License: proprietary, all rights reserved, by W-Digital.

## Repository setup

The repository starts as an npm workspace monorepo. Applications and packages are added as each milestone is implemented.

## Core domain and persistence

- API framework: Fastify, with schemas used to publish the OpenAPI contract.
- Database: PostgreSQL with Drizzle ORM and SQL migrations.
- Queue and scheduling: pg-boss, using PostgreSQL to reduce infrastructure moving parts.
- Exchange rates are expressed as fiat major units per one crypto unit; conversions divide fiat value by that rate and round the required base-unit amount upward.
- Initial rate sources: CoinGecko Simple Price with Kraken public ticker fallback. Cache for 20 seconds and reject source data older than 120 seconds by default.
