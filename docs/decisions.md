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
