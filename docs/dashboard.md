# Merchant dashboard

The dashboard is the React app in `apps/dashboard`. It uses server-side sessions; no API key is ever stored in the browser.

## Pages

- **Overview:** paid volume for the last 14 days, open and paid counts, invoices that need attention (underpaid, overpaid, late), recent activity and a setup checklist (wallet, API key, webhook).
- **Invoices / Payments:** search by order ID, invoice ID or address, filter by status, page through history and create payment links. Each invoice opens a drawer with amounts, rate, address, on-chain transfers with explorer links, its webhook deliveries (send again) and a cancel action. Invoices have deep links (`#/invoices/<id>`).
- **Assets:** one card per network listing the coins and tokens it covers. Connect, replace or remove the account public key (or the Solana address) and see the scanner's live state: last block, last scan, errors. Inputs that look like seed phrases or private keys are refused.
- **Create wallet:** a wizard on the Assets page creates a new wallet for every network that has none (see below).
- **Invoice drawer:** while an invoice confirms, a card shows `X of Y confirmations`; the details list the wallet path of the invoice address (for example `m/84'/0'/0'/0/7`). A timeline shows every status the invoice passed through, with the amount received at that point.
- **Activity:** the workspace audit log: sign-ins and failed sign-ins, API keys, wallet changes, webhook changes and test events, payment links created and invoices cancelled, with who did it (user or API key prefix) and from which IP. The page verifies the log's hash chain on every visit (see [Audit log](#audit-log)).

## Creating a wallet

**Create wallet** on the Assets page makes a new non-custodial wallet in the browser:

1. Pick the networks (all unconnected ones are preselected) and 12 or 24 words.
2. The browser generates a BIP39 recovery phrase. It stays blurred until **Show words** is clicked and must be written down.
3. The merchant types three random words from the written copy to prove the backup.
4. The browser derives the public keys and sends only those: zpub for Bitcoin and Litecoin, xpub for EVM chains and TRON, the address for Solana. The phrase is then wiped from memory and is never sent to or stored by the server.

| Network | Path | Opens in |
| --- | --- | --- |
| Bitcoin | `m/84'/0'/0'/0/i` | Sparrow, Electrum (BIP39, native SegWit), BlueWallet |
| Litecoin | `m/84'/2'/0'/0/i` | Electrum-LTC |
| EVM chains | `m/44'/60'/0'/0/i` | MetaMask, Rabby (invoice `i` is account `i + 1`) |
| TRON | `m/44'/195'/0'/0/i` | TronLink (invoice `i` is account `i + 1`) |
| Solana | `m/44'/501'/0'/0'` | Phantom, Solflare (first account) |

On EVM chains and TRON every invoice has its own address, so moving USDT or USDC out needs a little native coin (ETH, POL, BNB, TRX) on that address for the fee. Bitcoin wallets stop looking after 20 unused addresses in a row; raise the gap limit (for example in Sparrow) if many invoices expired unpaid.
- **Webhooks:** recent deliveries with HTTP status, attempts and next retry; retry failed events and send test events.
- **API keys:** create keys (shown once) and revoke them.
- **Team:** members with their role and last sign-in, invitation links, role changes and disabling members (see [Team and roles](#team-and-roles)).
- **Settings:** workspace name (owners), webhook endpoint and signing-secret rotation, password change, your active sessions (device, IP, last activity) with sign-out per session or for all others, and a security overview.

## Audit log

Every change made in the dashboard or with an API key is written to `audit_log` in the same transaction as the change. The table is append-only: a trigger rejects `UPDATE` and `DELETE`. Each entry also stores the SHA-256 of its content and of the merchant's previous entry, so an entry that is edited or removed by someone who bypasses the trigger (for example with direct superuser access) breaks the chain. The Activity page shows the first broken entry; operators can check every merchant from the command line:

```sh
npm run audit:verify --workspace apps/api            # all merchants, exits 1 if a chain is broken
npm run audit:verify --workspace apps/api -- <merchant-uuid>
```

Invoices created through the API are not audited one by one (their status history is kept in `invoice_status_history`); payment links created by a dashboard user are.

## Team and roles

Everyone in a workspace can see every page. Roles decide who may change what, and the API checks them on every request, so a role change or a disabled member takes effect immediately, also in sessions that are already open.

| Role | May change |
| --- | --- |
| Owner | Everything, including owners and the workspace name |
| Admin | Wallets, team members below owner, API keys, webhooks, payment links |
| Developer | API keys, webhooks, payment links and cancelling invoices |
| Viewer | Nothing (read-only) |

Owners and admins invite members on the Team page. The invitation link is valid for seven days, is shown once to the inviter, and only its SHA-256 hash is stored; a new invitation for the same email replaces the pending one. The invitee opens the link, sets a name and a password of at least 12 characters and is signed in. Members cannot change their own role or disable themselves, only owners can make or change owners, and the last active owner cannot be removed. Disabling a member signs them out everywhere. Changing your password signs out your other sessions. Every one of these actions is written to the audit log.

## Create the first dashboard user

After creating a merchant and applying migrations, set `DASHBOARD_USER_PASSWORD` in the ignored `.env`, then run:

```sh
npm run dashboard:user:create --workspace apps/api -- <merchant-uuid> owner@example.com
```

The user is an owner. Pass a role as third argument (`admin`, `developer` or `viewer`) to create someone else; usually it is easier to invite further members from the Team page.

## Run locally

```sh
npm run dev --workspace apps/dashboard
```

Vite serves the dashboard on port 5174 and proxies `/v1` to `http://localhost:3000` (override with `ORBITT_API_PROXY`). `npm run demo:seed --workspace apps/api` creates a demo merchant and login.

## Security

Sessions are random tokens stored as SHA-256 hashes. They expire after eight hours and travel in HTTP-only, `SameSite=Strict` cookies (`Secure` in production). Every state-changing request needs a matching CSRF cookie and header. Login is rate-limited per IP and uses Argon2id with a dummy hash for unknown accounts. API keys and webhook secrets are shown only once. Two-factor authentication is not implemented yet.
