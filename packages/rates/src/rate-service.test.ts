import { describe, expect, it } from 'vitest';
import { RateService, RateUnavailableError } from './rate-service.js';
import type { ProviderRate, RateProvider } from './types.js';

const query = { asset: 'BTC', fiatCurrency: 'EUR' };

function provider(name: string, getRate: RateProvider['getRate']): RateProvider {
  return { name, getRate };
}

describe('RateService', () => {
  it('uses provider fallback and shares the fresh cached quote', async () => {
    let calls = 0;
    const now = new Date('2026-01-01T00:00:00.000Z');
    const failing = provider('primary', async () => { calls += 1; throw new Error('offline'); });
    const backup = provider('backup', async (): Promise<ProviderRate> => {
      calls += 1;
      return { ...query, rate: '61234.50', source: 'backup', timestamp: now };
    });
    const service = new RateService({ providers: [failing, backup], now: () => now });

    const first = await service.getRate(query);
    const second = await service.getRate(query);
    expect(first.rate).toBe('61234.50');
    expect(first.stale).toBe(false);
    expect(second).toBe(first);
    expect(calls).toBe(2);
  });

  it('uses a cached quote only within the configured maximum age', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    let available = true;
    const source = provider('source', async (): Promise<ProviderRate | null> => available
      ? { ...query, rate: '60000', source: 'source', timestamp: new Date('2026-01-01T00:00:00.000Z') }
      : null);
    const service = new RateService({ providers: [source], freshForMs: 10, maxAgeMs: 100, now: () => now });
    await service.getRate(query);
    available = false;
    now = new Date('2026-01-01T00:00:00.050Z');
    expect((await service.getRate(query)).stale).toBe(true);
    now = new Date('2026-01-01T00:00:00.101Z');
    await expect(service.getRate(query)).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it('coalesces concurrent requests for the same quote', async () => {
    let calls = 0;
    const source = provider('source', async (): Promise<ProviderRate> => {
      calls += 1;
      await Promise.resolve();
      return { ...query, rate: '60000', source: 'source', timestamp: new Date() };
    });
    const service = new RateService({ providers: [source] });
    await Promise.all([service.getRate(query), service.getRate(query)]);
    expect(calls).toBe(1);
  });
});
