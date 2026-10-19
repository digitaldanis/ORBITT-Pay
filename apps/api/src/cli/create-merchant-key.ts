import '../env.js';
import { createApiKey } from '../auth/api-key.js';
import { createDatabasePool } from '../db/pool.js';

const merchantName = process.argv.slice(2).join(' ').trim();
if (!merchantName || merchantName.length > 160) {
  process.stderr.write('Usage: npm run api-key:create -- "Merchant name"\n');
  process.exitCode = 2;
} else {
  const pool = createDatabasePool();
  try {
    const key = createApiKey();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const merchant = await client.query<{ id: string }>('INSERT INTO merchants (name) VALUES ($1) RETURNING id', [merchantName]);
      await client.query('INSERT INTO api_keys (merchant_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4)', [merchant.rows[0]!.id, 'Initial live key', key.hash, key.prefix]);
      await client.query('COMMIT');
      process.stdout.write(`Merchant: ${merchant.rows[0]!.id}\nAPI key (shown once): ${key.secret}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    process.stderr.write(`Could not create merchant API key: ${error instanceof Error ? error.message : 'database error'}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
