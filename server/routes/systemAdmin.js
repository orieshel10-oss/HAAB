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
const { listOrgAdmins, createOrgAdmin, updateOrgAdmin, deleteOrgAdmin, ADMIN_TYPES } = require('../orgAdmins');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

const SUB_ORG_TYPES = ['factory_unit', 'division', 'department'];

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
  delete req.session.orgAdminId;
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

const ORG_FIELDS = [
  ['businessRegNumber', 'business_reg_number'],
  ['taxFileIncome', 'tax_file_income'],
  ['taxFileBituachLeumi', 'tax_file_bituach_leumi'],
  ['contactFirstName', 'contact_first_name'],
  ['contactLastName', 'contact_last_name'],
  ['contactEmail', 'contact_email'],
  ['contactMobile', 'contact_mobile'],
  ['paymentCardLast4', 'payment_card_last4'],
  ['paymentCardHolderName', 'payment_card_holder_name']
];

router.post('/organizations', asyncHandler(async (req, res) => {
  const { orgCode, name } = req.body || {};

  if (!/^\d{6}$/.test(orgCode || '')) {
    return res.status(400).json({ error: 'orgCode must be exactly 6 digits' });
  }
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO organizations
         (name, org_code, business_reg_number, tax_file_income, tax_file_bituach_leumi,
          contact_first_name, contact_last_name, contact_email, contact_mobile,
          payment_card_last4, payment_card_holder_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, org_code, name`,
      [name, orgCode, ...ORG_FIELDS.map(([key]) => req.body[key] || null)]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'org_code already exists' });
    throw err;
  }
}));

router.put('/organizations/:id', asyncHandler(async (req, res) => {
  const orgId = Number(req.params.id);
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const setClauses = ['name = $1', ...ORG_FIELDS.map(([, col], i) => `${col} = $${i + 2}`)];
  const values = [name, ...ORG_FIELDS.map(([key]) => req.body[key] || null)];
  const { rows } = await pool.query(
    `UPDATE organizations SET ${setClauses.join(', ')} WHERE id = $${values.length + 1}
     RETURNING id, org_code, name`,
    [...values, orgId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// Deleting an organization is destructive (cascades to its employees' attendance/absence
// history, sub-orgs and admins), so it's gated behind the *logged-in System Admin's own*
// login password rather than anything org-specific - a standard "re-enter your password to
// confirm" step-up, not a separate secret to manage per org.
router.delete('/organizations/:id', asyncHandler(async (req, res) => {
  const orgId = Number(req.params.id);
  const { password } = req.body || {};
  const { rows } = await pool.query('SELECT password_hash FROM system_admins WHERE id = $1', [req.session.systemAdminId]);
  if (!rows[0] || !(await verifyPassword(password || '', rows[0].password_hash))) {
    return res.status(401).json({ error: 'invalid password' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM attendance_events WHERE employee_id IN (SELECT id FROM employees WHERE client_id = $1)`,
      [orgId]
    );
    await client.query(
      `DELETE FROM absences WHERE employee_id IN (SELECT id FROM employees WHERE client_id = $1)`,
      [orgId]
    );
    await client.query('DELETE FROM employees WHERE client_id = $1', [orgId]);
    await client.query('DELETE FROM org_admins WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM sub_organizations WHERE org_id = $1', [orgId]);
    const del = await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await client.query('COMMIT');
    if (del.rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Re-verifies the logged-in System Admin's own password before letting them cross from the
// product-level area into a specific organization's context (step-up auth, not a per-org secret).
router.post('/organizations/:id/enter', asyncHandler(async (req, res) => {
  const orgId = Number(req.params.id);
  const { password } = req.body || {};
  const { rows: orgRows } = await pool.query('SELECT id FROM organizations WHERE id = $1', [orgId]);
  if (!orgRows[0]) return res.status(404).json({ error: 'not found' });

  const { rows } = await pool.query('SELECT password_hash FROM system_admins WHERE id = $1', [req.session.systemAdminId]);
  if (!rows[0] || !(await verifyPassword(password || '', rows[0].password_hash))) {
    return res.status(401).json({ error: 'invalid password' });
  }
  req.session.enteredOrgId = orgId;
  res.json({ ok: true });
}));

const LOGO_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const LOGO_MAX_LENGTH = 400 * 1024; // ~400KB of base64 text, plenty for a small logo

router.put('/organizations/:id/logo', asyncHandler(async (req, res) => {
  const orgId = Number(req.params.id);
  const { logoDataUrl } = req.body || {};
  if (logoDataUrl !== null && logoDataUrl !== undefined) {
    if (typeof logoDataUrl !== 'string' || !LOGO_DATA_URL_RE.test(logoDataUrl) || logoDataUrl.length > LOGO_MAX_LENGTH) {
      return res.status(400).json({ error: 'invalid or oversized logo image' });
    }
  }
  const { rows } = await pool.query(
    'UPDATE organizations SET logo_data_url = $1 WHERE id = $2 RETURNING id',
    [logoDataUrl || null, orgId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
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

const SUB_ORG_FIELDS = [
  ['businessRegNumber', 'business_reg_number'],
  ['taxFileIncome', 'tax_file_income'],
  ['taxFileBituachLeumi', 'tax_file_bituach_leumi'],
  ['contactFirstName', 'contact_first_name'],
  ['contactLastName', 'contact_last_name'],
  ['contactEmail', 'contact_email'],
  ['contactMobile', 'contact_mobile'],
  ['paymentCardLast4', 'payment_card_last4'],
  ['paymentCardHolderName', 'payment_card_holder_name']
];

router.put('/organizations/:orgId/sub-organizations/:id', asyncHandler(async (req, res) => {
  const { orgId, id } = req.params;
  const { name, subOrgType } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!SUB_ORG_TYPES.includes(subOrgType)) {
    return res.status(400).json({ error: `subOrgType must be one of ${SUB_ORG_TYPES.join(', ')}` });
  }
  const setClauses = ['name = $1', 'sub_org_type = $2', ...SUB_ORG_FIELDS.map(([, col], i) => `${col} = $${i + 3}`)];
  const values = [name, subOrgType, ...SUB_ORG_FIELDS.map(([key]) => req.body[key] || null)];
  const { rows } = await pool.query(
    `UPDATE sub_organizations SET ${setClauses.join(', ')} WHERE id = $${values.length + 1} AND org_id = $${values.length + 2}
     RETURNING id, sub_org_code, name, sub_org_type`,
    [...values, Number(id), Number(orgId)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// Employees aren't manageable yet (Phase 2), but the sub_org_id column already exists so this
// guard is real and will start mattering the moment employee assignment ships.
router.get('/organizations/:orgId/sub-organizations/:id/employees', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM employees WHERE sub_org_id = $1 ORDER BY name', [Number(req.params.id)]);
  res.json(rows);
}));

router.delete('/organizations/:orgId/sub-organizations/:id', asyncHandler(async (req, res) => {
  const { orgId, id } = req.params;
  const { rows: employees } = await pool.query(
    'SELECT id, name FROM employees WHERE sub_org_id = $1',
    [Number(id)]
  );
  if (employees.length > 0) {
    return res.status(409).json({ error: 'has_employees', count: employees.length, employees });
  }
  const del = await pool.query('DELETE FROM sub_organizations WHERE id = $1 AND org_id = $2', [Number(id), Number(orgId)]);
  if (del.rowCount === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

/* ---------- org admins / time admins ---------- */

router.get('/organizations/:id/admins', asyncHandler(async (req, res) => {
  res.json(await listOrgAdmins(Number(req.params.id)));
}));

router.post('/organizations/:id/admins', asyncHandler(async (req, res) => {
  const result = await createOrgAdmin(Number(req.params.id), req.body || {});
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
}));

// Edit/delete for an org_admin row is System-Admin-only; for a time_admin row the spec also
// wants this allowed from that org's own Org Admin - but Org Admin login doesn't exist yet
// (Phase 2), so there is only the System Admin path to gate on for now. Revisit this check once
// Org Admin sessions exist: allow it when req.session.orgAdminId's org_id matches AND the target
// row's admin_type is 'time_admin'.
// System Admin may edit/delete either admin_type - no restriction passed to the shared helpers.
router.put('/organizations/:orgId/admins/:id', asyncHandler(async (req, res) => {
  const { orgId, id } = req.params;
  const result = await updateOrgAdmin(orgId, id, req.body || {});
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
}));

router.delete('/organizations/:orgId/admins/:id', asyncHandler(async (req, res) => {
  const { orgId, id } = req.params;
  const result = await deleteOrgAdmin(orgId, id);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
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
    res.json({ ...rows[0], totpEnrollUri: totpEnrollUri(totpSecret, `${email} (System Admin)`) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'a system admin with this email already exists' });
    throw err;
  }
}));

// Email stays fixed (it's the login identifier) - only name, phone and (optionally) password
// are editable. Leave `password` blank/omitted to keep the current one.
router.put('/system-admins/:id', asyncHandler(async (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  if (password) {
    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query(
      'UPDATE system_admins SET name = $1, phone = $2, password_hash = $3 WHERE id = $4 RETURNING id, email, name, phone, is_root',
      [name, phone || null, passwordHash, Number(req.params.id)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    return res.json(rows[0]);
  }
  const { rows } = await pool.query(
    'UPDATE system_admins SET name = $1, phone = $2 WHERE id = $3 RETURNING id, email, name, phone, is_root',
    [name, phone || null, Number(req.params.id)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.delete('/system-admins/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT is_root FROM system_admins WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  if (rows[0].is_root) return res.status(403).json({ error: 'the root system admin cannot be deleted' });
  await pool.query('DELETE FROM system_admins WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

/* ---------- attendance agreements (product-level catalog) ---------- */

const HOLIDAY_CALENDARS = ['jewish', 'christian', 'muslim', 'none'];

router.get('/agreements', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM attendance_agreements ORDER BY created_at DESC');
  res.json(rows);
}));

function validateAgreementBody(body) {
  const { code, name, dayStandardMinutes, shortenedDayStandardMinutes, weeklyRestDay, workdaysPerWeek, holidayCalendar } = body || {};
  if (!/^[A-Za-z0-9]{4}$/.test(code || '')) return { status: 400, error: 'code must be exactly 4 alphanumeric characters' };
  if (!name || name.length > 20) return { status: 400, error: 'name is required and must be at most 20 characters' };
  if (!Number.isInteger(dayStandardMinutes) || dayStandardMinutes <= 0) return { status: 400, error: 'dayStandardMinutes must be a positive integer' };
  if (!Number.isInteger(shortenedDayStandardMinutes) || shortenedDayStandardMinutes <= 0) return { status: 400, error: 'shortenedDayStandardMinutes must be a positive integer' };
  if (!Number.isInteger(weeklyRestDay) || weeklyRestDay < 0 || weeklyRestDay > 6) return { status: 400, error: 'weeklyRestDay must be 0-6' };
  if (!Number.isInteger(workdaysPerWeek) || workdaysPerWeek < 1 || workdaysPerWeek > 7) return { status: 400, error: 'workdaysPerWeek must be 1-7' };
  if (!HOLIDAY_CALENDARS.includes(holidayCalendar)) return { status: 400, error: `holidayCalendar must be one of ${HOLIDAY_CALENDARS.join(', ')}` };
  if (body.promptText && body.promptText.length > 4000) return { status: 400, error: 'promptText must be at most 4000 characters' };
  return { data: { code, name, description: body.description || null, dayStandardMinutes, shortenedDayStandardMinutes, weeklyRestDay, workdaysPerWeek, holidayCalendar, promptText: body.promptText || null } };
}

router.post('/agreements', asyncHandler(async (req, res) => {
  const validation = validateAgreementBody(req.body);
  if (validation.error) return res.status(validation.status).json({ error: validation.error });
  const d = validation.data;
  try {
    const { rows } = await pool.query(
      `INSERT INTO attendance_agreements
         (code, name, description, day_standard_minutes, shortened_day_standard_minutes, weekly_rest_day, workdays_per_week, holiday_calendar, prompt_text, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [d.code, d.name, d.description, d.dayStandardMinutes, d.shortenedDayStandardMinutes, d.weeklyRestDay, d.workdaysPerWeek, d.holidayCalendar, d.promptText, req.session.systemAdminId]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'agreement code already exists' });
    throw err;
  }
}));

router.put('/agreements/:code', asyncHandler(async (req, res) => {
  const validation = validateAgreementBody({ ...req.body, code: req.params.code });
  if (validation.error) return res.status(validation.status).json({ error: validation.error });
  const d = validation.data;
  const { rows } = await pool.query(
    `UPDATE attendance_agreements SET name=$1, description=$2, day_standard_minutes=$3,
       shortened_day_standard_minutes=$4, weekly_rest_day=$5, workdays_per_week=$6, holiday_calendar=$7, prompt_text=$8
     WHERE code = $9 RETURNING *`,
    [d.name, d.description, d.dayStandardMinutes, d.shortenedDayStandardMinutes, d.weeklyRestDay, d.workdaysPerWeek, d.holidayCalendar, d.promptText, req.params.code]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.delete('/agreements/:code', asyncHandler(async (req, res) => {
  const { rows: employees } = await pool.query(
    'SELECT id, name FROM employees WHERE agreement_code = $1',
    [req.params.code]
  );
  if (employees.length > 0) {
    return res.status(409).json({ error: 'has_employees', count: employees.length, employees });
  }
  await pool.query('DELETE FROM org_attendance_agreements WHERE agreement_code = $1', [req.params.code]);
  const del = await pool.query('DELETE FROM attendance_agreements WHERE code = $1', [req.params.code]);
  if (del.rowCount === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

/* ---------- report types (product-level catalog) ---------- */

const REPORT_TYPE_CATEGORIES = ['presence', 'absence'];
const REPORT_TYPE_CODE_RE = /^[a-z][a-z0-9_]{1,29}$/;

router.get('/report-types', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM report_types ORDER BY name');
  res.json(rows);
}));

function validateReportTypeBody(body) {
  const { code, name, category } = body || {};
  if (!REPORT_TYPE_CODE_RE.test(code || '')) {
    return { status: 400, error: 'code must be lowercase letters/digits/underscores, 2-30 characters, starting with a letter' };
  }
  if (!name || name.length > 30) return { status: 400, error: 'name is required and must be at most 30 characters' };
  if (!REPORT_TYPE_CATEGORIES.includes(category)) {
    return { status: 400, error: `category must be one of ${REPORT_TYPE_CATEGORIES.join(', ')}` };
  }
  return { data: { code, name, category } };
}

router.post('/report-types', asyncHandler(async (req, res) => {
  const validation = validateReportTypeBody(req.body);
  if (validation.error) return res.status(validation.status).json({ error: validation.error });
  const d = validation.data;
  try {
    const { rows } = await pool.query(
      'INSERT INTO report_types (code, name, category, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [d.code, d.name, d.category, req.session.systemAdminId]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'report type code already exists' });
    throw err;
  }
}));

router.put('/report-types/:code', asyncHandler(async (req, res) => {
  const validation = validateReportTypeBody({ ...req.body, code: req.params.code });
  if (validation.error) return res.status(validation.status).json({ error: validation.error });
  const d = validation.data;
  const { rows } = await pool.query(
    'UPDATE report_types SET name=$1, category=$2 WHERE code = $3 RETURNING *',
    [d.name, d.category, req.params.code]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.delete('/report-types/:code', asyncHandler(async (req, res) => {
  const { rows: uses } = await pool.query('SELECT id FROM absences WHERE type = $1 LIMIT 1', [req.params.code]);
  if (uses.length > 0) {
    return res.status(409).json({ error: 'in_use' });
  }
  await pool.query('DELETE FROM org_report_types WHERE type_code = $1', [req.params.code]);
  const del = await pool.query('DELETE FROM report_types WHERE code = $1', [req.params.code]);
  if (del.rowCount === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

/* ---------- holidays ---------- */

const CALENDAR_TYPES = ['jewish', 'christian', 'muslim'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/holidays', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM holidays ORDER BY date');
  res.json(rows);
}));

router.post('/holidays', asyncHandler(async (req, res) => {
  const { date, calendarType, name, isEve } = req.body || {};
  if (!ISO_DATE_RE.test(date || '')) return res.status(400).json({ error: 'invalid date' });
  if (!CALENDAR_TYPES.includes(calendarType)) return res.status(400).json({ error: `calendarType must be one of ${CALENDAR_TYPES.join(', ')}` });
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await pool.query(
    'INSERT INTO holidays (date, calendar_type, name, is_eve) VALUES ($1, $2, $3, $4) RETURNING *',
    [date, calendarType, name, Boolean(isEve)]
  );
  res.json(rows[0]);
}));

router.delete('/holidays/:id', asyncHandler(async (req, res) => {
  const del = await pool.query('DELETE FROM holidays WHERE id = $1', [Number(req.params.id)]);
  if (del.rowCount === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

/* ---------- special days ---------- */

router.get('/special-days', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM special_days ORDER BY date');
  res.json(rows);
}));

router.post('/special-days', asyncHandler(async (req, res) => {
  const { date, name } = req.body || {};
  if (!ISO_DATE_RE.test(date || '')) return res.status(400).json({ error: 'invalid date' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO special_days (date, name, created_by) VALUES ($1, $2, $3) RETURNING *',
      [date, name, req.session.systemAdminId]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'a special day already exists on this date' });
    throw err;
  }
}));

router.delete('/special-days/:id', asyncHandler(async (req, res) => {
  const del = await pool.query('DELETE FROM special_days WHERE id = $1', [Number(req.params.id)]);
  if (del.rowCount === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

module.exports = router;
