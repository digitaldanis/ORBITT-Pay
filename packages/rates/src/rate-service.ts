import { Decimal } from 'decimal.js';
import type { ProviderRate, RateProvider, RateQuote, RateQuery } from './types.js';

export class RateUnavailableError extends Error {
  constructor(query: RateQuery) {
    super(`No fresh exchange rate is available for ${query.asset}/${query.fiatCurrency}`);
    this.name = 'RateUnavailableError';
  }
}

export interface RateServiceOptions {
  providers: readonly RateProvider[];
  freshForMs?: number;
  maxAgeMs?: number;
  now?: () => Date;
}

function cacheKey(query: RateQuery): string {
  return `${query.asset.toUpperCase()}:${query.fiatCurrency.toUpperCase()}`;
}

function isValidRate(rate: ProviderRate): boolean {
  try {
    return new Decimal(rate.rate).isFinite() && new Decimal(rate.rate).gt(0)
      && !Number.isNaN(rate.timestamp.getTime());
  } catch {
    return false;
  }
}

export class RateService {
  private readonly cache = new Map<string, RateQuote>();
  private readonly inFlight = new Map<string, Promise<RateQuote>>();
  private readonly freshForMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: RateServiceOptions) {
    this.freshForMs = options.freshForMs ?? 20_000;
    this.maxAgeMs = options.maxAgeMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
    if (this.freshForMs < 0 || this.maxAgeMs < this.freshForMs) {
      throw new RangeError('maxAgeMs must be at least freshForMs, and both must be non-negative');
    }
  }

  async getRate(query: RateQuery): Promise<RateQuote> {
    const normalized: RateQuery = {
      asset: query.asset.trim().toUpperCase(),
      fiatCurrency: query.fiatCurrency.trim().toUpperCase(),
    };
    if (!normalized.asset || !/^[A-Z]{3}$/.test(normalized.fiatCurrency)) {
      throw new TypeError('asset and ISO currency code are required');
    }
    const key = cacheKey(normalized);
    const cached = this.cache.get(key);
    const now = this.now();
    if (cached && now.getTime() - cached.timestamp.getTime() <= this.freshForMs) return cached;

    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.fetchRate(normalized, cached).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async fetchRate(query: RateQuery, cached?: RateQuote): Promise<RateQuote> {
    for (const provider of this.options.providers) {
      let rate: ProviderRate | null;
      try {
        rate = await provider.getRate(query);
      } catch {
        continue;
      }
      if (!rate || !isValidRate(rate)) continue;
      const ageMs = this.now().getTime() - rate.timestamp.getTime();
      if (ageMs < -300_000 || ageMs > this.maxAgeMs) continue;
      const quote: RateQuote = { ...rate, fetchedAt: this.now(), stale: false };
      this.cache.set(cacheKey(query), quote);
      return quote;
    }

    if (cached && this.now().getTime() - cached.timestamp.getTime() <= this.maxAgeMs) {
      const staleQuote: RateQuote = { ...cached, stale: true };
      this.cache.set(cacheKey(query), staleQuote);
      return staleQuote;
    }
    throw new RateUnavailableError(query);
  }
}
