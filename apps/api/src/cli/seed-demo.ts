import '../env.js';
import { hash, Algorithm } from '@node-rs/argon2';
import { createApiKey } from '../auth/api-key.js';
import { createDatabasePool } from '../db/pool.js';
import { migrateDatabase } from '../db/migrate.js';

/**
 * Creates a demo merchant with public test wallets so the dashboard and checkout can be tried
 * locally. The keys are the published BIP39 test vectors; never send real funds to them.
 */
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('The demo seed is for local development only.\n');
  process.exit(2);
}

const email = (process.argv[2] ?? 'demo@orbitt.local').toLowerCase();
const password = process.env.DASHBOARD_USER_PASSWORD ?? 'orbitt-demo-password';
const pool = createDatabasePool();
try {
  await migrateDatabase(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const merchant = await client.query<{ id: string }>("INSERT INTO merchants (name) VALUES ('Nebula Coffee Roasters') RETURNING id");
    const merchantId = merchant.rows[0]!.id;
    const key = createApiKey();
    await client.query('INSERT INTO api_keys (merchant_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4)', [merchantId, 'Demo key', key.hash, key.prefix]);
    await client.query('INSERT INTO merchant_users (merchant_id, email, password_hash) VALUES ($1, $2, $3)', [
      merchantId, email, await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 }),
    ]);
    const wallets: Array<[string, string, string | null, string | null]> = [
      ['BTC', 'bitcoin', 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs', null],
      ['ETH', 'ethereum', 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt', null],
      ['ETH', 'base', 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt', null],
      ['TRX', 'tron', 'xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd', null],
      ['SOL', 'solana', null, 'J6SzzpZHZbq38N46r63NmTkFB4MtasHGicvp83pf9WkF'],
    ];
    for (const [asset, network, xpub, address] of wallets) {
      await client.query('INSERT INTO merchant_wallets (merchant_id, asset, network, extended_public_key, address) VALUES ($1, $2, $3, $4, $5)', [merchantId, asset, network, xpub, address]);
    }
    await client.query('COMMIT');
    process.stdout.write(`Demo merchant: ${merchantId}\nDashboard login: ${email} / ${password}\nAPI key (shown once): ${key.secret}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
