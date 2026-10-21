import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export async function migrateDatabase(pool: Pool): Promise<string[]> {
  const migrationsDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/.test(file)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Migrations may backfill large tables; the pool's statement timeout is for request traffic.
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [725019432]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const existing = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const names = new Set(existing.rows.map((row) => row.name));
    for (const file of files) {
      if (names.has(file)) continue;
      const sql = await readFile(join(migrationsDirectory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [725019432]);
    client.release();
  }
  return applied;
}
