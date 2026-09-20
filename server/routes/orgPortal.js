const express = require('express');
const { pool } = require('../db');
const { verifyPassword, verifyTotpCode, isValidIsraeliId, resolveOrgContext } = require('../auth');
const { updateOrgAdmin, deleteOrgAdmin } = require('../orgAdmins');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

/* ---------- auth ---------- */

router.post('/login', asyncHandler(async (req, res) => {
  const { orgCode, email, password, totp } = req.body || {};
  if (!orgCode || !email || !password || !totp) {
    return res.status(400).json({ error: 'orgCode, email, password and totp are required' });
  }
  const orgRes = await pool.query('SELECT id FROM organizations WHERE org_code = $1', [orgCode]);
  const org = orgRes.rows[0];
  // Same generic error whether the org code or the credentials are wrong - avoids leaking
  // which org codes exist to someone probing the login form.
  if (!org) return res.status(401).json({ error: 'invalid credentials' });

  const { rows } = await pool.query('SELECT * FROM org_admins WHERE org_id = $1 AND email = $2', [org.id, email]);
  const admin = rows[0];
  if (!admin || !(await verifyPassword(password, admin.password_hash))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (!verifyTotpCode(admin.totp_secret, totp)) {
    return res.status(401).json({ error: 'invalid authenticator code' });
  }
  req.session.orgAdminId = admin.id;
  delete req.session.systemAdminId;
  delete req.session.enteredOrgId;
  res.json({
    ok: true,
    admin: { id: admin.id, email: admin.email, name: admin.name, adminType: admin.admin_type, orgId: admin.org_id }
  });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.use(resolveOrgContext);

router.get('/me', asyncHandler(async (req, res) => {
  const { orgId, role, subOrgRestriction } = req.orgContext;
  const orgRes = await pool.query('SELECT name, org_code FROM organizations WHERE id = $1', [orgId]);
  let adminName = null;
  if (req.session.orgAdminId) {
    const adminRes = await pool.query('SELECT name, email FROM org_admins WHERE id = $1', [req.session.orgAdminId]);
    if (adminRes.rows[0]) adminName = adminRes.rows[0].name;
  }
  res.json({
    orgId, role, subOrgRestriction,
    orgName: orgRes.rows[0] ? orgRes.rows[0].name : null,
    orgCode: orgRes.rows[0] ? orgRes.rows[0].org_code : null,
    adminName
  });
}));

/* ---------- cities (autocomplete) ---------- */

router.get('/cities', asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const { rows } = await pool.query(
    'SELECT code, name_he FROM cities WHERE name_he ILIKE $1 ORDER BY name_he LIMIT 20',
    [`%${q}%`]
  );
  res.json(rows);
}));

/* ---------- sub-organizations (read-only here; management stays System-Admin-only) ---------- */

router.get('/sub-organizations', asyncHandler(async (req, res) => {
  const { orgId, subOrgRestriction } = req.orgContext;
  const params = [orgId];
  let query = 'SELECT id, sub_org_code, name, sub_org_type FROM sub_organizations WHERE org_id = $1';
  if (subOrgRestriction) {
    query += ' AND id = ANY($2::int[])';
    params.push(subOrgRestriction);
  }
  query += ' ORDER BY name';
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

/* ---------- employees ---------- */

const EMPLOYEE_COLUMNS = `id, id_number, id_type, first_name, last_name, first_name_en, last_name_en,
  email, mobile, city_code, street, house_number, apartment, entrance, zip_code, sub_org_id`;

router.get('/employees', asyncHandler(async (req, res) => {
  const { orgId, subOrgRestriction } = req.orgContext;
  const params = [orgId];
  let query = `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE client_id = $1`;
  if (subOrgRestriction) {
    query += ' AND sub_org_id = ANY($2::int[])';
    params.push(subOrgRestriction);
  }
  query += ' ORDER BY last_name NULLS LAST, first_name NULLS LAST';
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

async function validateEmployeeInput(body, orgId, subOrgRestriction) {
  const {
    idNumber, idType, firstName, lastName, firstNameEn, lastNameEn,
    email, mobile, cityCode, street, houseNumber, apartment, entrance, zipCode, subOrgId
  } = body || {};

  if (!firstName || !lastName) return { status: 400, error: 'firstName and lastName are required' };
  if (!mobile) return { status: 400, error: 'mobile is required' };
  if (!cityCode || !street || !houseNumber) return { status: 400, error: 'city, street and houseNumber are required' };
  if (!/^\d+$/.test(String(houseNumber))) return { status: 400, error: 'houseNumber must contain digits only' };

  const type = idType === 'passport' ? 'passport' : 'israeli_id';
  if (type === 'passport') {
    if (!idNumber) return { status: 400, error: 'idNumber is required' };
  } else if (!isValidIsraeliId(idNumber)) {
    return { status: 400, error: 'invalid Israeli ID number' };
  }

  const subOrgCountRes = await pool.query('SELECT COUNT(*)::int AS c FROM sub_organizations WHERE org_id = $1', [orgId]);
  const orgHasSubOrgs = subOrgCountRes.rows[0].c > 0;
  if (orgHasSubOrgs && !subOrgId) {
    return { status: 400, error: 'subOrgId is required because this organization has sub-organizations' };
  }
  if (subOrgId) {
    const validSub = await pool.query('SELECT id FROM sub_organizations WHERE id = $1 AND org_id = $2', [subOrgId, orgId]);
    if (!validSub.rows[0]) return { status: 400, error: 'subOrgId does not belong to this organization' };
    if (subOrgRestriction && !subOrgRestriction.includes(Number(subOrgId))) {
      return { status: 403, error: 'not authorized for this sub-organization' };
    }
  }

  return {
    data: {
      idNumber, idType: type, firstName, lastName, firstNameEn: firstNameEn || null, lastNameEn: lastNameEn || null,
      email: email || null, mobile, cityCode, street, houseNumber: String(houseNumber),
      apartment: apartment || null, entrance: entrance || null, zipCode: zipCode || null,
      subOrgId: subOrgId || null
    }
  };
}

router.post('/employees', asyncHandler(async (req, res) => {
  const { orgId, subOrgRestriction } = req.orgContext;
  const validation = await validateEmployeeInput(req.body, orgId, subOrgRestriction);
  if (validation.error) return res.status(validation.status).json({ error: validation.error });
  const d = validation.data;
  const name = `${d.firstName} ${d.lastName}`.trim();

  const { rows } = await pool.query(
    `INSERT INTO employees
       (client_id, name, sub_org_id, id_number, id_type, first_name, last_name, first_name_en, last_name_en,
        email, mobile, city_code, street, house_number, apartment, entrance, zip_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${EMPLOYEE_COLUMNS}`,
    [orgId, name, d.subOrgId, d.idNumber, d.idType, d.firstName, d.lastName, d.firstNameEn, d.lastNameEn,
      d.email, d.mobile, d.cityCode, d.street, d.houseNumber, d.apartment, d.entrance, d.zipCode]
  );
  res.json(rows[0]);
}));

async function findScopedEmployee(id, orgId, subOrgRestriction) {
  const { rows } = await pool.query('SELECT id, sub_org_id FROM employees WHERE id = $1 AND client_id = $2', [id, orgId]);
  const emp = rows[0];
  if (!emp) return null;
  if (subOrgRestriction && !subOrgRestriction.includes(emp.sub_org_id)) return null;
  return emp;
}

router.put('/employees/:id', asyncHandler(async (req, res) => {
  const { orgId, subOrgRestriction } = req.orgContext;
  const existing = await findScopedEmployee(Number(req.params.id), orgId, subOrgRestriction);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const validation = await validateEmployeeInput(req.body, orgId, subOrgRestriction);
  if (validation.error) return res.status(validation.status).json({ error: validation.error });
  const d = validation.data;
  const name = `${d.firstName} ${d.lastName}`.trim();

  const { rows } = await pool.query(
    `UPDATE employees SET name=$1, sub_org_id=$2, id_number=$3, id_type=$4, first_name=$5, last_name=$6,
       first_name_en=$7, last_name_en=$8, email=$9, mobile=$10, city_code=$11, street=$12, house_number=$13,
       apartment=$14, entrance=$15, zip_code=$16
     WHERE id = $17 AND client_id = $18
     RETURNING ${EMPLOYEE_COLUMNS}`,
    [name, d.subOrgId, d.idNumber, d.idType, d.firstName, d.lastName, d.firstNameEn, d.lastNameEn,
      d.email, d.mobile, d.cityCode, d.street, d.houseNumber, d.apartment, d.entrance, d.zipCode,
      Number(req.params.id), orgId]
  );
  res.json(rows[0]);
}));

router.delete('/employees/:id', asyncHandler(async (req, res) => {
  const { orgId, subOrgRestriction } = req.orgContext;
  const existing = await findScopedEmployee(Number(req.params.id), orgId, subOrgRestriction);
  if (!existing) return res.status(404).json({ error: 'not found' });
  await pool.query('DELETE FROM employees WHERE id = $1 AND client_id = $2', [Number(req.params.id), orgId]);
  res.json({ ok: true });
}));

/* ---------- time admins (Org Admin's own management scope) ---------- */
// System Admin can also reach these via /api/system/organizations/:orgId/admins/:id, which has
// no type restriction. This endpoint is specifically for an Org Admin managing the time_admin
// rows in their own org (per spec) - it can never touch/create an org_admin-type row.

router.put('/time-admins/:id', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role !== 'system_admin' && role !== 'org_admin') return res.status(403).json({ error: 'not authorized' });
  const current = await pool.query('SELECT admin_type FROM org_admins WHERE id = $1 AND org_id = $2', [req.params.id, orgId]);
  if (!current.rows[0]) return res.status(404).json({ error: 'not found' });
  if (current.rows[0].admin_type !== 'time_admin') return res.status(403).json({ error: 'not authorized' });

  const result = await updateOrgAdmin(orgId, req.params.id, { ...req.body, adminType: 'time_admin' });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
}));

router.delete('/time-admins/:id', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role !== 'system_admin' && role !== 'org_admin') return res.status(403).json({ error: 'not authorized' });
  const result = await deleteOrgAdmin(orgId, req.params.id, 'time_admin');
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
}));

module.exports = router;
