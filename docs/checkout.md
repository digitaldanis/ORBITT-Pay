# Hosted checkout

The customer checkout is the Vite/React app in `apps/checkout`. It loads the invoice through the public `GET /v1/public/invoices/{id}` route and polls every five seconds. The public response includes only the fields needed for payment: merchant/order labels, exact amount in crypto base units and decimal form, asset/network, receive address, status, expiry, and configured return URLs. It never exposes merchant metadata or webhook configuration.

The page builds BIP21 payment links for BTC, Litecoin URIs for LTC, and EIP-681 links for native ETH on the configured EVM networks. The QR encodes that payment URI; the exact address and amount remain available as separate copy actions. Customer cancellation uses `POST /v1/public/invoices/{id}/cancel`; invoice IDs are random UUIDs and serve as the checkout capability.

Run the frontend locally with:

```sh
npm run dev --workspace apps/checkout
```

Vite proxies `/v1` to `http://localhost:3000`. For production, serve the built `apps/checkout/dist` at the same origin as the API or set `VITE_API_BASE_URL` and configure the reverse proxy accordingly. Set `CHECKOUT_BASE_URL` to the public checkout origin so invoice responses contain the correct URL.

Status changes refresh by polling. A countdown uses the server-issued `created_at` and `expires_at`; the server's invoice status remains authoritative. The page respects reduced-motion preferences, supports keyboard navigation, announces changes through a live region, and warns customers to use only the selected network.
