# Merchant dashboard

The dashboard is the React app in `apps/dashboard`. It uses server-side sessions; no API key is ever stored in the browser.

## Pages

- **Overview:** paid volume for the last 14 days, open and paid counts, invoices that need attention (underpaid, overpaid, late), recent activity and a setup checklist (wallet, API key, webhook).
- **Invoices / Payments:** search by order ID, invoice ID or address, filter by status, page through history and create payment links. Each invoice opens a drawer with amounts, rate, address, on-chain transfers with explorer links, its webhook deliveries (send again) and a cancel action. Invoices have deep links (`#/invoices/<id>`).
- **Assets:** one card per network listing the coins and tokens it covers. Connect, replace or remove the account public key (or the Solana address) and see the scanner's live state: last block, last scan, errors. Inputs that look like seed phrases or private keys are refused.
- **Webhooks:** recent deliveries with HTTP status, attempts and next retry; retry failed events and send test events.
- **API keys:** create keys (shown once) and revoke them.
- **Settings:** webhook endpoint and signing-secret rotation, account and security overview.

## Create the first dashboard user

After creating a merchant and applying migrations, set `DASHBOARD_USER_PASSWORD` in the ignored `.env`, then run:

```sh
npm run dashboard:user:create --workspace apps/api -- <merchant-uuid> owner@example.com
```

## Run locally

```sh
npm run dev --workspace apps/dashboard
```

Vite serves the dashboard on port 5174 and proxies `/v1` to `http://localhost:3000` (override with `ORBITT_API_PROXY`). `npm run demo:seed --workspace apps/api` creates a demo merchant and login.

## Security

Sessions are random tokens stored as SHA-256 hashes. They expire after eight hours and travel in HTTP-only, `SameSite=Strict` cookies (`Secure` in production). Every state-changing request needs a matching CSRF cookie and header. Login is rate-limited per IP and uses Argon2id with a dummy hash for unknown accounts. API keys and webhook secrets are shown only once. Two-factor authentication is not implemented yet.
