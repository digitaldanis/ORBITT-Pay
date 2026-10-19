# ORBITT PAY

![ORBITT PAY — Payments for every chain](./orbittpaybanner.png)

**Payments for every chain.** ORBITT PAY is a planned self-hosted, non-custodial crypto payment processor for online shops. Merchants configure public wallet keys or addresses; the service creates invoices, watches for payments, and sends signed webhooks.

> Project status: initial repository setup. Invoice processing and chain integrations are not implemented yet.

## Design principles

- Non-custodial: merchant private keys and seed phrases never enter the service.
- Exact amounts: payment values use integer base units and decimal exchange-rate math.
- Self-hosted: deployment configuration and operational documentation are part of the product.
- Multi-chain: asset and network support is configuration-driven.

## Repository layout

```text
apps/       API, dashboard, checkout, and worker applications
packages/   Domain, chain, rates, webhook, SDK, and UI packages
docker/     Local and self-hosted deployment configuration
docs/       Architecture, API, integration, and operations documentation
```

## Development

Requirements: Node.js 22 LTS and npm.

```sh
cp .env.example .env
npm ci
npm run typecheck
npm run lint
npm test
```

The complete deployment flow will be documented with the Docker Compose milestone.

## Security

Never put private keys, seed phrases, production API credentials, or populated `.env` files in this repository. See [AGENT_BRIEF.md](./AGENT_BRIEF.md) for the project requirements and [docs/decisions.md](./docs/decisions.md) for recorded defaults.

## License

Proprietary. All rights reserved. W-Digital (hallo@w-digital.eu).
