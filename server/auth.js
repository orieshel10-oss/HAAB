const bcrypt = require('bcryptjs');
const { TOTP, Secret } = require('otpauth');

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

module.exports = {
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  totpEnrollUri,
  verifyTotpCode,
  requireSystemAdmin
};
