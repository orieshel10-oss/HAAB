// Seeds the one permanent, undeletable System Admin row (Ori Eshel).
// This is intentionally NOT reachable through the app's own UI/API - it only runs with direct
// database access, which is the actual protection mechanism for this row (not just a permission
// check in application code).
//
// Usage:
//   ROOT_ADMIN_PASSWORD=yourpassword node scripts/seed-root-admin.js
require('dotenv').config();

const { pool, init } = require('../server/db');
const { hashPassword, generateTotpSecret, totpEnrollUri } = require('../server/auth');
const qrcode = require('qrcode');

const ROOT_EMAIL = 'orieshel10@gmail.com';
const ROOT_NAME = 'אורי אשל';
const ROOT_PHONE = '972-54-4576395';

async function main() {
  const password = process.env.ROOT_ADMIN_PASSWORD;
  if (!password) {
    console.error('Set ROOT_ADMIN_PASSWORD in the environment before running this script.');
    process.exit(1);
  }

  await init();

  const existing = await pool.query('SELECT id, totp_secret FROM system_admins WHERE is_root = true');
  if (existing.rows.length > 0) {
    console.log('Root system admin already exists (id=%d). Not creating a duplicate.', existing.rows[0].id);
    console.log('To reset the password or re-enroll TOTP, edit that row directly in the database.');
    await pool.end();
    return;
  }

  const passwordHash = await hashPassword(password);
  const totpSecret = generateTotpSecret();

  const { rows } = await pool.query(
    `INSERT INTO system_admins (email, name, phone, password_hash, totp_secret, is_root)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [ROOT_EMAIL, ROOT_NAME, ROOT_PHONE, passwordHash, totpSecret]
  );

  const uri = totpEnrollUri(totpSecret, `${ROOT_EMAIL} (System Admin - root)`);
  const qr = await qrcode.toString(uri, { type: 'terminal', small: true });

  console.log('Root system admin created: id=%d, email=%s', rows[0].id, ROOT_EMAIL);
  console.log('\nScan this QR code in Google Authenticator (or any TOTP app) now:\n');
  console.log(qr);
  console.log('If you cannot scan it, enter this key manually: %s', totpSecret);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
