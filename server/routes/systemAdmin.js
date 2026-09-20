const express = require('express');
const { pool } = require('../db');
const {
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  totpEnrollUri,
  verifyTotpCode,
  requireSystemAdmin
} = require('../auth');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

const SUB_ORG_TYPES = ['factory_unit', 'division', 'department'];
const ADMIN_TYPES = ['org_admin', 'time_admin'];

/* ---------- auth ---------- */

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password, totp } = req.body || {};
  if (!email || !password || !totp) {
    return res.status(400).json({ error: 'email, password and totp are required' });
  }
  const { rows } = await pool.query('SELECT * FROM system_admins WHERE email = $1', [email]);
  const admin = rows[0];
  if (!admin || !(await verifyPassword(password, admin.password_hash))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (!verifyTotpCode(admin.totp_secret, totp)) {
    return res.status(401).json({ error: 'invalid authenticator code' });
  }
  req.session.systemAdminId = admin.id;
  req.session.systemAdminEmail = admin.email;
  delete req.session.enteredOrgId;
  res.json({ ok: true, admin: { id: admin.id, email: admin.email, name: admin.name, isRoot: admin.is_root } });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.use(requireSystemAdmin);

router.get('/me', (req, res) => {
  res.json({ id: req.session.systemAdminId, email: req.session.systemAdminEmail });
});

/* ---------- organizations ---------- */

router.get('/organizations', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, org_code, name, business_reg_number, tax_file_income, tax_file_bituach_leumi,
            contact_first_name, contact_last_name, contact_email, contact_mobile,
            payment_card_last4, payment_card_holder_name, created_at
     FROM organizations WHERE org_code IS NOT NULL ORDER BY created_at DESC`
  );
  res.json(rows);
}));

router.post('/organizations', asyncHandler(async (req, res) => {
  const {
    orgCode, name, businessRegNumber, taxFileIncome, taxFileBituachLeumi,
    contactFirstName, contactLastName, contactEmail, contactMobile,
    paymentCardLast4, paymentCardHolderName, entryPassword
  } = req.body || {};

  if (!/^\d{6}$/.test(orgCode || '')) {
    return res.status(400).json({ error: 'orgCode must be exactly 6 digits' });
  }
  if (!name || !entryPassword) {
    return res.status(400).json({ error: 'name and entryPassword are required' });
  }

  const entryPasswordHash = await hashPassword(entryPassword);
  try {
    const { rows } = await pool.query(
      `INSERT INTO organizations
         (name, org_code, business_reg_number, tax_file_income, tax_file_bituach_leumi,
          contact_first_name, contact_last_name, contact_email, contact_mobile,
          payment_card_last4, payment_card_holder_name, org_entry_password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, org_code, name`,
      [name, orgCode, businessRegNumber || null, taxFileIncome || null, taxFileBituachLeumi || null,
        contactFirstName || null, contactLastName || null, contactEmail || null, contactMobile || null,
        paymentCardLast4 || null, paymentCardHolderName || null, entryPasswordHash]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'org_code already exists' });
    throw err;
  }
}));

router.post('/organizations/:id/enter', asyncHandler(async (req, res) => {
  const orgId = Number(req.params.id);
  const { password } = req.body || {};
  const { rows } = await pool.query('SELECT org_entry_password_hash FROM organizations WHERE id = $1', [orgId]);
  if (!rows[0] || !(await verifyPassword(password || '', rows[0].org_entry_password_hash || ''))) {
    return res.status(401).json({ error: 'invalid organization password' });
  }
  req.session.enteredOrgId = orgId;
  res.json({ ok: true });
}));

/* ---------- sub-organizations ---------- */

router.get('/organizations/:id/sub-organizations', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, sub_org_code, name, sub_org_type, business_reg_number, created_at
     FROM sub_organizations WHERE org_id = $1 ORDER BY created_at DESC`,
    [Number(req.params.id)]
  );
  res.json(rows);
}));

router.post('/organizations/:id/sub-organizations', asyncHandler(async (req, res) => {
  const orgId = Number(req.params.id);
  const {
    subOrgCode, name, subOrgType, businessRegNumber, taxFileIncome, taxFileBituachLeumi,
    contactFirstName, contactLastName, contactEmail, contactMobile,
    paymentCardLast4, paymentCardHolderName
  } = req.body || {};

  if (!subOrgCode || !name) return res.status(400).json({ error: 'subOrgCode and name are required' });
  if (!SUB_ORG_TYPES.includes(subOrgType)) {
    return res.status(400).json({ error: `subOrgType must be one of ${SUB_ORG_TYPES.join(', ')}` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO sub_organizations
         (sub_org_code, org_id, name, sub_org_type, business_reg_number, tax_file_income, tax_file_bituach_leumi,
          contact_first_name, contact_last_name, contact_email, contact_mobile,
          payment_card_last4, payment_card_holder_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, sub_org_code, name, sub_org_type`,
      [subOrgCode, orgId, name, subOrgType, businessRegNumber || null, taxFileIncome || null, taxFileBituachLeumi || null,
        contactFirstName || null, contactLastName || null, contactEmail || null, contactMobile || null,
        paymentCardLast4 || null, paymentCardHolderName || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'sub_org_code already exists' });
    throw err;
  }
}));

/* ---------- org admins / time admins ---------- */

router.get('/organizations/:id/admins', asyncHandler(async (req, res) => {
  const orgId = Number(req.params.id);
  const { rows: admins } = await pool.query(
    `SELECT id, email, name, admin_type, created_at FROM org_admins WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId]
  );
  const { rows: subOrgLinks } = await pool.query(
    `SELECT oas.org_admin_id, so.id AS sub_org_id, so.sub_org_code, so.name
     FROM org_admin_sub_orgs oas
     JOIN sub_organizations so ON so.id = oas.sub_org_id
     WHERE oas.org_admin_id = ANY($1::int[])`,
    [admins.map((a) => a.id)]
  );
  const byAdmin = {};
  subOrgLinks.forEach((l) => { (byAdmin[l.org_admin_id] = byAdmin[l.org_admin_id] || []).push({ id: l.sub_org_id, code: l.sub_org_code, name: l.name }); });
  res.json(admins.map((a) => ({ ...a, subOrganizations: byAdmin[a.id] || [] })));
}));

router.post('/organizations/:id/admins', asyncHandler(async (req, res) => {
  const orgId = Number(req.params.id);
  const { email, name, password, adminType, subOrgIds } = req.body || {};

  if (!email || !name || !password) {
    return res.status(400).json({ error: 'email, name and password are required' });
  }
  if (!ADMIN_TYPES.includes(adminType)) {
    return res.status(400).json({ error: `adminType must be one of ${ADMIN_TYPES.join(', ')}` });
  }
  if (adminType === 'time_admin' && (!Array.isArray(subOrgIds) || subOrgIds.length === 0)) {
    return res.status(400).json({ error: 'time_admin requires at least one sub-organization in subOrgIds' });
  }

  const passwordHash = await hashPassword(password);
  const totpSecret = generateTotpSecret();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let created;
    try {
      const { rows } = await client.query(
        `INSERT INTO org_admins (org_id, email, name, password_hash, totp_secret, admin_type)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name, admin_type`,
        [orgId, email, name, passwordHash, totpSecret, adminType]
      );
      created = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'this email is already an admin for this organization' });
      }
      throw err;
    }

    if (adminType === 'time_admin') {
      const validSubOrgs = await client.query(
        'SELECT id FROM sub_organizations WHERE org_id = $1 AND id = ANY($2::int[])',
        [orgId, subOrgIds]
      );
      if (validSubOrgs.rows.length !== subOrgIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'one or more subOrgIds do not belong to this organization' });
      }
      for (const subOrgId of subOrgIds) {
        await client.query(
          'INSERT INTO org_admin_sub_orgs (org_admin_id, sub_org_id) VALUES ($1, $2)',
          [created.id, subOrgId]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ...created, totpEnrollUri: totpEnrollUri(totpSecret, email) });
  } finally {
    client.release();
  }
}));

/* ---------- system admins ---------- */

router.get('/system-admins', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, name, phone, is_root, created_at FROM system_admins ORDER BY created_at'
  );
  res.json(rows);
}));

router.post('/system-admins', asyncHandler(async (req, res) => {
  const { email, name, phone, password } = req.body || {};
  if (!email || !name || !password) {
    return res.status(400).json({ error: 'email, name and password are required' });
  }
  const passwordHash = await hashPassword(password);
  const totpSecret = generateTotpSecret();
  try {
    const { rows } = await pool.query(
      `INSERT INTO system_admins (email, name, phone, password_hash, totp_secret, is_root)
       VALUES ($1,$2,$3,$4,$5,false) RETURNING id, email, name, phone`,
      [email, name, phone || null, passwordHash, totpSecret]
    );
    res.json({ ...rows[0], totpEnrollUri: totpEnrollUri(totpSecret, email) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'a system admin with this email already exists' });
    throw err;
  }
}));

router.delete('/system-admins/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT is_root FROM system_admins WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  if (rows[0].is_root) return res.status(403).json({ error: 'the root system admin cannot be deleted' });
  await pool.query('DELETE FROM system_admins WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

module.exports = router;
