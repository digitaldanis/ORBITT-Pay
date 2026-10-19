import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'ob_live_';

export function createApiKey(): { secret: string; hash: string; prefix: string } {
  const secret = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, hash: hashApiKey(secret), prefix: secret.slice(0, 16) };
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{32,80})$/.exec(header);
  return match?.[1];
}
