import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureOptions {
  timestamp?: number;
}

export function signWebhook(secret: string, body: string | Uint8Array, options: SignatureOptions = {}): { timestamp: number; signature: string; header: string } {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new RangeError('timestamp must be a positive integer');
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return { timestamp, signature, header: `t=${timestamp},v1=${signature}` };
}

export function verifyWebhookSignature(
  secret: string,
  body: string | Uint8Array,
  header: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  const timestampMatch = /(?:^|,)\s*t=(\d+)(?:,|$)/.exec(header);
  const timestamp = timestampMatch ? Number(timestampMatch[1]) : NaN;
  if (!Number.isSafeInteger(timestamp)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0 || Math.abs(now - timestamp) > toleranceSeconds) return false;
  const signatures = [...header.matchAll(/(?:^|,)\s*v1=([a-f0-9]{64})(?=,|$)/gi)].map((match) => match[1]!);
  const expected = Buffer.from(signWebhook(secret, body, { timestamp }).signature, 'hex');
  return signatures.some((candidate) => {
    const provided = Buffer.from(candidate, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}
