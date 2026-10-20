import { Pool } from 'pg';

export function createDatabasePool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({
    connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    // A stuck query or an abandoned transaction must never hold invoice row locks indefinitely.
    statement_timeout: 15_000, idle_in_transaction_session_timeout: 30_000, application_name: 'orbitt-api',
  });
}
