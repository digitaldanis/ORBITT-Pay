import { describe, expect, it } from 'vitest';
import { buildServer, type ApiServices, type InvoiceRecord, type MerchantContext } from './server.js';
import { hashApiKey } from './auth/api-key.js';

const secret = `ob_live_${'x'.repeat(43)}`;
const merchant: MerchantContext = { id: '4ab9080f-5905-4dcb-a1d2-0d69edfbcf1e', name: 'Example Shop' };
const invoice: InvoiceRecord = {
  id: '0b9678da-f39f-4b3f-a74e-624eaa36d8bd', order_id: null, amount: '25.00', currency: 'EUR',
  crypto_amount: '0.00025', asset: 'BTC', network: 'bitcoin', address: 'bc1qexample', status: 'awaiting_payment',
  checkout_url: 'https://pay.example.test/i/0b9678da-f39f-4b3f-a74e-624eaa36d8bd',
  expires_at: '2026-10-19T11:00:00.000Z', created_at: '2026-10-19T10:45:00.000Z', metadata: {},
};

function mockServices(): ApiServices {
  return {
    authenticateKey: async (hash) => hash === hashApiKey(secret) ? merchant : null,
    createInvoice: async () => invoice,
    getInvoice: async () => invoice,
    getPublicInvoice: async () => null,
    cancelPublicInvoice: async () => null,
    listInvoices: async () => ({ data: [invoice], next_cursor: null }),
    cancelInvoice: async () => invoice,
    getAssets: async () => [{ asset: 'BTC', network: 'bitcoin', enabled: true }],
    getAccount: async () => ({ merchant: merchant.name }),
    updateWallets: async () => ({ updated: true }),
    setWebhook: async (_merchant, url) => ({ webhook_url: url }),
    sendTestWebhook: async () => ({ accepted: true }),
    loginDashboard: async () => null,
    authenticateDashboardSession: async () => null,
    revokeDashboardSession: async () => undefined,
    getDashboardOverview: async () => ({}),
    listDashboardWebhooks: async () => [],
    listDashboardApiKeys: async () => [],
    createDashboardApiKey: async (_merchant, name) => ({ id: '0b9678da-f39f-4b3f-a74e-624eaa36d8bd', name, key_prefix: 'ob_live_test', secret }),
    revokeDashboardApiKey: async () => true,
  };
}

describe('merchant API', () => {
  it('requires a valid bearer key on merchant routes', async () => {
    const app = await buildServer(mockServices(), { logger: false });
    const response = await app.inject({ method: 'GET', url: '/v1/invoices' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: 'unauthorized', message: 'A valid bearer API key is required.' } });
    await app.close();
  });

  it('creates invoice through the service with idempotency key and rejects unknown fields', async () => {
    let receivedKey: string | undefined;
    const services = mockServices();
    services.createInvoice = async (_merchant, key) => { receivedKey = key; return invoice; };
    const app = await buildServer(services, { logger: false });
    const headers = { authorization: `Bearer ${secret}`, 'idempotency-key': 'cart-123' };
    const created = await app.inject({ method: 'POST', url: '/v1/invoices', headers, payload: { amount: '25.00', currency: 'EUR' } });
    expect(created.statusCode).toBe(201);
    expect(receivedKey).toBe('cart-123');
    const invalid = await app.inject({ method: 'POST', url: '/v1/invoices', headers, payload: { amount: '25.00', currency: 'EUR', unexpected: true } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('publishes the OpenAPI 3.1 document without authentication', async () => {
    const app = await buildServer(mockServices(), { logger: false });
    const response = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().openapi).toBe('3.1.0');
    expect(response.json().paths['/invoices']).toBeDefined();
    await app.close();
  });

  it('serves a minimal public invoice view to the hosted checkout without an API key', async () => {
    const services = mockServices();
    services.getPublicInvoice = async (id) => ({
      id, merchant_name: merchant.name, order_id: null, request_amount: '25.00', request_currency: 'EUR', crypto_amount: '0.00025', crypto_amount_base_units: '25000',
      asset: 'BTC', network: 'bitcoin', address: 'bc1qexample', status: 'awaiting_payment',
      created_at: invoice.created_at, expires_at: invoice.expires_at, success_url: null, cancel_url: null,
    });
    const app = await buildServer(services, { logger: false });
    const response = await app.inject({ method: 'GET', url: `/v1/public/invoices/${invoice.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().merchant_name).toBe(merchant.name);
    expect(response.json().metadata).toBeUndefined();
    await app.close();
  });

  it('uses an HTTP-only session cookie and requires a CSRF token on dashboard mutations', async () => {
    const services = mockServices();
    const sessionToken = 'session_token_abcdefghijklmnopqrstuvwxyz';
    const csrfToken = 'csrf_token_abcdefghijklmnopqrstuvwxyz';
    services.loginDashboard = async () => ({ sessionToken, csrfToken, merchant, email: 'owner@example.test' });
    services.authenticateDashboardSession = async (token) => token === sessionToken
      ? { merchant, email: 'owner@example.test', csrfHash: hashApiKey(csrfToken) }
      : null;
    const app = await buildServer(services, { logger: false });
    const login = await app.inject({ method: 'POST', url: '/v1/dashboard/login', payload: { email: 'owner@example.test', password: 'a long password' } });
    expect(login.statusCode).toBe(200);
    const setCookies = login.headers['set-cookie'];
    expect(setCookies).toBeDefined();
    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies!];
    const sessionCookie = cookies.find((value) => value.startsWith('ob_session='))!.split(';')[0]!;
    const csrfCookie = cookies.find((value) => value.startsWith('ob_csrf='))!.split(';')[0]!;
    expect(cookies.find((value) => value.startsWith('ob_session='))).toContain('HttpOnly');
    expect(cookies.find((value) => value.startsWith('ob_csrf='))).toContain('Path=/;');

    const session = await app.inject({ method: 'GET', url: '/v1/dashboard/session', headers: { cookie: `${sessionCookie}; ${csrfCookie}` } });
    expect(session.statusCode).toBe(200);
    const blocked = await app.inject({ method: 'POST', url: '/v1/dashboard/logout', headers: { cookie: `${sessionCookie}; ${csrfCookie}` } });
    expect(blocked.statusCode).toBe(403);
    const logout = await app.inject({ method: 'POST', url: '/v1/dashboard/logout', headers: { cookie: `${sessionCookie}; ${csrfCookie}`, 'x-csrf-token': csrfToken } });
    expect(logout.statusCode).toBe(200);
    await app.close();
  });
});
