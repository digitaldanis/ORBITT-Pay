import './env.js';
import { Pool } from 'pg';
import { WebhookWorker } from './webhook-worker.js';

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.APP_ENCRYPTION_KEY;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!encryptionKey) throw new Error('APP_ENCRYPTION_KEY is required');

const pool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
const worker = new WebhookWorker(pool, encryptionKey);
const stopping = new AbortController();
process.once('SIGINT', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());

await pool.query('SELECT 1');
process.stdout.write('ORBITT PAY webhook worker started.\n');
while (!stopping.signal.aborted) {
  try {
    const didWork = await worker.runOnce();
    if (!didWork) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { stopping.signal.removeEventListener('abort', onAbort); resolve(); }, 1_000);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      stopping.signal.addEventListener('abort', onAbort, { once: true });
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    process.stderr.write(`Webhook worker iteration failed (${errorName}).\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
await pool.end();
