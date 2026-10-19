import '../env.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoinGeckoProvider, KrakenProvider, RateService, type RateAssetConfig } from '@orbitt/rates';
import { buildServer } from '../server.js';
import { createDatabasePool } from '../db/pool.js';
import { PostgresApiServices } from '../db/postgres-services.js';
import { parseAssetCatalog } from '@orbitt/core';
import { PostgresInvoicePreparer } from '../invoices/preparer.js';

const loadJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const assetsPath = process.env.ORBITT_ASSETS_FILE ? resolve(process.env.ORBITT_ASSETS_FILE) : resolve(repoRoot, 'config/assets.json');
const rateAssetsPath = process.env.ORBITT_RATE_ASSETS_FILE ? resolve(process.env.ORBITT_RATE_ASSETS_FILE) : resolve(repoRoot, 'packages/rates/config/assets.json');
const assets = parseAssetCatalog(await loadJson<unknown>(assetsPath));
const rateAssets = await loadJson<RateAssetConfig>(rateAssetsPath);
const rates = new RateService({ providers: [new CoinGeckoProvider({ assets: rateAssets }), new KrakenProvider({ assets: rateAssets })] });
const expiry = Number(process.env.INVOICE_EXPIRY_MINUTES ?? '15');
if (!Number.isInteger(expiry) || expiry < 1 || expiry > 60) throw new Error('INVOICE_EXPIRY_MINUTES must be an integer from 1 to 60');
const selection = Number(process.env.CHECKOUT_SELECTION_MINUTES ?? '60');
if (!Number.isInteger(selection) || selection < 5 || selection > 10_080) throw new Error('CHECKOUT_SELECTION_MINUTES must be an integer from 5 to 10080');

const pool = createDatabasePool();
const services = new PostgresApiServices(
  pool,
  new PostgresInvoicePreparer(assets, rates, {
    expiryMinutes: expiry,
    selectionMinutes: selection,
    requireLiveScanner: process.env.CHECKOUT_REQUIRE_LIVE_SCANNER !== 'false',
  }),
  assets,
);

const app = await buildServer(services);
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });
app.log.info({ port }, 'ORBITT PAY API started');

const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.once('SIGINT', () => { void shutdown().then(() => { process.exitCode = 0; }); });
process.once('SIGTERM', () => { void shutdown().then(() => { process.exitCode = 0; }); });
