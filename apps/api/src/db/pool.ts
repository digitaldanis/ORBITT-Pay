import { Pool } from 'pg';

export function createDatabasePool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}
