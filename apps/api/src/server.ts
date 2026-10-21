import Fastify, { LogController } from 'fastify';
import type { FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { hashApiKey, readBearerToken } from './auth/api-key.js';
import { can, permissionsFor, ROLES, type Permission, type Role } from './auth/roles.js';
import type { InvoiceResource } from '@orbitt/core';
import { ApiError } from './errors.js';
export { ApiError } from './errors.js';

export const invoiceStatuses = [
  'created', 'awaiting_payment', 'detected', 'confirming', 'paid',
  'underpaid', 'overpaid', 'expired', 'late_payment', 'cancelled',
] as const;

/** Who performs a change, recorded in the audit log. */
export interface AuditActor {
  type: 'user' | 'api_key' | 'system';
  id: string | null;
  label: string | null;
  ip?: string | null;
}

export interface MerchantContext {
  id: string;
  name: string;
  actor?: AuditActor;
}

export type InvoiceRecord = InvoiceResource;

export interface PaymentOptionRecord {
  asset: string;
  network: string;
  name: string;
  network_name: string;
  decimals: number;
  contract: string | null;
}

export interface PublicInvoiceRecord {
  id: string;
  merchant_name: string;
  order_id: string | null;
  request_amount: string;
  request_currency: string;
  crypto_amount: string | null;
  crypto_amount_base_units: string | null;
  asset: string | null;
  asset_name: string | null;
  asset_decimals: number | null;
  network: string | null;
  network_name: string | null;
  token_contract: string | null;
  address: string | null;
  address_mode: 'derived' | 'shared';
  received_amount: string;
  remaining_amount: string;
  status: typeof invoiceStatuses[number];
  created_at: string;
  expires_at: string;
  success_url: string | null;
  cancel_url: string | null;
  payment_options: PaymentOptionRecord[];
  /** Confirmations on the least-confirmed transfer, null before the first transfer. */
  confirmations: number | null;
  required_confirmations: number | null;
  /** Rough seconds until the invoice is confirmed, while it is confirming. */
  confirmation_eta_seconds: number | null;
  transactions: Array<{ transaction_id: string; amount: string; confirmations: number; observed_at: string }>;
}

export interface AssetRecord {
  asset: string;
  network: string;
  name: string;
  network_name: string;
  decimals: number;
  contract: string | null;
  wallet_asset: string;
  family: 'utxo' | 'evm' | 'tron' | 'solana';
  address_mode: 'derived' | 'shared';
  enabled: boolean;
  available: boolean;
}

export interface InvoiceTimelineEntry {
  status: typeof invoiceStatuses[number];
  from_status: typeof invoiceStatuses[number] | null;
  received_amount: string;
  at: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: { type: AuditActor['type']; id: string | null; label: string | null };
  target: { type: string; id: string } | null;
  details: Record<string, unknown>;
  ip: string | null;
  created_at: string;
}

export interface InvoiceDetail {
  invoice: InvoiceRecord;
  /** Every status the invoice passed through, oldest first. */
  timeline: InvoiceTimelineEntry[];
  /** HD path of the receiving address below the wallet's root, so the merchant can find the funds. */
  derivation_path: string | null;
  payments: Array<{ transaction_id: string; asset: string; amount: string; confirmations: string; block_number: string | null; observed_at: string }>;
  webhooks: Array<Record<string, unknown>>;
}

export interface WalletInput {
  asset: string;
  network: string;
  extended_public_key?: string;
  address?: string;
}

export interface DashboardUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

export interface DashboardLogin {
  sessionToken: string;
  csrfToken: string;
  merchant: MerchantContext;
  email: string;
  user: DashboardUser;
}

export interface DashboardSession {
  merchant: MerchantContext;
  email: string;
  csrfHash: string;
  sessionId: string;
  user: DashboardUser;
}

/** Where a dashboard request comes from; stored with sessions and audit entries. */
export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: 'active' | 'disabled';
  created_at: string;
  last_login_at: string | null;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: Role;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
}

export interface SessionRecord {
  id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
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

type ListQuerystring = { status?: string; search?: string; limit?: string; cursor?: string };

export interface InvoiceListQuery {
  /** One status, or several to match any of them. */
  status?: typeof invoiceStatuses[number] | Array<typeof invoiceStatuses[number]>;
  search?: string;
  limit: number;
  cursor?: string;
}

/** Persistence and payment-domain boundary implemented by the API composition root. */
export interface ApiServices {
  authenticateKey(keyHash: string): Promise<MerchantContext | null>;
  createInvoice(merchant: MerchantContext, idempotencyKey: string, input: CreateInvoiceInput): Promise<InvoiceRecord>;
  getInvoice(merchant: MerchantContext, id: string): Promise<InvoiceRecord | null>;
  getInvoiceDetail(merchant: MerchantContext, id: string): Promise<InvoiceDetail | null>;
  getPublicInvoice(id: string): Promise<PublicInvoiceRecord | null>;
  selectPublicPayment(id: string, asset: string, network: string): Promise<PublicInvoiceRecord | null>;
  cancelPublicInvoice(id: string): Promise<PublicInvoiceRecord | null>;
  listInvoices(merchant: MerchantContext, query: InvoiceListQuery): Promise<{ data: InvoiceRecord[]; next_cursor: string | null }>;
  cancelInvoice(merchant: MerchantContext, id: string): Promise<InvoiceRecord | null>;
  getAssets(merchant: MerchantContext): Promise<AssetRecord[]>;
  getNetworkStatus(): Promise<Array<Record<string, unknown>>>;
  getAccount(merchant: MerchantContext): Promise<Record<string, unknown>>;
  updateWallets(merchant: MerchantContext, wallets: WalletInput[]): Promise<Record<string, unknown>>;
  deleteWallet(merchant: MerchantContext, asset: string, network: string): Promise<boolean>;
  setWebhook(merchant: MerchantContext, url: string | null, rotateSecret: boolean): Promise<{ webhook_url: string | null; signing_secret?: string }>;
  sendTestWebhook(merchant: MerchantContext): Promise<{ accepted: boolean }>;
  redeliverWebhook(merchant: MerchantContext, deliveryId: string): Promise<boolean>;
  loginDashboard(email: string, password: string, client?: ClientInfo): Promise<DashboardLogin | null>;
  authenticateDashboardSession(sessionToken: string): Promise<DashboardSession | null>;
  revokeDashboardSession(sessionToken: string): Promise<void>;
  getDashboardOverview(merchant: MerchantContext): Promise<Record<string, unknown>>;
  listDashboardWebhooks(merchant: MerchantContext): Promise<Array<Record<string, unknown>>>;
  listDashboardApiKeys(merchant: MerchantContext): Promise<Array<Record<string, unknown>>>;
  createDashboardApiKey(merchant: MerchantContext, name: string): Promise<{ id: string; name: string; key_prefix: string; secret: string }>;
  revokeDashboardApiKey(merchant: MerchantContext, id: string): Promise<boolean>;
  listAuditLog(merchant: MerchantContext, query: { limit: number; cursor?: string; action?: string }): Promise<{ data: AuditEntry[]; next_cursor: string | null }>;
  verifyAuditLog(merchant: MerchantContext): Promise<{ intact: boolean; entries: number; broken_at: string | null }>;
  listTeam(session: DashboardSession): Promise<{ members: TeamMember[]; invitations: TeamInvitation[] }>;
  createInvitation(session: DashboardSession, email: string, role: Role): Promise<TeamInvitation & { token: string }>;
  revokeInvitation(session: DashboardSession, id: string): Promise<boolean>;
  updateMember(session: DashboardSession, id: string, changes: { role?: Role; disabled?: boolean }): Promise<TeamMember | null>;
  getInvitation(token: string): Promise<{ merchant_name: string; email: string; role: Role; expires_at: string } | null>;
  acceptInvitation(token: string, input: { name: string; password: string }, client?: ClientInfo): Promise<DashboardLogin>;
  changePassword(session: DashboardSession, currentPassword: string, newPassword: string): Promise<boolean>;
  listSessions(session: DashboardSession): Promise<SessionRecord[]>;
  revokeSession(session: DashboardSession, id: string): Promise<boolean>;
  revokeOtherSessions(session: DashboardSession): Promise<number>;
  renameWorkspace(session: DashboardSession, name: string): Promise<MerchantContext>;
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

const nullableString = { type: ['string', 'null'] } as const;

const invoiceSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'amount', 'currency', 'crypto_amount', 'asset', 'network', 'status', 'checkout_url', 'received_amount', 'surplus_amount', 'expires_at', 'created_at', 'updated_at', 'metadata'],
  properties: {
    id: { type: 'string', format: 'uuid' }, order_id: nullableString,
    amount: { type: 'string' }, currency: { type: 'string' }, crypto_amount: nullableString,
    asset: nullableString, network: nullableString, address: nullableString,
    status: { type: 'string', enum: invoiceStatuses }, checkout_url: { type: 'string', format: 'uri' },
    received_amount: { type: 'string' }, surplus_amount: { type: 'string' }, exchange_rate: nullableString,
    confirmations: { type: ['integer', 'null'] }, required_confirmations: { type: ['integer', 'null'] },
    expires_at: { type: 'string', format: 'date-time' }, created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const walletsBody = {
  type: 'object', additionalProperties: false, required: ['wallets'],
  properties: { wallets: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['asset', 'network'], properties: { asset: { type: 'string', minLength: 2, maxLength: 32 }, network: { type: 'string', minLength: 2, maxLength: 48 }, extended_public_key: { type: 'string', maxLength: 256 }, address: { type: 'string', maxLength: 256 } } } } },
} as const;

const webhookBody = {
  type: 'object', additionalProperties: false, required: ['url'],
  properties: { url: { type: ['string', 'null'], format: 'uri', pattern: '^https?://', maxLength: 2048 }, rotate_secret: { type: 'boolean', default: false } },
} as const;

const statusPattern = `^(${invoiceStatuses.join('|')})(,(${invoiceStatuses.join('|')}))*$`;

const listQuery = {
  type: 'object', additionalProperties: false,
  properties: { status: { type: 'string', pattern: statusPattern, maxLength: 200, description: 'One status or a comma-separated list, e.g. `awaiting_payment,underpaid`.' }, search: { type: 'string', minLength: 1, maxLength: 120 }, limit: { type: 'string', pattern: '^(100|[1-9][0-9]?)$' }, cursor: { type: 'string', maxLength: 255 } },
} as const;

const idParams = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const paymentOptionSchema = {
  type: 'object', additionalProperties: false, required: ['asset', 'network', 'name', 'network_name', 'decimals', 'contract'],
  properties: { asset: { type: 'string' }, network: { type: 'string' }, name: { type: 'string' }, network_name: { type: 'string' }, decimals: { type: 'integer' }, contract: nullableString },
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

function withIp(merchant: MerchantContext, ip: string): MerchantContext {
  return merchant.actor ? { ...merchant, actor: { ...merchant.actor, ip } } : merchant;
}

function parseStatuses(value: string): NonNullable<InvoiceListQuery['status']> {
  const statuses = [...new Set(value.split(','))] as Array<typeof invoiceStatuses[number]>;
  return statuses.length === 1 ? statuses[0]! : statuses;
}

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
      request.merchant = withIp(merchant, request.ip);
    } catch (error) {
      request.log.error({ err: error }, 'API key authentication failed');
      return fail(reply, 500, 'internal_error', 'An unexpected error occurred.');
    }
  });

  app.get('/health', { schema: { tags: ['system'], response: { 200: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } } } }, async () => ({ status: 'ok' }));

  const publicInvoiceSchema = {
    type: 'object', additionalProperties: false,
    required: ['id', 'merchant_name', 'request_amount', 'request_currency', 'status', 'created_at', 'expires_at', 'payment_options'],
    properties: {
      id: { type: 'string', format: 'uuid' }, merchant_name: { type: 'string' }, order_id: nullableString,
      request_amount: { type: 'string' }, request_currency: { type: 'string' },
      crypto_amount: nullableString, crypto_amount_base_units: nullableString,
      asset: nullableString, asset_name: nullableString, asset_decimals: { type: ['integer', 'null'] }, network: nullableString, network_name: nullableString,
      token_contract: nullableString, address: nullableString, address_mode: { type: 'string', enum: ['derived', 'shared'] },
      received_amount: { type: 'string' }, remaining_amount: { type: 'string' },
      status: { type: 'string', enum: invoiceStatuses },
      created_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, success_url: nullableString, cancel_url: nullableString,
      payment_options: { type: 'array', items: paymentOptionSchema },
      confirmations: { type: ['integer', 'null'] }, required_confirmations: { type: ['integer', 'null'] },
      confirmation_eta_seconds: { type: ['integer', 'null'] },
      transactions: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['transaction_id', 'amount', 'confirmations', 'observed_at'],
          properties: { transaction_id: { type: 'string' }, amount: { type: 'string' }, confirmations: { type: 'integer' }, observed_at: { type: 'string', format: 'date-time' } },
        },
      },
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
      request.dashboardSession = { ...session, merchant: withIp(session.merchant, request.ip) };
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

  const requirePermission = (permission: Permission) => async (request: ApiRequest, reply: ApiReply) => {
    if (!request.dashboardSession || !can(request.dashboardSession.user.role, permission)) {
      return fail(reply, 403, 'insufficient_role', 'Your role does not allow this change. Ask a workspace owner or admin.');
    }
  };
  const write = (permission: Permission) => [requireDashboard, requireDashboardCsrf, requirePermission(permission)];
  const sessionView = (session: { merchant: MerchantContext; user: DashboardUser }) => ({
    merchant: { id: session.merchant.id, name: session.merchant.name },
    email: session.user.email,
    user: { id: session.user.id, email: session.user.email, name: session.user.name, role: session.user.role },
    permissions: permissionsFor(session.user.role),
  });
  const sessionSchema = {
    type: 'object', additionalProperties: false, required: ['merchant', 'email', 'user', 'permissions'],
    properties: {
      merchant: { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
      email: { type: 'string' },
      user: { type: 'object', additionalProperties: false, required: ['id', 'email', 'name', 'role'], properties: { id: { type: 'string' }, email: { type: 'string' }, name: nullableString, role: { type: 'string', enum: ROLES } } },
      permissions: { type: 'array', items: { type: 'string' } },
    },
  } as const;
  const setSessionCookies = (reply: ApiReply, login: DashboardLogin) => {
    const secure = process.env.NODE_ENV === 'production';
    const cookieOptions = { path: '/v1/dashboard', sameSite: 'strict' as const, secure, maxAge: 8 * 60 * 60 };
    reply.setCookie('ob_session', login.sessionToken, { ...cookieOptions, httpOnly: true });
    reply.setCookie('ob_csrf', login.csrfToken, { ...cookieOptions, path: '/', httpOnly: false });
  };
  const clientInfo = (request: ApiRequest): ClientInfo => {
    const agent = request.headers['user-agent'];
    return { ip: request.ip, ...(typeof agent === 'string' ? { userAgent: agent.slice(0, 512) } : {}) };
  };

  app.post<{ Body: { email: string; password: string } }>('/v1/dashboard/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['dashboard'], summary: 'Sign in to the merchant dashboard', security: [],
      body: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: { email: { type: 'string', format: 'email', maxLength: 320 }, password: { type: 'string', minLength: 1, maxLength: 1024 } } },
      response: { 200: sessionSchema, 400: errorSchema, 401: errorSchema, 429: errorSchema },
    },
  }, async (request, reply) => {
    const result = await services.loginDashboard(request.body.email, request.body.password, clientInfo(request));
    if (!result) return fail(reply, 401, 'invalid_credentials', 'Email or password is incorrect.');
    setSessionCookies(reply, result);
    return reply.send(sessionView(result));
  });
  app.get('/v1/dashboard/session', { preHandler: requireDashboard, schema: { tags: ['dashboard'], summary: 'Get the signed-in dashboard session', security: [{ dashboardSession: [] }], response: { 200: sessionSchema, 401: errorSchema } } }, async (request) => sessionView(request.dashboardSession!));

  const inviteToken = { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } as const;
  const password = { type: 'string', minLength: 12, maxLength: 1024 } as const;
  app.get<{ Params: { token: string } }>('/v1/dashboard/invitations/:token', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['dashboard'], summary: 'Read a team invitation', security: [], params: inviteToken, response: { 200: { type: 'object', additionalProperties: false, required: ['merchant_name', 'email', 'role', 'expires_at'], properties: { merchant_name: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' } } }, 404: errorSchema, 429: errorSchema } },
  }, async (request, reply) => {
    const invitation = await services.getInvitation(request.params.token);
    return invitation ? reply.send(invitation) : fail(reply, 404, 'invitation_not_found', 'This invitation is invalid, expired or was already used.');
  });
  app.post<{ Params: { token: string }; Body: { name: string; password: string } }>('/v1/dashboard/invitations/:token/accept', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['dashboard'], summary: 'Accept a team invitation, set a password and sign in', security: [], params: inviteToken,
      body: { type: 'object', additionalProperties: false, required: ['name', 'password'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, password } },
      response: { 200: sessionSchema, 400: errorSchema, 404: errorSchema, 409: errorSchema, 429: errorSchema },
    },
  }, async (request, reply) => {
    const login = await services.acceptInvitation(request.params.token, request.body, clientInfo(request));
    setSessionCookies(reply, login);
    return reply.send(sessionView(login));
  });
  app.post('/v1/dashboard/logout', { preHandler: [requireDashboard, requireDashboardCsrf], schema: { tags: ['dashboard'], summary: 'Sign out of the dashboard', security: [{ dashboardSession: [] }], response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, 401: errorSchema, 403: errorSchema } } }, async (request, reply) => {
    await services.revokeDashboardSession(request.cookies.ob_session!);
    const secure = process.env.NODE_ENV === 'production';
    reply.clearCookie('ob_session', { path: '/v1/dashboard', secure, sameSite: 'strict', httpOnly: true });
    reply.clearCookie('ob_csrf', { path: '/', secure, sameSite: 'strict' });
    return { ok: true };
  });
  app.get('/v1/dashboard/overview', { preHandler: requireDashboard, schema: { tags: ['dashboard'], summary: 'Get dashboard summary', security: [{ dashboardSession: [] }], response: { 200: { type: 'object', additionalProperties: true }, 401: errorSchema } } }, async (request) => services.getDashboardOverview(request.dashboardSession!.merchant));
  const dashboard = { tags: ['dashboard'], security: [{ dashboardSession: [] }] };
  // Query strings arrive as text and AJV coercion is off, so the limit is validated as digits and parsed here.
  const listQueryFrom = (query: ListQuerystring): InvoiceListQuery => ({
    limit: query.limit ? Number(query.limit) : 25,
    ...(query.status ? { status: parseStatuses(query.status) } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  app.get<{ Querystring: ListQuerystring }>('/v1/dashboard/invoices', {
    preHandler: requireDashboard,
    schema: { ...dashboard, summary: 'List dashboard invoices', querystring: listQuery, response: { 200: { type: 'object', required: ['data', 'next_cursor'], properties: { data: { type: 'array', items: invoiceSchema }, next_cursor: nullableString } }, 400: errorSchema, 401: errorSchema } },
  }, async (request) => services.listInvoices(request.dashboardSession!.merchant, listQueryFrom(request.query)));
  app.post<{ Body: CreateInvoiceInput }>('/v1/dashboard/invoices', {
    preHandler: write('payments'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { ...dashboard, summary: 'Create a payment link from the dashboard', body: createBody, response: { 201: invoiceSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 409: errorSchema, 422: errorSchema } },
  }, async (request, reply) => reply.code(201).send(await services.createInvoice(request.dashboardSession!.merchant, `dashboard:${randomUUID()}`, request.body)));
  app.get<{ Params: { id: string } }>('/v1/dashboard/invoices/:id', {
    preHandler: requireDashboard,
    schema: { ...dashboard, summary: 'Get invoice detail with payments and webhook deliveries', params: idParams, response: { 200: { type: 'object', additionalProperties: true }, 401: errorSchema, 404: errorSchema } },
  }, async (request, reply) => {
    const detail = await services.getInvoiceDetail(request.dashboardSession!.merchant, request.params.id);
    return detail ? reply.send(detail) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });
  app.post<{ Params: { id: string } }>('/v1/dashboard/invoices/:id/cancel', {
    preHandler: write('payments'),
    schema: { ...dashboard, summary: 'Cancel an unpaid invoice', params: idParams, response: { 200: invoiceSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema } },
  }, async (request, reply) => {
    const invoice = await services.cancelInvoice(request.dashboardSession!.merchant, request.params.id);
    return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });
  app.get('/v1/dashboard/account', { preHandler: requireDashboard, schema: { ...dashboard, summary: 'Get dashboard account settings', response: { 200: { type: 'object', additionalProperties: true }, 401: errorSchema } } }, async (request) => services.getAccount(request.dashboardSession!.merchant));
  app.get('/v1/dashboard/assets', { preHandler: requireDashboard, schema: { ...dashboard, summary: 'List the asset catalog with availability and scanner health', response: { 200: { type: 'object', additionalProperties: true }, 401: errorSchema } } }, async (request) => ({
    assets: await services.getAssets(request.dashboardSession!.merchant),
    networks: await services.getNetworkStatus(),
  }));
  app.put<{ Body: { wallets: WalletInput[] } }>('/v1/dashboard/account/wallets', { preHandler: write('wallets'), schema: { ...dashboard, summary: 'Set public wallet configuration', body: walletsBody, response: { 200: { type: 'object', additionalProperties: true }, 400: errorSchema, 401: errorSchema, 403: errorSchema, 409: errorSchema, 422: errorSchema } } }, async (request) => services.updateWallets(request.dashboardSession!.merchant, request.body.wallets));
  app.delete<{ Params: { asset: string; network: string } }>('/v1/dashboard/account/wallets/:asset/:network', {
    preHandler: write('wallets'),
    schema: { ...dashboard, summary: 'Remove a wallet', params: { type: 'object', additionalProperties: false, required: ['asset', 'network'], properties: { asset: { type: 'string', pattern: '^[A-Z0-9]{2,16}$' }, network: { type: 'string', pattern: '^[a-z0-9-]{2,48}$' } } }, response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema } },
  }, async (request, reply) => {
    const removed = await services.deleteWallet(request.dashboardSession!.merchant, request.params.asset, request.params.network);
    return removed ? { ok: true } : fail(reply, 404, 'wallet_not_found', 'Wallet not found.');
  });
  app.put<{ Body: { url: string | null; rotate_secret?: boolean } }>('/v1/dashboard/account/webhook', { preHandler: write('developers'), schema: { ...dashboard, summary: 'Set the webhook endpoint', body: webhookBody, response: { 200: { type: 'object', required: ['webhook_url'], properties: { webhook_url: nullableString, signing_secret: { type: 'string' } } }, 400: errorSchema, 401: errorSchema, 403: errorSchema, 422: errorSchema, 500: errorSchema } } }, async (request) => services.setWebhook(request.dashboardSession!.merchant, request.body.url, request.body.rotate_secret ?? false));
  app.get('/v1/dashboard/webhooks', { preHandler: requireDashboard, schema: { ...dashboard, summary: 'Get recent webhook deliveries', response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } }, 401: errorSchema } } }, async (request) => services.listDashboardWebhooks(request.dashboardSession!.merchant));
  app.post('/v1/dashboard/webhooks/test', { preHandler: write('developers'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { ...dashboard, summary: 'Send a test webhook', response: { 200: { type: 'object', required: ['accepted'], properties: { accepted: { type: 'boolean' } } }, 401: errorSchema, 403: errorSchema, 422: errorSchema, 429: errorSchema } } }, async (request) => services.sendTestWebhook(request.dashboardSession!.merchant));
  app.post<{ Params: { id: string } }>('/v1/dashboard/webhooks/:id/redeliver', {
    preHandler: write('developers'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { ...dashboard, summary: 'Queue a webhook delivery again', params: idParams, response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, 401: errorSchema, 403: errorSchema, 404: errorSchema, 429: errorSchema } },
  }, async (request, reply) => {
    const queued = await services.redeliverWebhook(request.dashboardSession!.merchant, request.params.id);
    return queued ? { ok: true } : fail(reply, 404, 'webhook_delivery_not_found', 'Webhook delivery not found.');
  });
  app.get('/v1/dashboard/api-keys', { preHandler: requireDashboard, schema: { ...dashboard, summary: 'List merchant API keys', response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } }, 401: errorSchema } } }, async (request) => services.listDashboardApiKeys(request.dashboardSession!.merchant));
  app.post<{ Body: { name: string } }>('/v1/dashboard/api-keys', { preHandler: write('developers'), schema: { ...dashboard, summary: 'Create a secret API key', body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 } } }, response: { 201: { type: 'object', required: ['id', 'name', 'key_prefix', 'secret'], properties: { id: { type: 'string' }, name: { type: 'string' }, key_prefix: { type: 'string' }, secret: { type: 'string' } } }, 401: errorSchema, 403: errorSchema } } }, async (request, reply) => reply.code(201).send(await services.createDashboardApiKey(request.dashboardSession!.merchant, request.body.name)));
  app.delete<{ Params: { id: string } }>('/v1/dashboard/api-keys/:id', { preHandler: write('developers'), schema: { ...dashboard, summary: 'Revoke an API key', params: idParams, response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, 401: errorSchema, 403: errorSchema, 404: errorSchema } } }, async (request, reply) => {
    const revoked = await services.revokeDashboardApiKey(request.dashboardSession!.merchant, request.params.id);
    return revoked ? { ok: true } : fail(reply, 404, 'api_key_not_found', 'API key not found.');
  });
  const memberSchema = {
    type: 'object', additionalProperties: false, required: ['id', 'email', 'name', 'role', 'status', 'created_at', 'last_login_at'],
    properties: { id: { type: 'string' }, email: { type: 'string' }, name: nullableString, role: { type: 'string', enum: ROLES }, status: { type: 'string', enum: ['active', 'disabled'] }, created_at: { type: 'string', format: 'date-time' }, last_login_at: nullableString },
  } as const;
  const invitationSchema = {
    type: 'object', additionalProperties: false, required: ['id', 'email', 'role', 'invited_by', 'created_at', 'expires_at'],
    properties: { id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', enum: ROLES }, invited_by: nullableString, created_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, token: { type: 'string' } },
  } as const;
  const okSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } as const;
  app.get('/v1/dashboard/team', { preHandler: requireDashboard, schema: { ...dashboard, summary: 'List team members and pending invitations', response: { 200: { type: 'object', additionalProperties: false, required: ['members', 'invitations'], properties: { members: { type: 'array', items: memberSchema }, invitations: { type: 'array', items: invitationSchema } } }, 401: errorSchema } } }, async (request) => services.listTeam(request.dashboardSession!));
  app.post<{ Body: { email: string; role: Role } }>('/v1/dashboard/team/invitations', {
    preHandler: write('team'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { ...dashboard, summary: 'Invite a team member; returns the invitation token once', body: { type: 'object', additionalProperties: false, required: ['email', 'role'], properties: { email: { type: 'string', format: 'email', maxLength: 320 }, role: { type: 'string', enum: ROLES } } }, response: { 201: invitationSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 409: errorSchema, 429: errorSchema } },
  }, async (request, reply) => reply.code(201).send(await services.createInvitation(request.dashboardSession!, request.body.email, request.body.role)));
  app.delete<{ Params: { id: string } }>('/v1/dashboard/team/invitations/:id', {
    preHandler: write('team'),
    schema: { ...dashboard, summary: 'Revoke a pending invitation', params: idParams, response: { 200: okSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema } },
  }, async (request, reply) => (await services.revokeInvitation(request.dashboardSession!, request.params.id)) ? { ok: true } : fail(reply, 404, 'invitation_not_found', 'Invitation not found.'));
  app.patch<{ Params: { id: string }; Body: { role?: Role; disabled?: boolean } }>('/v1/dashboard/team/members/:id', {
    preHandler: write('team'),
    schema: { ...dashboard, summary: 'Change a member role or disable a member', params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { role: { type: 'string', enum: ROLES }, disabled: { type: 'boolean' } } }, response: { 200: memberSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema } },
  }, async (request, reply) => {
    const member = await services.updateMember(request.dashboardSession!, request.params.id, request.body);
    return member ? reply.send(member) : fail(reply, 404, 'member_not_found', 'Team member not found.');
  });
  app.put<{ Body: { name: string } }>('/v1/dashboard/workspace', {
    preHandler: write('workspace'),
    schema: { ...dashboard, summary: 'Rename the workspace', body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 160 } } }, response: { 200: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } }, 400: errorSchema, 401: errorSchema, 403: errorSchema } },
  }, async (request) => {
    const merchant = await services.renameWorkspace(request.dashboardSession!, request.body.name);
    return { id: merchant.id, name: merchant.name };
  });
  app.put<{ Body: { current_password: string; new_password: string } }>('/v1/dashboard/me/password', {
    preHandler: [requireDashboard, requireDashboardCsrf],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { ...dashboard, summary: 'Change your password and sign out other sessions', body: { type: 'object', additionalProperties: false, required: ['current_password', 'new_password'], properties: { current_password: { type: 'string', minLength: 1, maxLength: 1024 }, new_password: password } }, response: { 200: okSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 422: errorSchema, 429: errorSchema } },
  }, async (request, reply) => {
    const changed = await services.changePassword(request.dashboardSession!, request.body.current_password, request.body.new_password);
    return changed ? { ok: true } : fail(reply, 422, 'invalid_current_password', 'The current password is incorrect.', 'current_password');
  });
  const sessionRecordSchema = {
    type: 'object', additionalProperties: false, required: ['id', 'ip', 'user_agent', 'created_at', 'last_seen_at', 'expires_at', 'current'],
    properties: { id: { type: 'string' }, ip: nullableString, user_agent: nullableString, created_at: { type: 'string', format: 'date-time' }, last_seen_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, current: { type: 'boolean' } },
  } as const;
  app.get('/v1/dashboard/me/sessions', { preHandler: requireDashboard, schema: { ...dashboard, summary: 'List your active sessions', response: { 200: { type: 'array', items: sessionRecordSchema }, 401: errorSchema } } }, async (request) => services.listSessions(request.dashboardSession!));
  app.delete<{ Params: { id: string } }>('/v1/dashboard/me/sessions/:id', {
    preHandler: [requireDashboard, requireDashboardCsrf],
    schema: { ...dashboard, summary: 'Sign out one of your sessions', params: idParams, response: { 200: okSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema } },
  }, async (request, reply) => (await services.revokeSession(request.dashboardSession!, request.params.id)) ? { ok: true } : fail(reply, 404, 'session_not_found', 'Session not found.'));
  app.post('/v1/dashboard/me/sessions/revoke-others', {
    preHandler: [requireDashboard, requireDashboardCsrf],
    schema: { ...dashboard, summary: 'Sign out all your other sessions', response: { 200: { type: 'object', required: ['revoked'], properties: { revoked: { type: 'integer' } } }, 401: errorSchema, 403: errorSchema } },
  }, async (request) => ({ revoked: await services.revokeOtherSessions(request.dashboardSession!) }));

  const auditEntrySchema = {
    type: 'object', additionalProperties: false, required: ['id', 'action', 'actor', 'target', 'details', 'ip', 'created_at'],
    properties: {
      id: { type: 'string' }, action: { type: 'string' },
      actor: { type: 'object', additionalProperties: false, required: ['type', 'id', 'label'], properties: { type: { type: 'string', enum: ['user', 'api_key', 'system'] }, id: nullableString, label: nullableString } },
      target: { type: ['object', 'null'], additionalProperties: false, required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' } } },
      details: { type: 'object', additionalProperties: true }, ip: nullableString, created_at: { type: 'string', format: 'date-time' },
    },
  } as const;
  app.get<{ Querystring: { limit?: string; cursor?: string; action?: string } }>('/v1/dashboard/audit-log', {
    preHandler: requireDashboard,
    schema: {
      ...dashboard, summary: 'List the workspace audit log, newest first',
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^(100|[1-9][0-9]?)$' }, cursor: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, action: { type: 'string', pattern: '^[a-z_]+(\\.[a-z_]+)?$', maxLength: 64 } } },
      response: { 200: { type: 'object', required: ['data', 'next_cursor'], properties: { data: { type: 'array', items: auditEntrySchema }, next_cursor: nullableString } }, 400: errorSchema, 401: errorSchema },
    },
  }, async (request) => services.listAuditLog(request.dashboardSession!.merchant, {
    limit: request.query.limit ? Number(request.query.limit) : 50,
    ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
    ...(request.query.action ? { action: request.query.action } : {}),
  }));
  app.get('/v1/dashboard/audit-log/verify', {
    preHandler: requireDashboard,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { ...dashboard, summary: 'Verify the audit log hash chain', response: { 200: { type: 'object', additionalProperties: false, required: ['intact', 'entries', 'broken_at'], properties: { intact: { type: 'boolean' }, entries: { type: 'integer' }, broken_at: nullableString } }, 401: errorSchema, 429: errorSchema } },
  }, async (request) => services.verifyAuditLog(request.dashboardSession!.merchant));
  app.get<{ Params: { id: string } }>('/v1/public/invoices/:id', {
    schema: { tags: ['checkout'], summary: 'Read public payment details for checkout', security: [], params: idParams, response: { 200: publicInvoiceSchema, 404: errorSchema, 429: errorSchema } },
  }, async (request, reply) => {
    const invoice = await services.getPublicInvoice(request.params.id);
    reply.header('cache-control', 'no-store');
    return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });
  app.post<{ Params: { id: string }; Body: { asset: string; network: string } }>('/v1/public/invoices/:id/payment', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['checkout'], summary: 'Choose the coin and network for an invoice; locks the quote and assigns the address', security: [], params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['asset', 'network'], properties: { asset: { type: 'string', minLength: 2, maxLength: 16 }, network: { type: 'string', minLength: 2, maxLength: 48 } } },
      response: { 200: publicInvoiceSchema, 400: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 429: errorSchema },
    },
  }, async (request, reply) => {
    const invoice = await services.selectPublicPayment(request.params.id, request.body.asset, request.body.network);
    return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });
  app.post<{ Params: { id: string } }>('/v1/public/invoices/:id/cancel', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['checkout'], summary: 'Cancel an unpaid checkout invoice', security: [], params: idParams, response: { 200: publicInvoiceSchema, 404: errorSchema, 409: errorSchema, 429: errorSchema } },
  }, async (request, reply) => {
    const invoice = await services.cancelPublicInvoice(request.params.id);
    return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });

  app.post<{ Body: CreateInvoiceInput }>('/v1/invoices', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['invoices'], summary: 'Create an invoice', security: [{ bearerAuth: [] }],
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 } } },
      body: createBody, response: { ...invoiceResponse, 201: invoiceSchema },
    },
  }, async (request, reply) => {
    const invoice = await services.createInvoice(request.merchant!, request.headers['idempotency-key'] as string, request.body);
    return reply.code(201).send(invoice);
  });

  app.get<{ Params: { id: string } }>('/v1/invoices/:id', { schema: { tags: ['invoices'], summary: 'Get invoice details', params: idParams, response: invoiceResponse } }, async (request, reply) => {
    const invoice = await services.getInvoice(request.merchant!, request.params.id);
    return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });

  app.get<{ Params: { id: string } }>('/v1/invoices/:id/payments', {
    schema: { tags: ['invoices'], summary: 'List on-chain transfers matched to an invoice', params: idParams, response: { 200: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { transaction_id: { type: 'string' }, asset: { type: 'string' }, amount: { type: 'string' }, confirmations: { type: 'string' }, block_number: nullableString, observed_at: { type: 'string', format: 'date-time' } } } }, 401: errorSchema, 404: errorSchema } },
  }, async (request, reply) => {
    const detail = await services.getInvoiceDetail(request.merchant!, request.params.id);
    return detail ? reply.send(detail.payments) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });

  app.get<{ Querystring: ListQuerystring }>('/v1/invoices', {
    schema: {
      tags: ['invoices'], summary: 'List invoices',
      querystring: listQuery,
      response: { 200: { type: 'object', required: ['data', 'next_cursor'], properties: { data: { type: 'array', items: invoiceSchema }, next_cursor: nullableString } }, 400: errorSchema, 401: errorSchema, 429: errorSchema },
    },
  }, async (request) => services.listInvoices(request.merchant!, listQueryFrom(request.query)));

  app.post<{ Params: { id: string } }>('/v1/invoices/:id/cancel', { schema: { tags: ['invoices'], summary: 'Cancel an unpaid invoice', params: idParams, response: invoiceResponse } }, async (request, reply) => {
    const invoice = await services.cancelInvoice(request.merchant!, request.params.id);
    return invoice ? reply.send(invoice) : fail(reply, 404, 'invoice_not_found', 'Invoice not found.');
  });

  app.get('/v1/assets', { schema: { tags: ['account'], summary: 'List the asset catalog and which assets can be invoiced', response: { 200: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['asset', 'network', 'enabled', 'available'], properties: { asset: { type: 'string' }, network: { type: 'string' }, name: { type: 'string' }, network_name: { type: 'string' }, decimals: { type: 'integer' }, contract: nullableString, wallet_asset: { type: 'string' }, family: { type: 'string' }, address_mode: { type: 'string' }, enabled: { type: 'boolean' }, available: { type: 'boolean' } } } } } } }, async (request) => services.getAssets(request.merchant!));
  app.get('/v1/account', { schema: { tags: ['account'], summary: 'Get merchant settings', response: { 200: { type: 'object', additionalProperties: true } } } }, async (request) => services.getAccount(request.merchant!));

  app.put<{ Body: { wallets: WalletInput[] } }>('/v1/account/wallets', {
    schema: {
      tags: ['account'], summary: 'Set public wallet configuration',
      body: walletsBody,
      response: { 200: { type: 'object', additionalProperties: true }, 400: errorSchema, 401: errorSchema, 409: errorSchema, 422: errorSchema },
    },
  }, async (request) => services.updateWallets(request.merchant!, request.body.wallets));

  app.put<{ Body: { url: string | null; rotate_secret?: boolean } }>('/v1/account/webhook', {
    schema: {
      tags: ['account'], summary: 'Set the webhook endpoint or rotate its signing secret',
      body: webhookBody,
      response: { 200: { type: 'object', required: ['webhook_url'], properties: { webhook_url: nullableString, signing_secret: { type: 'string' } } }, 400: errorSchema, 401: errorSchema, 422: errorSchema, 500: errorSchema },
    },
  }, async (request) => services.setWebhook(request.merchant!, request.body.url, request.body.rotate_secret ?? false));

  app.post('/v1/webhooks/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags: ['webhooks'], summary: 'Send a test webhook', response: { 200: { type: 'object', required: ['accepted'], properties: { accepted: { type: 'boolean' } } }, 401: errorSchema, 422: errorSchema, 429: errorSchema, 500: errorSchema } } }, async (request) => services.sendTestWebhook(request.merchant!));

  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  return app;
}
