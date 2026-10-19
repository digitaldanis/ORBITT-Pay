import { describe, expect, it } from 'vitest';
import { CoinGeckoProvider } from './coingecko.js';
import { KrakenProvider } from './kraken.js';

const now = new Date('2026-01-01T00:00:00.000Z');

describe('rate providers', () => {
  it('reads CoinGecko decimal prices and source timestamps', async () => {
    let requested: URL | undefined;
    const provider = new CoinGeckoProvider({
      assets: { BTC: { coingeckoId: 'bitcoin' } },
      now: () => now,
      fetcher: async (url) => {
        requested = new URL(url);
        return new Response(JSON.stringify({ bitcoin: { eur: 61234.5, last_updated_at: 1767225600 } }));
      },
    });
    const quote = await provider.getRate({ asset: 'BTC', fiatCurrency: 'EUR' });
    expect(quote?.rate).toBe('61234.5');
    expect(quote?.timestamp).toEqual(now);
    expect(requested?.searchParams.get('include_last_updated_at')).toBe('true');
  });

  it('reads the Kraken last-trade string for the configured fiat pair', async () => {
    let requested: URL | undefined;
    const provider = new KrakenProvider({
      assets: { BTC: { krakenPairs: { USD: 'XBTUSD' } } },
      now: () => now,
      fetcher: async (url) => {
        requested = new URL(url);
        return new Response(JSON.stringify({ error: [], result: { XXBTZUSD: { c: ['61234.50', '0.01'] } } }));
      },
    });
    const quote = await provider.getRate({ asset: 'BTC', fiatCurrency: 'USD' });
    expect(quote?.rate).toBe('61234.50');
    expect(quote?.source).toBe('kraken');
    expect(requested?.searchParams.get('pair')).toBe('XBTUSD');
    expect(await provider.getRate({ asset: 'BTC', fiatCurrency: 'EUR' })).toBeNull();
  });
});
