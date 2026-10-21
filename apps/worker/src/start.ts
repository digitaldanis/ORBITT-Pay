import './env.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { parseAssetCatalog } from '@orbitt/core';
import { WebhookWorker } from './webhook-worker.js';
import { ChainScanner, type ScannerLogger } from './chain-scanner.js';
import { Maintenance } from './maintenance.js';

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.APP_ENCRYPTION_KEY;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!encryptionKey) throw new Error('APP_ENCRYPTION_KEY is required');

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const assetsPath = process.env.ORBITT_ASSETS_FILE ? resolve(process.env.ORBITT_ASSETS_FILE) : resolve(repoRoot, 'config/assets.json');
const catalog = parseAssetCatalog(JSON.parse(await readFile(assetsPath, 'utf8')));

const log: ScannerLogger = {
  info: (message, fields) => process.stdout.write(`${JSON.stringify({ level: 'info', time: new Date().toISOString(), message, ...fields })}\n`),
  warn: (message, fields) => process.stderr.write(`${JSON.stringify({ level: 'warn', time: new Date().toISOString(), message, ...fields })}\n`),
};

const pool = new Pool({
  connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000, application_name: 'orbitt-worker',
});
const webhooks = new WebhookWorker(pool, encryptionKey);
const scanner = new ChainScanner(pool, catalog, process.env, log);
const maintenance = new Maintenance(pool, log);
const stopping = new AbortController();
process.once('SIGINT', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());

const pause = (ms: number) => new Promise<void>((resolveSleep) => {
  const timer = setTimeout(() => { stopping.signal.removeEventListener('abort', onAbort); resolveSleep(); }, ms);
  const onAbort = () => { clearTimeout(timer); resolveSleep(); };
  stopping.signal.addEventListener('abort', onAbort, { once: true });
});

/** Runs a loop until shutdown; a failing iteration is logged and retried after a pause. */
async function loop(name: string, iteration: () => Promise<boolean>): Promise<void> {
  while (!stopping.signal.aborted) {
    try {
      if (!await iteration()) await pause(1_000);
    } catch (error) {
      log.warn(`${name} iteration failed`, { error: error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[url]') : 'unknown error' });
      await pause(5_000);
    }
  }
}

await pool.query('SELECT 1');
log.info('ORBITT PAY worker started', { assets: catalog.filter((asset) => asset.enabled).length });
// Separate loops so slow chain providers never delay webhook delivery.
await Promise.all([
  loop('chain scanner', () => scanner.runOnce()),
  loop('webhook delivery', () => webhooks.runOnce()),
  loop('maintenance', () => maintenance.runOnce()),
]);
await pool.end();
