import Fastify, { LogController } from 'fastify';
import type { FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { hashApiKey, readBearerToken } from './auth/api-key.js';
import { ApiError } from './errors.js';
export { ApiError } from './errors.js';

export const invoiceStatuses = [
  'created', 'awaiting_payment', 'detected', 'confirming', 'paid',
  'underpaid', 'overpaid', 'expired', 'late_payment', 'cancelled',
] as const;

export interface MerchantContext {
  id: string;
  name: string;
}

export interface InvoiceRecord {
  id: string;
  order_id: string | null;
  amount: string;
  currency: string;
  crypto_amount: string;
  asset: string;
  network: string;
  address: string | null;
  status: typeof invoiceStatuses[number];
  checkout_url: string;
  expires_at: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface PublicInvoiceRecord {
  id: string;
  merchant_name: string;
  order_id: string | null;
  request_amount: string;
  request_currency: string;
  crypto_amount: string;
  crypto_amount_base_units: string;
  asset: string;
  network: string;
  address: string | null;
  status: typeof invoiceStatuses[number];
  created_at: string;
  expires_at: string;
  success_url: string | null;
  cancel_url: string | null;
}

export interface DashboardLogin {
  sessionToken: string;
  csrfToken: string;
  merchant: MerchantContext;
  email: string;
}

export interface DashboardSession {
  merchant: MerchantContext;
  email: string;
  csrfHash: string;
}

export interface CreateInvoiceInput {
  amount: string;
  currency: string;
  asset?: string;
  network?: string;
  order_id?: string;
  success_url?: string;
  cancel_url?: string;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
}

export interface InvoiceListQuery {
  status?: typeof invoiceStatuses[number];
  limit: number;
  cursor?: string;
}

/** Persistence and payment-domain boundary implemented by the API composition root. */
export interface ApiServices {
  authenticateKey(keyHash: string): Promise<MerchantContext | null>;
  createInvoice(merchant: MerchantContext, idempotencyKey: string, input: CreateInvoiceInput): Promise<InvoiceRecord>;
  getInvoice(merchant: MerchantContext, id: string): Promise<InvoiceRecord | null>;
  getPublicInvoice(id: string): Promise<PublicInvoiceRecord | null>;
  cancelPublicInvoice(id: string): Promise<PublicInvoiceRecord | null>;
  listInvoices(merchant: MerchantContext, query: InvoiceListQuery): Promise<{ data: InvoiceRecord[]; next_cursor: string | null }>;
  cancelInvoice(merchant: MerchantContext, id: string): Promise<InvoiceRecord | null>;
  getAssets(merchant: MerchantContext): Promise<Array<{ asset: string; network: string; enabled: boolean }>>;
  getAccount(merchant: MerchantContext): Promise<Record<string, unknown>>;
  updateWallets(merchant: MerchantContext, wallets: Array<{ asset: string; network: string; extended_public_key?: string; address?: string }>): Promise<Record<string, unknown>>;
  setWebhook(merchant: MerchantContext, url: string | null, rotateSecret: boolean): Promise<{ webhook_url: string | null; signing_secret?: string }>;
  sendTestWebhook(merchant: MerchantContext): Promise<{ accepted: boolean }>;
  loginDashboard(email: string, password: string): Promise<DashboardLogin | null>;
  authenticateDashboardSession(sessionToken: string): Promise<DashboardSession | null>;
  revokeDashboardSession(sessionToken: string): Promise<void>;
  getDashboardOverview(merchant: MerchantContext): Promise<Record<string, unknown>>;
  listDashboardWebhooks(merchant: MerchantContext): Promise<Array<Record<string, unknown>>>;
  listDashboardApiKeys(merchant: MerchantContext): Promise<Array<Record<string, unknown>>>;
  createDashboardApiKey(merchant: MerchantContext, name: string): Promise<{ id: string; name: string; key_prefix: string; secret: string }>;
  revokeDashboardApiKey(merchant: MerchantContext, id: string): Promise<boolean>;
}

declare module 'fastify' {
  interface FastifyRequest {
    merchant: MerchantContext | null;
    dashboardSession: DashboardSession | null;
  }
}

const errorSchema = {
  type: 'object', additionalProperties: false, required: ['error'],
  properties: {
    error: {
      type: 'object', additionalProperties: false, required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' }, param: { type: 'string' } },
    },
  },
} as const;

const invoiceSchema = {
  type: 'object', additionalProperties: true,
  required: ['id', 'amount', 'currency', 'crypto_amount', 'asset', 'network', 'status', 'checkout_url', 'expires_at', 'created_at', 'metadata'],
  properties: {
    id: { type: 'string', format: 'uuid' }, order_id: { type: ['string', 'null'] },
    amount: { type: 'string' }, currency: { type: 'string' }, crypto_amount: { type: 'string' },
    asset: { type: 'string' }, network: { type: 'string' }, address: { type: ['string', 'null'] },
    status: { type: 'string', enum: invoiceStatuses }, checkout_url: { type: 'string', format: 'uri' },
    expires_at: { type: 'string', format: 'date-time' }, created_at: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const idParams = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const createBody = {
  type: 'object', additionalProperties: false, required: ['amount', 'currency'],
  properties: {
    amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,18})?$' },
    currency: { type: 'string', minLength: 2, maxLength: 12 },
    asset: { type: 'string', minLength: 2, maxLength: 32 }, network: { type: 'string', minLength: 2, maxLength: 48 },
    order_id: { type: 'string', maxLength: 255 }, success_url: { type: 'string', format: 'uri', pattern: '^https?://', maxLength: 2048 },
    cancel_url: { type: 'string', format: 'uri', pattern: '^https?://', maxLength: 2048 }, webhook_url: { type: 'string', format: 'uri', pattern: '^https?://', maxLength: 2048 },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const invoiceResponse = { 200: invoiceSchema, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 429: errorSchema, 500: errorSchema } as const;

type ErrorReply = {
  code(statusCode: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500): {
    send(payload: { error: { code: string; message: string; param?: string } }): unknown;
  };
};

function fail(reply: ErrorReply, status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500, code: string, message: string, param?: string) {
  return reply.code(status).send({ error: { code, message, ...(param ? { param } : {}) } });
}

export async function buildServer(services: ApiServices, options: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger === false ? false : { redact: ['req.headers.authorization', 'req.headers.cookie'] },
    logController: new LogController({ disableRequestLogging: false, requestIdLogLabel: 'request_id' }),
    trustProxy: process.env.TRUST_PROXY === 'true',
    requestIdHeader: 'x-request-id',
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true } },
  });
  app.decorateRequest('merchant', null);
  app.decorateRequest('dashboardSession', null);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'ORBITT PAY API', version: '1.0.0', description: 'Merchant API for non-custodial crypto payment invoices.' },
      servers: [{ url: '/v1' }],
      components: { securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        dashboardSession: { type: 'apiKey', in: 'cookie', name: 'ob_session' },
      } },
      security: [{ bearerAuth: [] }],
    },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const token = readBearerToken(request.headers.authorization);
      return token ? `key:${hashApiKey(token)}` : `ip:${request.ip}`;
    },
    errorResponseBuilder: (_request, context) => ({ error: { code: 'rate_limit_exceeded', message: `Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)} seconds.` } }),
  });
  await app.register(cookie);
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return fail(reply, error.statusCode, error.code, error.message, error.param);
    const validation = (error as Error & { validation?: Array<{ instancePath?: string }> }).validation;
    if (validation) return fail(reply, 400, 'invalid_request', 'The request is invalid.', validation[0]?.instancePath || undefined);
    request.log.error({ err: error }, 'Unhandled API error');
    return fail(reply, 500, 'internal_error', 'An unexpected error occurred.');
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/v1/dashboard/')) return;
    if ((request.method === 'GET' && (request.url === '/health' || request.url.startsWith('/docs') || request.url === '/v1/openapi.json'))
      || request.url.startsWith('/v1/public/invoices/')) return;
    const token = readBearerToken(request.headers.authorization);
    if (!token) return fail(reply, 401, 'unauthorized', 'A valid bearer API key is required.');
    try {
      const merchant = await services.authenticateKey(hashApiKey(token));
      if (!merchant) return fail(reply, 401, 'unauthorized', 'A valid bearer API key is required.');
      request.merchant = merchant;
    } catch (error) {
      request.log.error({ err: error }, 'API key authentication failed');
      return fail(reply, 500, 'internal_error', 'An unexpected error occurred.');
    }
  });

  app.get('/health', { schema: { tags: ['system'], response: { 200: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } } } }, async () => ({ status: 'ok' }));

  const publicInvoiceSchema = {
    type: 'object', additionalProperties: false,
    required: ['id', 'merchant_name', 'request_amount', 'request_currency', 'crypto_amount', 'crypto_amount_base_units', 'asset', 'network', 'status', 'created_at', 'expires_at'],
    properties: {
      id: { type: 'string', format: 'uuid' }, merchant_name: { type: 'string' }, order_id: { type: ['string', 'null'] },
      request_amount: { type: 'string' }, request_currency: { type: 'string' },
      crypto_amount: { type: 'string' }, crypto_amount_base_units: { type: 'string' }, asset: { type: 'string' },
      network: { type: 'string' }, address: { type: ['string', 'null'] }, status: { type: 'string', enum: invoiceStatuses },
      created_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, success_url: { type: ['string', 'null'] }, cancel_url: { type: ['string', 'null'] },
    },
  } as const;

  type ApiRawServer = ReturnType<typeof Fastify>['server'];
  type ApiRequest = FastifyRequest<RouteGenericInterface, ApiRawServer>;
  type ApiReply = FastifyReply<RouteGenericInterface, ApiRawServer>;
  const requireDashboard = async (request: ApiRequest, reply: ApiReply) => {
    const token = request.cookies.ob_session;
    if (!token) return fail(reply, 401, 'dashboard_unauthorized', 'Sign in to continue.');
    try {
      const session = await services.authenticateDashboardSession(token);
      if (!session) return fail(reply, 401, 'dashboard_unauthorized', 'Your dashboard session has expired. Sign in again.');
      request.dashboardSession = session;
    } catch (error) {
      request.log.error({ err: error }, 'Dashboard session lookup failed');
      return fail(reply, 500, 'internal_error', 'An unexpected error occurred.');
    }
  };
  const requireDashboardCsrf = async (request: ApiRequest, reply: ApiReply) => {
    const cookieToken = request.cookies.ob_csrf;
    const headerToken = request.headers['x-csrf-token'];
    if (!cookieToken || typeof headerToken !== 'string' || cookieToken !== headerToken || !request.dashboardSession) {
      return fail(reply, 403, 'csrf_validation_failed', 'Refresh the dashboard session and try again.');
    }
    const actual = Buffer.from(hashApiKey(headerToken), 'hex');
    const expected = Buffer.from(request.dashboardSession.csrfHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return fail(reply, 403, 'csrf_validation_failed', 'Refresh the dashboard session and try again.');
    }
  };

  app.post<{ Body: { email: string; password: string } }>('/v1/dashboard/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['dashboard'], summary: 'Sign in to the merchant dashboard', security: [],
      body: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: { email: { type: 'string', format: 'email', maxLength: 320 }, password: { type: 'string', minLength: 1, maxLength: 1024 } } },
      response: { 200: { type: 'object', required: ['merchant', 'email'], properties: { merchant: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } }, email: { type: 'string' } } }, 400: errorSchema, 401: errorSchema, 429: errorSchema },
    },
  }, async (request, reply) => {
    const result = await services.loginDashboard(request.body.email, request.body.password);
    if (!result) return fail(reply, 401, 'invalid_credentials', 'Email or password is incorrect.');
    const secure = process.env.NODE_ENV === 'production';
    const cookieOptions = { path: '/v1/dashboard', sameSite: 'strict' as const, secure, maxAge: 8 * 60 * 60 };
    reply.setCookie('ob_session', result.sessionToken, { ...cookieOptions, httpOnly: true });
    reply.setCookie('ob_csrf', result.csrfToken, { ...cookieOptions, path: '/', httpOnly: false });
    return reply.send({ merchant: result.merchant, email: result.email });
  });
  app.get('/v1/dashboard/session', { preHandler: requireDashboard, schema: { tags: ['dashboard'], summary: 'Get the signed-in dashboard session', security: [{ dashboardSession: [] }], response: { 200: { type: 'object', properties: { merchant: { type: 'object' }, email: { type: 'string' } }, required: ['merchant', 'email'] }, 401: errorSchema } } }, async (request) => ({ merchant: request.dashboardSession!.merchant, email: request.dashboardSession!.email }));
  app.post('/v1/dashboard/logout', { preHandler: [requireDashboard, requireDashboardCsrf], schema: { tags: ['dashboard'], summary: 'Sign out of the dashboard', security: [{ dashboardSession: [] }], response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, 401: errorSchema, 403: errorSchema } } }, async (request, reply) => {
    await services.revokeDashboardSession(request.cookies.ob_session!);
    const secure = process.env.NODE_ENV === 'production';
    reply.clearCookie('ob_session', { path: '/v1/dashboard', secure, sameSite: 'strict', httpOnly: true });
    reply.clearCookie('ob_csrf', { path: '/', secure, sameSite: 'strict' });
    return { ok: true };
  });
  app.get('/v1/dashboard/overview', { preHandler: requireDashboard, schema: { tags: ['dashboard'], summary: 'Get dashboard summary', security: [{ dashboardSession: [] }], response: { 200: { type: 'object', additionalProperties: true }, 401: errorSchema } } }, async (request) => services.getDashboardOverview(request.dashboardSession!.merchant));
  app.get<{ Querystring: { status?: InvoiceListQuery['status']; limit?: number; cursor?: string } }>('/v1/dashboard/invoices', {
    preHandler: requireDashboard,
    schema: { tags: ['dashboard'], summary: 'List dashboard invoices', security: [{ dashboardSession: [] }], querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: invoiceStatuses }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, cursor: { type: 'string', maxLength: 255 } } }, response: { 200: { type: 'object', additionalProperties: true }, 401: errorSchema } },
  }, async (request) => services.listInvoices(request.dashboardSession!.merchant, {
    limit: request.query.limit ?? 25,
    ...(request.query.status ? { status: request.query.status } : {}),
    ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
  }));
  app.get('/v1/dashboard/account', { preHandler: requireDashboard, schema: { tags: ['dashboard'], summary: 'Get dashboard account settings', security: [{ dashboardSession: [] }], response: { 200: { type: 'object', additionalProperties: true }, 401: errorSchema } } }, async (request) => services.getAccount(request.dashboardSession!.merchant));
  app.put<{ Body: { wallets: Array<{ asset: string; network: string; extended_public_key?: string; address?: string }> } }>('/v1/dashboard/account/wallets', { preHandler: [requireDashboard, requireDashboardCsrf], schema: { hide: true, body: { type: 'object' } } }, async (request) => services.updateWallets(request.dashboardSession!.merchant, request.body.wallets));
  app.put<{ Body: { url: string | null; rotate_secret?: boolean } }>('/v1/dashboard/account/webhook', { preHandler: [requireDashboard, requireDashboardCsrf], schema: { hide: true, body: { type: 'object' } } }, async (request) => services.setWebhook(request.dashboardSession!.merchant, request.body.url, request.body.rotate_secret ?? false));
  app.get('/v1/dashboard/webhooks', { preHandler: requireDashboard, schema: { tags: ['dashboard'], summary: 'Get recent webhook deliveries', security: [{ dashboardSession: [] }], response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } }, 401: errorSchema } } }, async (request) => services.listDashboardWebhooks(request.dashboardSession!.merchant));
  app.post('/v1/dashboard/webhooks/test', { preHandler: [requireDashboard, requireDashboardCsrf], config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { hide: true } }, async (request) => services.sendTestWebhook(request.dashboardSession!.merchant));
  app.get('/v1/dashboard/api-keys', { preHandler: requireDashboard, schema: { tags: ['dashboard'], summary: 'List merchant API keys', security: [{ dashboardSession: [] }], response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } }, 401: errorSchema } } }, async (request) => services.listDashboardApiKeys(request.dashboardSession!.merchant));
  app.post<{ Body: { name: string } }>('/v1/dashboard/api-keys', { preHandler: [requireDashboard, requireDashboardCsrf], schema: { hide: true, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 } } } } }, async (request, reply) => reply.code(201).send(await services.createDashboardApiKey(request.dashboardSession!.merchant, request.body.name)));
  app.delete<{ Params: { id: string } }>('/v1/dashboard/api-keys/:id', { preHandler: [requireDashboard, requireDashboardCsrf], schema: { hide: true, params: idParams } }, async (request, reply) => {
    const revoked = await services.revokeDashboardApiKey(request.dashboardSession!.merchant, request.params.id);
    return revoked ? { ok: true } : fail(reply, 404, 'api_key_not_found', 'API key not found.');
  });
  app.get<{ Params: { id: string } }>('/v1/public/invoices/:id', {
    schema: { tags: ['checkout'], summary: 'Read public payment details for checkout', security: [], params: idParams, response: { 200: publicInvoiceSchema, 404: errorSchema, 429: errorSchema } },
  }, async (request, reply) => {
    const invoice = await services.getPublicInvoice(request.params.id);
    return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });
  app.post<{ Params: { id: string } }>('/v1/public/invoices/:id/cancel', {
    schema: { tags: ['checkout'], summary: 'Cancel an unpaid checkout invoice', security: [], params: idParams, response: { 200: publicInvoiceSchema, 404: errorSchema, 409: errorSchema, 429: errorSchema } },
  }, async (request, reply) => {
    try {
      const invoice = await services.cancelPublicInvoice(request.params.id);
      return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
    } catch (error) {
      if (error instanceof ApiError) return fail(reply, error.statusCode, error.code, error.message, error.param);
      throw error;
    }
  });

  app.post<{ Body: CreateInvoiceInput }>('/v1/invoices', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['invoices'], summary: 'Create an invoice', security: [{ bearerAuth: [] }],
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 } } },
      body: createBody, response: { ...invoiceResponse, 201: invoiceSchema },
    },
  }, async (request, reply) => {
    try {
      const invoice = await services.createInvoice(request.merchant!, request.headers['idempotency-key'] as string, request.body);
      return reply.code(201).send(invoice);
    } catch (error) {
      if (error instanceof ApiError) return fail(reply, error.statusCode, error.code, error.message, error.param);
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/v1/invoices/:id', { schema: { tags: ['invoices'], summary: 'Get invoice details', params: idParams, response: invoiceResponse } }, async (request, reply) => {
    const invoice = await services.getInvoice(request.merchant!, request.params.id);
    return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });

  app.get<{ Querystring: InvoiceListQuery & { status?: InvoiceListQuery['status']; limit: number; cursor?: string } }>('/v1/invoices', {
    schema: {
      tags: ['invoices'], summary: 'List invoices',
      querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: invoiceStatuses }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, cursor: { type: 'string', maxLength: 255 } } },
      response: { 200: { type: 'object', required: ['data', 'next_cursor'], properties: { data: { type: 'array', items: invoiceSchema }, next_cursor: { type: ['string', 'null'] } } }, 400: errorSchema, 401: errorSchema, 429: errorSchema },
    },
  }, async (request) => services.listInvoices(request.merchant!, { ...request.query, limit: request.query.limit ?? 25 }));

  app.post<{ Params: { id: string } }>('/v1/invoices/:id/cancel', { schema: { tags: ['invoices'], summary: 'Cancel an unpaid invoice', params: idParams, response: invoiceResponse } }, async (request, reply) => {
    try {
      const invoice = await services.cancelInvoice(request.merchant!, request.params.id);
      return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
    } catch (error) {
      if (error instanceof ApiError) return fail(reply, error.statusCode, error.code, error.message, error.param);
      throw error;
    }
  });

  app.get('/v1/assets', { schema: { tags: ['account'], summary: 'List enabled assets', response: { 200: { type: 'array', items: { type: 'object', required: ['asset', 'network', 'enabled'], properties: { asset: { type: 'string' }, network: { type: 'string' }, enabled: { type: 'boolean' } } } } } } }, async (request) => services.getAssets(request.merchant!));
  app.get('/v1/account', { schema: { tags: ['account'], summary: 'Get merchant settings', response: { 200: { type: 'object', additionalProperties: true } } } }, async (request) => services.getAccount(request.merchant!));

  app.put<{ Body: { wallets: Array<{ asset: string; network: string; extended_public_key?: string; address?: string }> } }>('/v1/account/wallets', {
    schema: {
      tags: ['account'], summary: 'Set public wallet configuration',
      body: { type: 'object', additionalProperties: false, required: ['wallets'], properties: { wallets: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['asset', 'network'], properties: { asset: { type: 'string', minLength: 2, maxLength: 32 }, network: { type: 'string', minLength: 2, maxLength: 48 }, extended_public_key: { type: 'string', maxLength: 256 }, address: { type: 'string', maxLength: 256 } } } } } },
      response: { 200: { type: 'object', additionalProperties: true }, 400: errorSchema, 401: errorSchema, 422: errorSchema },
    },
  }, async (request) => services.updateWallets(request.merchant!, request.body.wallets));

  app.put<{ Body: { url: string | null; rotate_secret?: boolean } }>('/v1/account/webhook', {
    schema: {
      tags: ['account'], summary: 'Set the webhook endpoint or rotate its signing secret',
      body: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: ['string', 'null'], format: 'uri', pattern: '^https?://', maxLength: 2048 }, rotate_secret: { type: 'boolean', default: false } } },
      response: { 200: { type: 'object', required: ['webhook_url'], properties: { webhook_url: { type: ['string', 'null'] }, signing_secret: { type: 'string' } } }, 400: errorSchema, 401: errorSchema, 422: errorSchema, 500: errorSchema },
    },
  }, async (request) => services.setWebhook(request.merchant!, request.body.url, request.body.rotate_secret ?? false));

  app.post('/v1/webhooks/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags: ['webhooks'], summary: 'Send a test webhook', response: { 200: { type: 'object', required: ['accepted'], properties: { accepted: { type: 'boolean' } } }, 401: errorSchema, 422: errorSchema, 429: errorSchema, 500: errorSchema } } }, async (request) => services.sendTestWebhook(request.merchant!));

  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  return app;
}
