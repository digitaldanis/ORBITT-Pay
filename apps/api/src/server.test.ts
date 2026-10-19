import { describe, expect, it } from 'vitest';
import { ApiError, buildServer, type ApiServices, type InvoiceRecord, type MerchantContext } from './server.js';
import { hashApiKey } from './auth/api-key.js';

const secret = `ob_live_${'x'.repeat(43)}`;
const merchant: MerchantContext = { id: '4ab9080f-5905-4dcb-a1d2-0d69edfbcf1e', name: 'Example Shop' };
const invoice: InvoiceRecord = {
  id: '0b9678da-f39f-4b3f-a74e-624eaa36d8bd', order_id: null, amount: '25.00', currency: 'EUR',
  crypto_amount: '0.00025', asset: 'BTC', network: 'bitcoin', address: 'bc1qexample', status: 'awaiting_payment',
  checkout_url: 'https://pay.example.test/i/0b9678da-f39f-4b3f-a74e-624eaa36d8bd',
  received_amount: '0', surplus_amount: '0', exchange_rate: '100000',
  expires_at: '2026-10-19T11:00:00.000Z', created_at: '2026-10-19T10:45:00.000Z', updated_at: '2026-10-19T10:45:00.000Z', metadata: {},
};

function mockServices(): ApiServices {
  return {
    authenticateKey: async (hash) => hash === hashApiKey(secret) ? merchant : null,
    createInvoice: async () => invoice,
    getInvoice: async () => invoice,
    getInvoiceDetail: async () => ({ invoice, payments: [], webhooks: [] }),
    getPublicInvoice: async () => null,
    selectPublicPayment: async () => null,
    cancelPublicInvoice: async () => null,
    listInvoices: async () => ({ data: [invoice], next_cursor: null }),
    cancelInvoice: async () => invoice,
    getAssets: async () => [{ asset: 'BTC', network: 'bitcoin', name: 'Bitcoin', network_name: 'Bitcoin', decimals: 8, contract: null, wallet_asset: 'BTC', family: 'utxo', address_mode: 'derived', enabled: true, available: true }],
    getNetworkStatus: async () => [],
    deleteWallet: async () => true,
    redeliverWebhook: async () => true,
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

  it('parses list query parameters sent as text', async () => {
    let received: unknown;
    const services = mockServices();
    services.listInvoices = async (_merchant, query) => { received = query; return { data: [invoice], next_cursor: null }; };
    const app = await buildServer(services, { logger: false });
    const headers = { authorization: `Bearer ${secret}` };
    const listed = await app.inject({ method: 'GET', url: '/v1/invoices?limit=50&status=paid&search=ORD', headers });
    expect(listed.statusCode).toBe(200);
    expect(received).toEqual({ limit: 50, status: 'paid', search: 'ORD' });
    expect((await app.inject({ method: 'GET', url: '/v1/invoices?limit=101', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/invoices?limit=0', headers })).statusCode).toBe(400);
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
      asset: 'BTC', asset_name: 'Bitcoin', asset_decimals: 8, network: 'bitcoin', network_name: 'Bitcoin', token_contract: null, address: 'bc1qexample', address_mode: 'derived',
      received_amount: '0', remaining_amount: '0.00025', status: 'awaiting_payment',
      created_at: invoice.created_at, expires_at: invoice.expires_at, success_url: null, cancel_url: null, payment_options: [],
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

  it('lets checkout choose a payment method without an API key and validates the body', async () => {
    const services = mockServices();
    let chosen: string[] = [];
    services.selectPublicPayment = async (id, asset, network) => {
      chosen = [id, asset, network];
      return null;
    };
    const app = await buildServer(services, { logger: false });
    const missing = await app.inject({ method: 'POST', url: `/v1/public/invoices/${invoice.id}/payment`, payload: { asset: 'USDT', network: 'tron' } });
    expect(missing.statusCode).toBe(404);
    expect(chosen).toEqual([invoice.id, 'USDT', 'tron']);
    const invalid = await app.inject({ method: 'POST', url: `/v1/public/invoices/${invoice.id}/payment`, payload: { asset: 'USDT' } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('maps service errors to the standard error envelope', async () => {
    const services = mockServices();
    services.cancelInvoice = async () => { throw new ApiError(409, 'invoice_not_cancellable', 'Only unpaid invoices can be cancelled.'); };
    const app = await buildServer(services, { logger: false });
    const response = await app.inject({ method: 'POST', url: `/v1/invoices/${invoice.id}/cancel`, headers: { authorization: `Bearer ${secret}` } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'invoice_not_cancellable', message: 'Only unpaid invoices can be cancelled.' } });
    await app.close();
  });

  it('validates dashboard wallet bodies instead of passing arbitrary JSON through', async () => {
    const services = mockServices();
    const sessionToken = 'session_token_abcdefghijklmnopqrstuvwxyz';
    const csrfToken = 'csrf_token_abcdefghijklmnopqrstuvwxyz';
    services.authenticateDashboardSession = async () => ({ merchant, email: 'owner@example.test', csrfHash: hashApiKey(csrfToken) });
    const app = await buildServer(services, { logger: false });
    const headers = { cookie: `ob_session=${sessionToken}; ob_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
    const invalid = await app.inject({ method: 'PUT', url: '/v1/dashboard/account/wallets', headers, payload: { wallets: 'nope' } });
    expect(invalid.statusCode).toBe(400);
    const valid = await app.inject({ method: 'PUT', url: '/v1/dashboard/account/wallets', headers, payload: { wallets: [{ asset: 'BTC', network: 'bitcoin', extended_public_key: 'zpub' }] } });
    expect(valid.statusCode).toBe(200);
    await app.close();
  });
});
