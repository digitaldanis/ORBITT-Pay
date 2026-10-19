# Merchant dashboard

The dashboard is the React app in `apps/dashboard`. It uses server-side login sessions; no API key is bundled into browser code or stored in local storage.

## Create the first dashboard user

After creating a merchant and applying migrations, set a strong password in the ignored local `.env` file as `DASHBOARD_USER_PASSWORD`, then run:

```sh
npm run dashboard:user:create --workspace apps/api -- <merchant-uuid> owner@example.com
```

The CLI hashes the password with Argon2id and writes only the hash to PostgreSQL. The user can then sign in at the dashboard.

## Run locally

```sh
npm run dev --workspace apps/dashboard
```

Vite proxies `/v1` to the API at `http://localhost:3000`. Production should serve the dashboard and API at one origin or configure `VITE_API_BASE_URL` and the reverse proxy together.

Sessions use random tokens stored as SHA-256 hashes, expire after eight hours, and are sent in HTTP-only, `SameSite=Strict` cookies (`Secure` in production). State-changing dashboard requests require a matching CSRF cookie and header. Login is rate-limited per IP. Password verification uses Argon2id with a dummy hash for unknown accounts to reduce email enumeration timing differences.

The dashboard supports overview counts, invoice and payment lists, webhook delivery history, public wallet configuration, API key creation/revocation, and webhook settings. Full API keys and webhook signing secrets are shown only at creation or rotation. Optional TOTP enrollment and invoice detail timelines are not implemented yet.
