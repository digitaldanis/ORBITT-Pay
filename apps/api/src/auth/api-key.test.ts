import { describe, expect, it } from 'vitest';
import { createApiKey, hashApiKey, readBearerToken } from './api-key.js';

describe('API key handling', () => {
  it('creates a 256-bit bearer secret and stores only a one-way hash', () => {
    const first = createApiKey();
    const second = createApiKey();
    expect(first.secret).toMatch(/^ob_live_[A-Za-z0-9_-]{43}$/);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hash).toBe(hashApiKey(first.secret));
    expect(first.hash).not.toBe(first.secret);
    expect(first.secret).not.toBe(second.secret);
    expect(readBearerToken(`Bearer ${first.secret}`)).toBe(first.secret);
  });

  it('rejects malformed authorization values', () => {
    expect(readBearerToken('Basic abc')).toBeUndefined();
    expect(readBearerToken('Bearer short')).toBeUndefined();
  });
});
