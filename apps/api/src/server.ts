import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
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
}

declare module 'fastify' {
  interface FastifyRequest {
    merchant: MerchantContext | null;
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
  code(statusCode: 400 | 401 | 404 | 409 | 422 | 429 | 500): {
    send(payload: { error: { code: string; message: string; param?: string } }): unknown;
  };
};

function fail(reply: ErrorReply, status: 400 | 401 | 404 | 409 | 422 | 429 | 500, code: string, message: string, param?: string) {
  return reply.code(status).send({ error: { code, message, ...(param ? { param } : {}) } });
}

export async function buildServer(services: ApiServices, options: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger === false ? false : { redact: ['req.headers.authorization', 'req.headers.cookie'] },
    logController: new LogController({ disableRequestLogging: false, requestIdLogLabel: 'request_id' }),
    requestIdHeader: 'x-request-id',
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true } },
  });
  app.decorateRequest('merchant', null);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'ORBITT PAY API', version: '1.0.0', description: 'Merchant API for non-custodial crypto payment invoices.' },
      servers: [{ url: '/v1' }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
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
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return fail(reply, error.statusCode, error.code, error.message, error.param);
    const validation = (error as Error & { validation?: Array<{ instancePath?: string }> }).validation;
    if (validation) return fail(reply, 400, 'invalid_request', 'The request is invalid.', validation[0]?.instancePath || undefined);
    request.log.error({ err: error }, 'Unhandled API error');
    return fail(reply, 500, 'internal_error', 'An unexpected error occurred.');
  });

  app.addHook('preHandler', async (request, reply) => {
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
