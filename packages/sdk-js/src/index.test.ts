import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { constructWebhookEvent, OrbittApiError, OrbittClient, verifyWebhookSignature } from './index.js';

describe('ORBITT JavaScript SDK', () => {
  it('sends authenticated invoice requests with an idempotency key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'inv-1' }), { status: 201 }));
    const client = new OrbittClient({ apiKey: 'ob_live_example', baseUrl: 'https://api.example.test/', fetch: fetchMock });

    await client.createInvoice({ amount: '12.50', currency: 'EUR' }, 'shop-order-1');

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/v1/invoices', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer ob_live_example',
        'Idempotency-Key': 'shop-order-1',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ amount: '12.50', currency: 'EUR' }),
    }));
  });

  it('surfaces structured API errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'bad_amount', message: 'Amount is invalid.', param: 'amount' } }), { status: 422 }));
    const client = new OrbittClient({ apiKey: 'ob_live_example', baseUrl: 'https://api.example.test', fetch: fetchMock });

    await expect(client.getInvoice('inv-1')).rejects.toMatchObject<Partial<OrbittApiError>>({
      name: 'OrbittApiError', status: 422, code: 'bad_amount', param: 'amount', message: 'Amount is invalid.',
    });
  });

  it('verifies signed raw webhook bodies and rejects stale or changed bodies', async () => {
    const secret = 'whsec_example_secret';
    const timestamp = 1_700_000_000;
    const body = '{"event":"invoice.paid","invoice":null}';
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const header = `t=${timestamp},v1=${digest}`;

    await expect(verifyWebhookSignature(secret, body, header, { now: timestamp + 60 })).resolves.toBe(true);
    await expect(verifyWebhookSignature(secret, `${body} `, header, { now: timestamp + 60 })).resolves.toBe(false);
    await expect(verifyWebhookSignature(secret, body, header, { now: timestamp + 301 })).resolves.toBe(false);
  });

  it('parses events only after the signature checks out', async () => {
    const secret = 'whsec_example_secret';
    const timestamp = 1_700_000_000;
    const body = '{"event":"invoice.paid","created_at":"2026-10-19T12:00:00.000Z","invoice":null}';
    const header = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

    await expect(constructWebhookEvent(secret, body, header, { now: timestamp })).resolves.toMatchObject({ event: 'invoice.paid' });
    await expect(constructWebhookEvent('other_secret', body, header, { now: timestamp })).rejects.toThrow(/Invalid ORBITT-Signature/);
  });

  it('passes search and limit as query parameters', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [], next_cursor: null })));
    const client = new OrbittClient({ apiKey: 'ob_live_example', baseUrl: 'https://api.example.test', fetch: fetchMock });
    await client.listInvoices({ search: 'ORD-1', limit: 50 });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.test/v1/invoices?search=ORD-1&limit=50');
  });
});
