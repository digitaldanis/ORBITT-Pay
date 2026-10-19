export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function createRequestUrl(baseUrl: string, params: Record<string, string>): URL {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export async function getJson(url: URL, fetcher: FetchLike, timeoutMs: number): Promise<unknown> {
  const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Rate provider returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function positiveRate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const rate = String(value);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rate)) return null;
  return rate;
}

export function providerTimestamp(seconds: unknown, fallback: Date): Date {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  const timestamp = new Date(seconds * 1000);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp;
}
