import '../env.js';
import { createDatabasePool } from '../db/pool.js';

/** Checks the audit log hash chain of every merchant, or of one: `npm run audit:verify -- [merchant-uuid]`. */
const [merchantId] = process.argv.slice(2);
if (merchantId && !/^[0-9a-f-]{36}$/i.test(merchantId)) {
  process.stderr.write('Usage: npm run audit:verify --workspace apps/api -- [merchant-uuid]\n');
  process.exitCode = 2;
} else {
  const pool = createDatabasePool();
  try {
    const result = await pool.query<{ id: string; name: string; entries: number; broken_at: string | null }>(
      `SELECT m.id, m.name, (SELECT count(*)::int FROM audit_log a WHERE a.merchant_id = m.id) AS entries,
         orbitt_verify_audit_log(m.id)::text AS broken_at
       FROM merchants m WHERE $1::uuid IS NULL OR m.id = $1 ORDER BY m.created_at`, [merchantId ?? null],
    );
    for (const row of result.rows) {
      process.stdout.write(row.broken_at
        ? `BROKEN  ${row.id} ${row.name}: entry ${row.broken_at} does not match its hash or link\n`
        : `OK      ${row.id} ${row.name}: ${row.entries} entries\n`);
    }
    if (result.rows.some((row) => row.broken_at)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
