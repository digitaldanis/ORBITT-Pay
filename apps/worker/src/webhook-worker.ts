import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Pool } from 'pg';
import { decryptSecret, signWebhook } from '@orbitt/webhooks';

interface Delivery {
  id: string;
  event_type: string;
  target_url: string;
  secret_ciphertext: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface AttemptResult {
  httpStatus: number | null;
  responseExcerpt: string | null;
  error: string | null;
  permanent: boolean;
}

const RETRY_DELAYS_SECONDS = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 12 * 60 * 60] as const;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0))
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
}

/** Local development only: lets webhooks reach a shop running on localhost or a private network. */
function allowPrivateTargets(): boolean {
  return process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === 'true' && process.env.NODE_ENV !== 'production';
}

async function validateTarget(target: string): Promise<void> {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_webhook_url');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('webhook_https_required');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateTargets() && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) throw new Error('private_webhook_target');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('private_webhook_target');
  if (allowPrivateTargets()) return;
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('private_webhook_target');
}

export class WebhookWorker {
  constructor(private readonly pool: Pool, private readonly encryptionKey: string) {}

  async runOnce(): Promise<boolean> {
    const delivery = await this.claim();
    if (!delivery) return false;
    const result = await this.deliver(delivery);
    await this.finish(delivery, result);
    return true;
  }

  private async claim(): Promise<Delivery | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<Delivery>(
        `SELECT id, event_type, target_url, secret_ciphertext, payload, attempts
         FROM webhook_deliveries
         WHERE (status = 'pending' AND next_attempt_at <= now())
            OR (status = 'processing' AND locked_until <= now())
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const delivery = found.rows[0];
      if (!delivery) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        `UPDATE webhook_deliveries SET status = 'processing', locked_until = now() + interval '30 seconds'
         WHERE id = $1`, [delivery.id],
      );
      await client.query('COMMIT');
      return delivery;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async deliver(delivery: Delivery): Promise<AttemptResult> {
    try {
      await validateTarget(delivery.target_url);
      const secret = decryptSecret(delivery.secret_ciphertext, this.encryptionKey);
      const body = JSON.stringify(delivery.payload);
      const signed = signWebhook(secret, body);
      const response = await fetch(delivery.target_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'ORBITT-Signature': signed.header,
          'ORBITT-Event': delivery.event_type,
          'ORBITT-Delivery': delivery.id,
        },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      await response.body?.cancel();
      return response.ok
        ? { httpStatus: response.status, responseExcerpt: null, error: null, permanent: false }
        : { httpStatus: response.status, responseExcerpt: null, error: `http_${response.status}`, permanent: false };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '';
      const message = ['invalid_webhook_url', 'webhook_https_required', 'private_webhook_target'].includes(rawMessage)
        ? rawMessage
        : error instanceof Error && error.name === 'TimeoutError' ? 'request_timeout' : 'delivery_request_failed';
      const permanent = ['invalid_webhook_url', 'webhook_https_required', 'private_webhook_target'].includes(message);
      return { httpStatus: null, responseExcerpt: null, error: message.slice(0, 512), permanent };
    }
  }

  private async finish(delivery: Delivery, result: AttemptResult): Promise<void> {
    const client = await this.pool.connect();
    const attemptNumber = delivery.attempts + 1;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO webhook_delivery_attempts (delivery_id, attempt_number, http_status, response_excerpt, error)
         VALUES ($1, $2, $3, $4, $5)`,
        [delivery.id, attemptNumber, result.httpStatus, result.responseExcerpt, result.error],
      );
      if (!result.error) {
        await client.query(
          `UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, locked_until = NULL,
           delivered_at = now(), last_http_status = $3, last_error = NULL WHERE id = $1`,
          [delivery.id, attemptNumber, result.httpStatus],
        );
      } else if (result.permanent || attemptNumber >= RETRY_DELAYS_SECONDS.length + 1) {
        await client.query(
          `UPDATE webhook_deliveries SET status = 'failed', attempts = $2, locked_until = NULL,
           last_http_status = $3, last_error = $4 WHERE id = $1`,
          [delivery.id, attemptNumber, result.httpStatus, result.error],
        );
      } else {
        const delay = RETRY_DELAYS_SECONDS[attemptNumber - 1]!;
        await client.query(
          `UPDATE webhook_deliveries SET status = 'pending', attempts = $2, locked_until = NULL,
           next_attempt_at = now() + ($3 * interval '1 second'), last_http_status = $4, last_error = $5 WHERE id = $1`,
          [delivery.id, attemptNumber, delay, result.httpStatus, result.error],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
