const express = require('express');
const { pool } = require('../db');
const { verifyPassword, verifyTotpCode, isValidIsraeliId, resolveOrgContext, hashPassword } = require('../auth');
const { listOrgAdmins, createOrgAdmin, updateOrgAdmin, deleteOrgAdmin } = require('../orgAdmins');

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
  const orgRes = await pool.query('SELECT name, org_code, logo_data_url FROM organizations WHERE id = $1', [orgId]);
  let adminName = null;
  if (req.session.orgAdminId) {
    const adminRes = await pool.query('SELECT name, email FROM org_admins WHERE id = $1', [req.session.orgAdminId]);
    if (adminRes.rows[0]) adminName = adminRes.rows[0].name;
  }
  res.json({
    orgId, role, subOrgRestriction,
    orgName: orgRes.rows[0] ? orgRes.rows[0].name : null,
    orgCode: orgRes.rows[0] ? orgRes.rows[0].org_code : null,
    orgLogoDataUrl: orgRes.rows[0] ? orgRes.rows[0].logo_data_url : null,
    adminName
  });
}));

/* ---------- cities (autocomplete + reverse lookup for the code<->name pair) ---------- */

router.get('/cities', asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const { rows } = await pool.query(
    'SELECT code, name_he FROM cities WHERE name_he ILIKE $1 ORDER BY name_he LIMIT 20',
    [`%${q}%`]
  );
  res.json(rows);
}));

router.get('/cities/:code', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT code, name_he FROM cities WHERE code = $1', [Number(req.params.code)]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

/* ---------- streets (autocomplete, scoped to a city) ---------- */

router.get('/streets', asyncHandler(async (req, res) => {
  const cityCode = Number(req.query.cityCode);
  const q = (req.query.q || '').trim();
  if (!cityCode) return res.status(400).json({ error: 'cityCode is required' });
  const { rows } = await pool.query(
    'SELECT street_code, name_he FROM streets WHERE city_code = $1 AND name_he ILIKE $2 ORDER BY name_he LIMIT 20',
    [cityCode, `%${q}%`]
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
  email, mobile, city_code, street, house_number, apartment, entrance, zip_code, sub_org_id,
  employment_start_date, employment_end_date, agreement_code, (password_hash IS NOT NULL) AS has_password`;

// Active = today is on/after the start date (or no start date set) AND on/before the end date
// (or no end date set) - so a brand-new employee with neither date is active by default, and
// setting an end date in the past is what "deactivates" them.
router.get('/employees', asyncHandler(async (req, res) => {
  const { orgId, subOrgRestriction } = req.orgContext;
  const wantInactive = req.query.status === 'inactive';
  const params = [orgId];
  let query = `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE client_id = $1`;
  if (subOrgRestriction) {
    query += ' AND sub_org_id = ANY($2::int[])';
    params.push(subOrgRestriction);
  }
  if (wantInactive) {
    query += ` AND NOT ((employment_start_date IS NULL OR employment_start_date <= to_char(now(), 'YYYY-MM-DD'))
                     AND (employment_end_date IS NULL OR employment_end_date >= to_char(now(), 'YYYY-MM-DD')))`;
  } else {
    query += ` AND (employment_start_date IS NULL OR employment_start_date <= to_char(now(), 'YYYY-MM-DD'))
               AND (employment_end_date IS NULL OR employment_end_date >= to_char(now(), 'YYYY-MM-DD'))`;
  }
  query += ' ORDER BY last_name NULLS LAST, first_name NULLS LAST';
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENGLISH_NAME_RE = /^[A-Za-z' -]*$/;
const DIGITS_RE = /^\d+$/;
const ZIP_RE = /^\d{7}$/;
const MOBILE_RE = /^(?:\+972|972|0)?(5[0-9]-?[0-9]{7})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function validateEmployeeInput(body, orgId, subOrgRestriction) {
  const {
    idNumber, idType, firstName, lastName, firstNameEn, lastNameEn,
    email, mobile, cityCode, street, houseNumber, apartment, entrance, zipCode, subOrgId,
    employmentStartDate, employmentEndDate, agreementCode, password
  } = body || {};

  if (password && password.length < 6) return { status: 400, error: 'password must be at least 6 characters' };
  if (!firstName || !lastName) return { status: 400, error: 'firstName and lastName are required' };
  if (!mobile) return { status: 400, error: 'mobile is required' };
  if (!MOBILE_RE.test(mobile)) return { status: 400, error: 'invalid mobile number' };
  if (!cityCode || !street || !houseNumber) return { status: 400, error: 'city, street and houseNumber are required' };
  if (!DIGITS_RE.test(String(houseNumber))) return { status: 400, error: 'houseNumber must contain digits only' };
  if (apartment && !DIGITS_RE.test(String(apartment))) return { status: 400, error: 'apartment must contain digits only' };
  if (zipCode && !ZIP_RE.test(String(zipCode))) return { status: 400, error: 'zipCode must be exactly 7 digits' };
  if (email && !EMAIL_RE.test(email)) return { status: 400, error: 'invalid email address' };
  if (firstNameEn && !ENGLISH_NAME_RE.test(firstNameEn)) return { status: 400, error: 'firstNameEn must contain English letters only' };
  if (lastNameEn && !ENGLISH_NAME_RE.test(lastNameEn)) return { status: 400, error: 'lastNameEn must contain English letters only' };
  if (!employmentStartDate) return { status: 400, error: 'employmentStartDate is required' };
  if (!ISO_DATE_RE.test(employmentStartDate)) return { status: 400, error: 'invalid employmentStartDate' };
  if (employmentEndDate && !ISO_DATE_RE.test(employmentEndDate)) return { status: 400, error: 'invalid employmentEndDate' };
  if (!agreementCode) return { status: 400, error: 'agreementCode is required' };
  const whitelisted = await pool.query(
    `SELECT 1 FROM org_attendance_agreements
     WHERE org_id = $1 AND agreement_code = $2
       AND (effective_from IS NULL OR effective_from <= to_char(now(), 'YYYY-MM-DD'))
       AND (effective_until IS NULL OR effective_until >= to_char(now(), 'YYYY-MM-DD'))`,
    [orgId, agreementCode]
  );
  if (!whitelisted.rows[0]) return { status: 400, error: 'agreementCode is not enabled for this organization' };

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
      subOrgId: subOrgId || null,
      employmentStartDate: employmentStartDate || null, employmentEndDate: employmentEndDate || null,
      agreementCode, password: password || null
    }
  };
}

router.post('/employees', asyncHandler(async (req, res) => {
  const { orgId, subOrgRestriction } = req.orgContext;
  const validation = await validateEmployeeInput(req.body, orgId, subOrgRestriction);
  if (validation.error) return res.status(validation.status).json({ error: validation.error });
  const d = validation.data;
  const name = `${d.firstName} ${d.lastName}`.trim();
  const passwordHash = d.password ? await hashPassword(d.password) : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO employees
         (client_id, name, sub_org_id, id_number, id_type, first_name, last_name, first_name_en, last_name_en,
          email, mobile, city_code, street, house_number, apartment, entrance, zip_code,
          employment_start_date, employment_end_date, agreement_code, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING ${EMPLOYEE_COLUMNS}`,
      [orgId, name, d.subOrgId, d.idNumber, d.idType, d.firstName, d.lastName, d.firstNameEn, d.lastNameEn,
        d.email, d.mobile, d.cityCode, d.street, d.houseNumber, d.apartment, d.entrance, d.zipCode,
        d.employmentStartDate, d.employmentEndDate, d.agreementCode, passwordHash]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'idNumber already exists for another employee in this organization' });
    throw err;
  }
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

  try {
    // A blank password on edit means "leave it unchanged" (same convention as org_admins'
    // password field) - only touch password_hash when a new one was actually submitted.
    const { rows } = d.password
      ? await pool.query(
          `UPDATE employees SET name=$1, sub_org_id=$2, id_number=$3, id_type=$4, first_name=$5, last_name=$6,
             first_name_en=$7, last_name_en=$8, email=$9, mobile=$10, city_code=$11, street=$12, house_number=$13,
             apartment=$14, entrance=$15, zip_code=$16, employment_start_date=$17, employment_end_date=$18,
             agreement_code=$19, password_hash=$20
           WHERE id = $21 AND client_id = $22
           RETURNING ${EMPLOYEE_COLUMNS}`,
          [name, d.subOrgId, d.idNumber, d.idType, d.firstName, d.lastName, d.firstNameEn, d.lastNameEn,
            d.email, d.mobile, d.cityCode, d.street, d.houseNumber, d.apartment, d.entrance, d.zipCode,
            d.employmentStartDate, d.employmentEndDate, d.agreementCode, await hashPassword(d.password),
            Number(req.params.id), orgId]
        )
      : await pool.query(
          `UPDATE employees SET name=$1, sub_org_id=$2, id_number=$3, id_type=$4, first_name=$5, last_name=$6,
             first_name_en=$7, last_name_en=$8, email=$9, mobile=$10, city_code=$11, street=$12, house_number=$13,
             apartment=$14, entrance=$15, zip_code=$16, employment_start_date=$17, employment_end_date=$18,
             agreement_code=$19
           WHERE id = $20 AND client_id = $21
           RETURNING ${EMPLOYEE_COLUMNS}`,
          [name, d.subOrgId, d.idNumber, d.idType, d.firstName, d.lastName, d.firstNameEn, d.lastNameEn,
            d.email, d.mobile, d.cityCode, d.street, d.houseNumber, d.apartment, d.entrance, d.zipCode,
            d.employmentStartDate, d.employmentEndDate, d.agreementCode,
            Number(req.params.id), orgId]
        );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'idNumber already exists for another employee in this organization' });
    throw err;
  }
}));

router.delete('/employees/:id', asyncHandler(async (req, res) => {
  const { orgId, subOrgRestriction } = req.orgContext;
  const existing = await findScopedEmployee(Number(req.params.id), orgId, subOrgRestriction);
  if (!existing) return res.status(404).json({ error: 'not found' });
  await pool.query('DELETE FROM employees WHERE id = $1 AND client_id = $2', [Number(req.params.id), orgId]);
  res.json({ ok: true });
}));

/* ---------- org admins / time admins (this org's own management scope) ---------- */
// System Admin (in-org) sees/manages both admin_type values; Org Admin is restricted to
// time_admin rows only (per spec: Org Admin "defines" Time Admins, never other Org Admins).
// Time Admin has no access to this area at all.

router.get('/admins', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role === 'time_admin') return res.status(403).json({ error: 'not authorized' });
  res.json(await listOrgAdmins(orgId));
}));

router.post('/admins', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role === 'time_admin') return res.status(403).json({ error: 'not authorized' });
  const restrictToType = role === 'org_admin' ? 'time_admin' : undefined;
  const result = await createOrgAdmin(orgId, req.body || {}, restrictToType);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
}));

router.put('/admins/:id', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role === 'time_admin') return res.status(403).json({ error: 'not authorized' });
  const restrictToType = role === 'org_admin' ? 'time_admin' : undefined;
  const result = await updateOrgAdmin(orgId, req.params.id, req.body || {}, restrictToType);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
}));

router.delete('/admins/:id', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role === 'time_admin') return res.status(403).json({ error: 'not authorized' });
  const restrictToType = role === 'org_admin' ? 'time_admin' : undefined;
  const result = await deleteOrgAdmin(orgId, req.params.id, restrictToType);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
}));

/* ---------- attendance agreements (org whitelist) ---------- */
// Read-only browsing of the full catalog is fine for any role (Time Admin included, since they
// need to see an employee's assigned agreement); toggling the whitelist is System Admin / Org
// Admin only, same guard style as the admin-management routes above.

router.get('/agreements', asyncHandler(async (req, res) => {
  const { orgId } = req.orgContext;
  const { rows: catalog } = await pool.query('SELECT * FROM attendance_agreements ORDER BY name');
  const { rows: whitelistRows } = await pool.query(
    'SELECT agreement_code, effective_from, effective_until FROM org_attendance_agreements WHERE org_id = $1',
    [orgId]
  );
  const byCode = {};
  whitelistRows.forEach((r) => { byCode[r.agreement_code] = r; });
  res.json(catalog.map((a) => ({
    ...a,
    effectiveFrom: byCode[a.code] ? byCode[a.code].effective_from : null,
    effectiveUntil: byCode[a.code] ? byCode[a.code].effective_until : null,
    whitelisted: Boolean(byCode[a.code])
  })));
}));

router.put('/agreements/:code', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role === 'time_admin') return res.status(403).json({ error: 'not authorized' });
  const { effectiveFrom, effectiveUntil } = req.body || {};
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (effectiveFrom && !ISO_DATE_RE.test(effectiveFrom)) return res.status(400).json({ error: 'invalid effectiveFrom' });
  if (effectiveUntil && !ISO_DATE_RE.test(effectiveUntil)) return res.status(400).json({ error: 'invalid effectiveUntil' });
  if (effectiveFrom && effectiveUntil && effectiveFrom > effectiveUntil) {
    return res.status(400).json({ error: 'effectiveFrom must be on or before effectiveUntil' });
  }
  const agreement = await pool.query('SELECT code FROM attendance_agreements WHERE code = $1', [req.params.code]);
  if (!agreement.rows[0]) return res.status(404).json({ error: 'not found' });
  await pool.query(
    `INSERT INTO org_attendance_agreements (org_id, agreement_code, effective_from, effective_until)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, agreement_code) DO UPDATE SET effective_from = $3, effective_until = $4`,
    [orgId, req.params.code, effectiveFrom || null, effectiveUntil || null]
  );
  res.json({ ok: true });
}));

router.delete('/agreements/:code', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role === 'time_admin') return res.status(403).json({ error: 'not authorized' });
  await pool.query('DELETE FROM org_attendance_agreements WHERE org_id = $1 AND agreement_code = $2', [orgId, req.params.code]);
  res.json({ ok: true });
}));

/* ---------- report types (org whitelist) ---------- */
// Same read-any-role / write-not-time_admin pattern as the attendance-agreements whitelist above.

router.get('/report-types', asyncHandler(async (req, res) => {
  const { orgId } = req.orgContext;
  const { rows: catalog } = await pool.query('SELECT * FROM report_types ORDER BY name');
  const { rows: whitelistRows } = await pool.query(
    'SELECT type_code, effective_from, effective_until FROM org_report_types WHERE org_id = $1',
    [orgId]
  );
  const byCode = {};
  whitelistRows.forEach((r) => { byCode[r.type_code] = r; });
  res.json(catalog.map((t) => ({
    ...t,
    effectiveFrom: byCode[t.code] ? byCode[t.code].effective_from : null,
    effectiveUntil: byCode[t.code] ? byCode[t.code].effective_until : null,
    whitelisted: Boolean(byCode[t.code])
  })));
}));

router.put('/report-types/:code', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role === 'time_admin') return res.status(403).json({ error: 'not authorized' });
  const { effectiveFrom, effectiveUntil } = req.body || {};
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (effectiveFrom && !ISO_DATE_RE.test(effectiveFrom)) return res.status(400).json({ error: 'invalid effectiveFrom' });
  if (effectiveUntil && !ISO_DATE_RE.test(effectiveUntil)) return res.status(400).json({ error: 'invalid effectiveUntil' });
  if (effectiveFrom && effectiveUntil && effectiveFrom > effectiveUntil) {
    return res.status(400).json({ error: 'effectiveFrom must be on or before effectiveUntil' });
  }
  const type = await pool.query('SELECT code FROM report_types WHERE code = $1', [req.params.code]);
  if (!type.rows[0]) return res.status(404).json({ error: 'not found' });
  await pool.query(
    `INSERT INTO org_report_types (org_id, type_code, effective_from, effective_until)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, type_code) DO UPDATE SET effective_from = $3, effective_until = $4`,
    [orgId, req.params.code, effectiveFrom || null, effectiveUntil || null]
  );
  res.json({ ok: true });
}));

router.delete('/report-types/:code', asyncHandler(async (req, res) => {
  const { orgId, role } = req.orgContext;
  if (role === 'time_admin') return res.status(403).json({ error: 'not authorized' });
  await pool.query('DELETE FROM org_report_types WHERE org_id = $1 AND type_code = $2', [orgId, req.params.code]);
  res.json({ ok: true });
}));

module.exports = router;
