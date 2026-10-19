# Hosted checkout

The customer checkout is the Vite/React app in `apps/checkout`, served at `/checkout/{invoice-id}`. The random invoice UUID is the only capability; the public API exposes merchant name, order ID, amounts, address and status, never metadata or webhook settings.

## Flow

1. **Choose a coin.** Invoices created without a coin list every available asset, grouped by coin with a network picker (for example USDT on Ethereum, TRON or Solana). Choosing one calls `POST /v1/public/invoices/{id}/payment`, which locks the quote and assigns the address.
2. **Pay.** The page shows the exact amount, a QR code, an **Open in wallet** button on phones, copy buttons for amount and address, a countdown and a warning to use only the selected network. Solana invoices also explain that the exact amount identifies the payment.
3. **Track.** The page polls every 4 seconds (every 20 seconds while no coin is chosen) and refreshes when the tab becomes visible again. A timeline shows waiting, detected, confirming and paid. Underpaid invoices show the remaining amount to send to the same address.
   - **Nothing received yet:** below the QR code a pulsing box says the network is being watched and the page updates by itself.
   - **Received, confirming:** the QR code is replaced by a progress card with `X of Y confirmations`, a progress bar and an estimated time left (`confirmation_eta_seconds`, from the network's block time). Each transfer is listed with its amount, its own confirmation count and an explorer link. The customer can close the page; the merchant is notified automatically.
4. **Done.** A receipt confirms the payment, links the transaction in the block explorer and returns to `success_url` after a few seconds. Expired, late and cancelled invoices get their own explanation.

## Payment links

| Network | QR / deep link |
| --- | --- |
| Bitcoin, Litecoin | BIP21 `bitcoin:` / `litecoin:` with amount |
| EVM native coins | EIP-681 `ethereum:<address>@<chainId>?value=<wei>` |
| EVM and TRON tokens | Plain address. Token deep links are handled inconsistently by wallets, so amount and network are shown separately |
| Solana | Solana Pay `solana:<address>?amount=…` with `spl-token` for USDC/USDT |

## Languages and accessibility

Copy is in English and German, picked from the browser language. The page supports keyboard navigation and reduced motion, and announces status changes through a live region.

## Run locally

```sh
npm run dev --workspace apps/checkout
```

Vite proxies `/v1` to `http://localhost:3000` (override with `ORBITT_API_PROXY`). In production serve `apps/checkout/dist` on the same origin as the API, as the bundled Nginx config does, and set `CHECKOUT_BASE_URL` to that origin so invoices carry the right `checkout_url`.
