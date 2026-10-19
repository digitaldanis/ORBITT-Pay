# Exchange rates

Authorship: W-Digital (hallo@w-digital.eu)

The rates package returns fiat major units per one whole crypto unit as decimal strings. Quote conversion and rounding happen in `@orbitt/core`; amounts are rounded upward to base units there.

Two public sources are configured: CoinGecko Simple Price first and Kraken's public ticker second. The asset-to-provider identifiers live in [`packages/rates/config/assets.json`](../packages/rates/config/assets.json), so unsupported pairs can fall back to CoinGecko without code changes.

Rates are cached for 20 seconds by default. A provider result older than 120 seconds is rejected; when both sources fail, an already cached quote can be returned as stale only until that same maximum age. The API should preserve the source and rate timestamp on each invoice so the locked quote can be audited.

The defaults can be tuned when the application wires provider construction. Provider failures are not logged with request URLs or response bodies; callers receive a single rate-unavailable error if neither a current nor acceptable stale quote exists.
