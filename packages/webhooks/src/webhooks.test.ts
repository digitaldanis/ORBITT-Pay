import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, signWebhook, verifyWebhookSignature } from './index.js';

const key = Buffer.alloc(32, 7).toString('base64');

describe('webhook signing', () => {
  it('signs exact body bytes and enforces timestamp replay protection', () => {
    const body = '{"event":"invoice.paid"}';
    const signed = signWebhook('merchant-secret', body, { timestamp: 1_800_000_000 });
    expect(verifyWebhookSignature('merchant-secret', body, signed.header, { now: signed.timestamp })).toBe(true);
    expect(verifyWebhookSignature('merchant-secret', `${body} `, signed.header, { now: signed.timestamp })).toBe(false);
    expect(verifyWebhookSignature('merchant-secret', body, signed.header, { now: signed.timestamp + 301 })).toBe(false);
    expect(verifyWebhookSignature('wrong-secret', body, signed.header, { now: signed.timestamp })).toBe(false);
  });

  it('encrypts secrets at rest with authenticated encryption', () => {
    const encrypted = encryptSecret('whsec_do_not_store_in_plaintext', key);
    expect(encrypted).not.toContain('whsec_do_not_store_in_plaintext');
    expect(decryptSecret(encrypted, key)).toBe('whsec_do_not_store_in_plaintext');
    expect(() => decryptSecret(encrypted, Buffer.alloc(32, 8).toString('base64'))).toThrow();
  });
});
