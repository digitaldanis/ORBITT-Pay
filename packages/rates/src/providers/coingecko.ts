import type { ProviderRate, RateAssetConfig, RateQuery, RateProvider } from '../types.js';
import { createRequestUrl, getJson, isRecord, positiveRate, providerTimestamp, type FetchLike } from './http.js';

export interface CoinGeckoOptions {
  assets: RateAssetConfig;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: FetchLike;
  now?: () => Date;
}

export class CoinGeckoProvider implements RateProvider {
  readonly name = 'coingecko';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly options: CoinGeckoOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.coingecko.com/api/v3/simple/price';
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getRate(query: RateQuery): Promise<ProviderRate | null> {
    const coinId = this.options.assets[query.asset]?.coingeckoId;
    if (!coinId) return null;
    const fiat = query.fiatCurrency.toLowerCase();
    const url = createRequestUrl(this.baseUrl, {
      ids: coinId,
      vs_currencies: fiat,
      include_last_updated_at: 'true',
    });
    const body = await getJson(url, this.fetcher, this.timeoutMs);
    if (!isRecord(body) || !isRecord(body[coinId])) throw new Error('CoinGecko response is missing the requested asset');
    const assetData = body[coinId];
    const rate = positiveRate(assetData[fiat]);
    if (!rate) throw new Error('CoinGecko response contains an invalid rate');
    return {
      asset: query.asset,
      fiatCurrency: query.fiatCurrency.toUpperCase(),
      rate,
      source: this.name,
      timestamp: providerTimestamp(assetData.last_updated_at, this.now()),
    };
  }
}
