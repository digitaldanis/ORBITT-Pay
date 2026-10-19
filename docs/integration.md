# Merchant integration

This guide uses the official `@orbitt/sdk` package from a Node.js shop server. Keep the ORBITT API key on the server; send customers the returned hosted checkout URL. Configure your webhook URL and save its one-time signing secret in your shop's secret manager before creating invoices.

## Node.js / Express

After publishing `@orbitt/sdk` to your package registry, install it with:

```sh
npm install @orbitt/sdk
```

To try the SDK from a local checkout before publishing, build and pack it from the repository:

```sh
npm run build --workspace packages/sdk-js
cd packages/sdk-js && npm pack
npm install /path/to/orbitt-sdk-0.1.0.tgz
```

Create an invoice from a server-side order handler. The decimal amount is a string, and the idempotency key should be stable for that order so retrying the request does not create a second invoice.

```ts
import express from 'express';
import { constructWebhookEvent, OrbittClient } from '@orbitt/sdk';

const app = express();
const orbitt = new OrbittClient({
  apiKey: process.env.ORBITT_API_KEY!,
  baseUrl: process.env.ORBITT_API_URL!, // e.g. https://api.example.com
});

app.post('/checkout/:orderId', async (req, res, next) => {
  try {
    const order = await loadOrder(req.params.orderId);
    const invoice = await orbitt.createInvoice({
      amount: order.total.toFixed(2),
      currency: order.currency,
      order_id: order.id,
      success_url: `https://shop.example/orders/${order.id}/complete`,
      metadata: { order_id: order.id },
      // Leave out asset/network to let the customer pick any coin you accept.
    }, `order-${order.id}`);

    res.redirect(303, invoice.checkout_url);
  } catch (error) {
    next(error);
  }
});

// Register this route before express.json(): signature verification needs the exact bytes.
app.post('/webhooks/orbitt', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    // Throws unless the ORBITT-Signature header matches the exact raw bytes and is recent.
    event = await constructWebhookEvent(process.env.ORBITT_WEBHOOK_SECRET!, req.body as Buffer, req.header('ORBITT-Signature') ?? '');
  } catch {
    return res.sendStatus(400);
  }

  const deliveryId = req.header('ORBITT-Delivery');
  await processOrbittEventOnce(deliveryId, event);
  return res.sendStatus(204);
});

app.use(express.json());
```

`processOrbittEventOnce` should deduplicate by `ORBITT-Delivery`: webhooks are delivered at least once. Validate the event and invoice ID before changing order state. Mark an order paid only after a valid `invoice.paid` event.

## Plain HTML checkout button

Do not put a secret API key in browser code. Create the invoice on your own server and render only its hosted checkout URL into the page:

```html
<a href="https://pay.example/checkout/INVOICE_ID" rel="noopener">
  Continue to secure crypto checkout
</a>
```

Use the exact `checkout_url` returned by the server instead of constructing an invoice URL. For invoice state, poll `GET /v1/invoices/{id}` from your server or process signed webhook events.

## API without the SDK

```sh
curl https://api.example/v1/invoices \
  -H 'Authorization: Bearer ob_live_REDACTED' \
  -H 'Idempotency-Key: order-1042' \
  -H 'Content-Type: application/json' \
  -d '{"amount":"49.95","currency":"EUR","order_id":"1042"}'
```

See [API reference](./api.md) and [webhook operations](./webhooks.md) for request fields, events, delivery behavior, and secret rotation.
