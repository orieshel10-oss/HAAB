const bcrypt = require('bcryptjs');
const { TOTP, Secret } = require('otpauth');
const { pool } = require('./db');

const BCRYPT_ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function generateTotpSecret() {
  return new Secret({ size: 20 }).base32;
}

function totpEnrollUri(secret, label) {
  const totp = new TOTP({ issuer: 'HAAB', label, secret, algorithm: 'SHA1', digits: 6, period: 30 });
  return totp.toString();
}

function verifyTotpCode(secret, code) {
  const totp = new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 });
  // allow the previous/next 30s window too, for clock drift between phone and server
  return totp.validate({ token: String(code || ''), window: 1 }) !== null;
}

function requireSystemAdmin(req, res, next) {
  if (!req.session || !req.session.systemAdminId) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  next();
}

// Standard Israeli ID (ת.ז.) check-digit algorithm: pad to 9 digits, alternately weight each
// digit by 1/2 from the left, digit-sum any product >= 10, valid iff the total is divisible by 10.
function isValidIsraeliId(id) {
  const clean = String(id || '').trim();
  if (!/^\d{1,9}$/.test(clean)) return false;
  const padded = clean.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = Number(padded[i]) * ((i % 2) + 1);
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

// Resolves which org (and, for a Time Admin, which sub-orgs) the current session may act on -
// covers three distinct session shapes (System Admin who has "entered" an org, Org Admin,
// Time Admin) behind one interface so employee/time-admin routes are written once.
async function resolveOrgContext(req, res, next) {
  try {
    if (req.session && req.session.systemAdminId && req.session.enteredOrgId) {
      req.orgContext = { orgId: req.session.enteredOrgId, role: 'system_admin', subOrgRestriction: null };
      return next();
    }
    if (req.session && req.session.orgAdminId) {
      const { rows } = await pool.query('SELECT org_id, admin_type FROM org_admins WHERE id = $1', [req.session.orgAdminId]);
      const admin = rows[0];
      if (!admin) return res.status(401).json({ error: 'not authenticated' });
      if (admin.admin_type === 'time_admin') {
        const subRows = await pool.query(
          'SELECT sub_org_id FROM org_admin_sub_orgs WHERE org_admin_id = $1',
          [req.session.orgAdminId]
        );
        req.orgContext = { orgId: admin.org_id, role: 'time_admin', subOrgRestriction: subRows.rows.map((r) => r.sub_org_id) };
      } else {
        req.orgContext = { orgId: admin.org_id, role: 'org_admin', subOrgRestriction: null };
      }
      return next();
    }
    return res.status(401).json({ error: 'not authenticated' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  totpEnrollUri,
  verifyTotpCode,
  requireSystemAdmin,
  isValidIsraeliId,
  resolveOrgContext
};
