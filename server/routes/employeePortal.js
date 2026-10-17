const express = require('express');
const { pool } = require('../db');
const { verifyPassword, requireEmployee, sanitizeIdentifier } = require('../auth');
const {
  listApprovals,
  assertEmployeeInScope,
  approveDay,
  rejectDay,
  approveAllPending,
  unrejectDay,
  getEmployeeDay,
  createReport,
  findReportEmployee,
  updateReport,
  deleteReport
} = require('../approvals');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Public: used by the org-select screen to confirm the code belongs to a real org and show its
// branding before asking for personal credentials. Deliberately reveals the org name/logo for
// any valid code (unlike admin logins) - that confirmation is the whole point of this screen.
router.get('/organizations/:code', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, logo_data_url FROM organizations WHERE org_code = $1',
    [sanitizeIdentifier(req.params.code)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'org not found' });
  res.json({ id: rows[0].id, name: rows[0].name, logoDataUrl: rows[0].logo_data_url });
}));

router.post('/login', asyncHandler(async (req, res) => {
  let { orgCode, idNumber, password } = req.body || {};
  if (!orgCode || !idNumber || !password) {
    return res.status(400).json({ error: 'orgCode, idNumber and password are required' });
  }
  orgCode = sanitizeIdentifier(orgCode);
  idNumber = sanitizeIdentifier(idNumber);
  password = sanitizeIdentifier(password);
  const orgRes = await pool.query('SELECT id FROM organizations WHERE org_code = $1', [orgCode]);
  const org = orgRes.rows[0];
  // Generic error whether the org code, id number or password is wrong - same reasoning as the
  // admin logins: don't confirm which part a guesser got right.
  if (!org) return res.status(401).json({ error: 'invalid credentials' });

  const { rows } = await pool.query(
    'SELECT * FROM employees WHERE client_id = $1 AND id_number = $2',
    [org.id, idNumber]
  );
  const employee = rows[0];
  if (!employee || !employee.password_hash || !(await verifyPassword(password, employee.password_hash))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (employee.employment_start_date && employee.employment_start_date > today) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (employee.employment_end_date && employee.employment_end_date < today) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  req.session.employeeId = employee.id;
  req.session.employeeOrgId = employee.client_id;
  delete req.session.systemAdminId;
  delete req.session.enteredOrgId;
  delete req.session.orgAdminId;
  // A personally-installed PWA an employee expects to just stay open, not a shared admin
  // console - keep them signed in far longer than the 8h admin default.
  req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

  res.json({ ok: true, firstName: employee.first_name, lastName: employee.last_name });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// The org's currently-valid (whitelisted + within its date window) report types, for the
// update-attendance dropdown and the sheet's presence/absence/off-site dot color.
router.get('/report-types', requireEmployee, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT rt.code, rt.name, rt.category
     FROM report_types rt
     JOIN org_report_types ort ON ort.type_code = rt.code
     WHERE ort.org_id = $1
       AND (ort.effective_from IS NULL OR ort.effective_from <= to_char(now(), 'YYYY-MM-DD'))
       AND (ort.effective_until IS NULL OR ort.effective_until >= to_char(now(), 'YYYY-MM-DD'))
     ORDER BY rt.name`,
    [req.session.employeeOrgId]
  );
  res.json(rows);
}));

router.get('/me', requireEmployee, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.first_name, e.last_name, o.name AS org_name
     FROM employees e JOIN organizations o ON o.id = e.client_id
     WHERE e.id = $1`,
    [req.session.employeeId]
  );
  if (!rows[0]) return res.status(401).json({ error: 'not authenticated' });
  res.json({
    id: req.session.employeeId,
    firstName: rows[0].first_name,
    lastName: rows[0].last_name,
    orgName: rows[0].org_name
  });
}));

// Phase 4e: a person who is both an employee and an Org/Time Admin (linked explicitly via
// org_admins.employee_id, set in org-admins.html) logs in exactly like any other employee, but
// additionally gets the attendance-approval screen inside the employee PWA itself - no separate
// login step, no TOTP prompt (the employee password already proved who they are). An Org/Time
// Admin with no linked employee record is unaffected and still only reachable via the separate
// web admin login (org-login.html, email+password+TOTP). Used by the home screen to decide
// whether to show the "אישור דיווחים" menu item at all.
router.get('/admin-link', requireEmployee, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT email, admin_type FROM org_admins WHERE employee_id = $1',
    [req.session.employeeId]
  );
  if (!rows[0]) return res.json({ linked: false });
  res.json({ linked: true, adminType: rows[0].admin_type, email: rows[0].email });
}));

// Resolves the org context (orgId + sub-org scope for a time_admin) from the org_admins row
// linked to the logged-in employee, exactly like resolveOrgContext (server/auth.js) does for a
// real admin session - but here derived from an employee session, and scoped to approvals only
// (not full org-admin API access) since that's all this link is meant to grant.
async function resolveLinkedAdminContext(req) {
  const { rows } = await pool.query(
    'SELECT id, org_id, name, admin_type FROM org_admins WHERE employee_id = $1',
    [req.session.employeeId]
  );
  const admin = rows[0];
  if (!admin) return null;
  let subOrgRestriction = null;
  if (admin.admin_type === 'time_admin') {
    const subRows = await pool.query('SELECT sub_org_id FROM org_admin_sub_orgs WHERE org_admin_id = $1', [admin.id]);
    subOrgRestriction = subRows.rows.map((r) => r.sub_org_id);
  }
  return { orgId: admin.org_id, subOrgRestriction, reviewer: { role: admin.admin_type, name: admin.name } };
}

router.get('/approvals', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  res.json(await listApprovals({ orgId: ctx.orgId, subOrgRestriction: ctx.subOrgRestriction, year, month }));
}));

router.post('/approvals/approve', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const { employeeId, date } = req.body || {};
  if (!employeeId || !date) return res.status(400).json({ error: 'employeeId and date are required' });
  if (!(await assertEmployeeInScope(employeeId, ctx.orgId, ctx.subOrgRestriction))) return res.status(403).json({ error: 'not authorized' });
  await approveDay(employeeId, date, ctx.reviewer);
  res.json({ ok: true });
}));

router.post('/approvals/reject', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const { employeeId, date, reason } = req.body || {};
  if (!employeeId || !date) return res.status(400).json({ error: 'employeeId and date are required' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason is required' });
  if (!(await assertEmployeeInScope(employeeId, ctx.orgId, ctx.subOrgRestriction))) return res.status(403).json({ error: 'not authorized' });
  await rejectDay(employeeId, date, reason, ctx.reviewer);
  res.json({ ok: true });
}));

router.post('/approvals/approve-all', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const { year, month } = req.body || {};
  if (!year || !month) return res.status(400).json({ error: 'year and month are required' });
  const count = await approveAllPending(
    { orgId: ctx.orgId, subOrgRestriction: ctx.subOrgRestriction, year: Number(year), month: Number(month) },
    ctx.reviewer
  );
  res.json({ ok: true, count });
}));

// Phase 4f: lets a linked employee acting as time_admin/org_admin cancel a rejection, reverting
// the day to pending so it reappears in the approvals list - no employee-facing surface anywhere
// exposes this action (a plain employee session never resolves a ctx here at all).
router.post('/approvals/unreject', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const { employeeId, date } = req.body || {};
  if (!employeeId || !date) return res.status(400).json({ error: 'employeeId and date are required' });
  if (!(await assertEmployeeInScope(employeeId, ctx.orgId, ctx.subOrgRestriction))) return res.status(403).json({ error: 'not authorized' });
  await unrejectDay(employeeId, date);
  res.json({ ok: true });
}));

// Phase 4f: full day editor for a linked employee acting as admin, mirroring the employee's own
// day-panel editor (/api/attendance/day + /api/attendance/reports*) but for a different employee,
// scoped by the linked admin role's org/sub-org permissions. Always writes to attendance_reports -
// raw attendance_events clock punches stay untouched.
router.get('/approvals/day', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const employeeId = Number(req.query.employeeId);
  const date = req.query.date;
  if (!employeeId || !date) return res.status(400).json({ error: 'employeeId and date are required' });
  if (!(await assertEmployeeInScope(employeeId, ctx.orgId, ctx.subOrgRestriction))) return res.status(403).json({ error: 'not authorized' });
  res.json(await getEmployeeDay(employeeId, date));
}));

router.post('/approvals/reports', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const { employeeId } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });
  if (!(await assertEmployeeInScope(employeeId, ctx.orgId, ctx.subOrgRestriction))) return res.status(403).json({ error: 'not authorized' });
  const result = await createReport({ orgId: ctx.orgId, employeeId, body: req.body });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.data);
}));

router.put('/approvals/reports/:id', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const reportId = Number(req.params.id);
  const owner = await findReportEmployee(reportId);
  if (!owner) return res.status(404).json({ error: 'not found' });
  if (!(await assertEmployeeInScope(owner.employee_id, ctx.orgId, ctx.subOrgRestriction))) return res.status(403).json({ error: 'not authorized' });
  const result = await updateReport({ orgId: ctx.orgId, employeeId: owner.employee_id, reportId, body: req.body });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json(result.data);
}));

router.delete('/approvals/reports/:id', requireEmployee, asyncHandler(async (req, res) => {
  const ctx = await resolveLinkedAdminContext(req);
  if (!ctx) return res.status(403).json({ error: 'not authorized' });
  const reportId = Number(req.params.id);
  const owner = await findReportEmployee(reportId);
  if (!owner) return res.status(404).json({ error: 'not found' });
  if (!(await assertEmployeeInScope(owner.employee_id, ctx.orgId, ctx.subOrgRestriction))) return res.status(403).json({ error: 'not authorized' });
  const ok = await deleteReport(reportId, owner.employee_id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

module.exports = router;
