import type { ProviderRate, RateAssetConfig, RateQuery, RateProvider } from '../types.js';
import { createRequestUrl, getJson, isRecord, positiveRate, type FetchLike } from './http.js';

export interface KrakenOptions {
  assets: RateAssetConfig;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: FetchLike;
  now?: () => Date;
}

export class KrakenProvider implements RateProvider {
  readonly name = 'kraken';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly options: KrakenOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.kraken.com/0/public/Ticker';
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getRate(query: RateQuery): Promise<ProviderRate | null> {
    const fiatCurrency = query.fiatCurrency.toUpperCase();
    if (fiatCurrency !== 'EUR' && fiatCurrency !== 'USD') return null;
    const pair = this.options.assets[query.asset]?.krakenPairs?.[fiatCurrency];
    if (!pair) return null;
    const body = await getJson(createRequestUrl(this.baseUrl, { pair }), this.fetcher, this.timeoutMs);
    if (!isRecord(body)) throw new Error('Kraken response is invalid');
    if (Array.isArray(body.error) && body.error.length > 0) throw new Error('Kraken returned a provider error');
    if (!isRecord(body.result)) throw new Error('Kraken response is missing ticker data');
    const ticker = Object.values(body.result).find((value) => isRecord(value) && Array.isArray(value.c));
    if (!isRecord(ticker) || !Array.isArray(ticker.c)) throw new Error('Kraken response is missing the last trade price');
    const rate = positiveRate(ticker.c[0]);
    if (!rate) throw new Error('Kraken response contains an invalid rate');
    return {
      asset: query.asset,
      fiatCurrency,
      rate,
      source: this.name,
      timestamp: this.now(),
    };
  }
}
