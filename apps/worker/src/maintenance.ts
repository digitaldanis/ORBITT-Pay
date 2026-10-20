import type { Pool } from 'pg';
import type { ScannerLogger } from './chain-scanner.js';

const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

/** Hourly housekeeping: drops rows that no longer serve any purpose so tables stay small. */
export class Maintenance {
  private nextRunAt = 0;

  constructor(private readonly pool: Pool, private readonly log: ScannerLogger = { info: () => undefined, warn: () => undefined }) {}

  async runOnce(now = Date.now()): Promise<boolean> {
    if (now < this.nextRunAt) return false;
    this.nextRunAt = now + MAINTENANCE_INTERVAL_MS;
    const idempotency = await this.pool.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
    // Expired and revoked sessions are kept for a week so recent sign-ins can still be reviewed.
    const sessions = await this.pool.query(
      `DELETE FROM dashboard_sessions WHERE expires_at < now() - interval '7 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
    );
    const removed = { idempotency_keys: idempotency.rowCount ?? 0, dashboard_sessions: sessions.rowCount ?? 0 };
    if (removed.idempotency_keys || removed.dashboard_sessions) this.log.info('maintenance removed expired rows', removed);
    return false;
  }
}
