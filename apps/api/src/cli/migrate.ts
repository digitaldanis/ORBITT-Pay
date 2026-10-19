import '../env.js';
import { createDatabasePool } from '../db/pool.js';
import { migrateDatabase } from '../db/migrate.js';

const pool = createDatabasePool();
try {
  const applied = await migrateDatabase(pool);
  process.stdout.write(applied.length ? `Applied: ${applied.join(', ')}\n` : 'Database is up to date.\n');
} catch (error) {
  process.stderr.write(`Database migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
