export interface RateQuery {
  asset: string;
  fiatCurrency: string;
}

export interface ProviderRate extends RateQuery {
  /** Fiat major units for one whole crypto unit, represented without floats. */
  rate: string;
  source: string;
  timestamp: Date;
}

export interface RateQuote extends ProviderRate {
  fetchedAt: Date;
  stale: boolean;
}

export interface RateProvider {
  readonly name: string;
  getRate(query: RateQuery): Promise<ProviderRate | null>;
}

export interface AssetRateConfig {
  coingeckoId?: string;
  krakenPairs?: Partial<Record<'EUR' | 'USD', string>>;
}

export type RateAssetConfig = Readonly<Record<string, AssetRateConfig>>;
