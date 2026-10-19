import '../env.js';
import { hash, Algorithm } from '@node-rs/argon2';
import { createDatabasePool } from '../db/pool.js';

const [merchantId, emailInput] = process.argv.slice(2);
const password = process.env.DASHBOARD_USER_PASSWORD;
const email = emailInput?.trim().toLowerCase();
if (!merchantId || !/^[0-9a-f-]{36}$/i.test(merchantId) || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
  process.stderr.write('Usage: DASHBOARD_USER_PASSWORD="..." npm run dashboard:user:create --workspace apps/api -- <merchant-uuid> <email>\n');
  process.exitCode = 2;
} else if (!password || password.length < 12 || password.length > 1024) {
  process.stderr.write('DASHBOARD_USER_PASSWORD must contain between 12 and 1024 characters.\n');
  process.exitCode = 2;
} else {
  const pool = createDatabasePool();
  try {
    const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });
    await pool.query('INSERT INTO merchant_users (merchant_id, email, password_hash) VALUES ($1, $2, $3)', [merchantId, email, passwordHash]);
    process.stdout.write(`Dashboard user created for ${email}.\n`);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    process.stderr.write(code === '23505'
      ? 'A dashboard user already exists with that email.\n'
      : 'Could not create dashboard user. Check the merchant ID and database.\n');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
