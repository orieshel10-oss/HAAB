const express = require('express');
const { pool } = require('../db');
const { verifyPassword, requireEmployee } = require('../auth');

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
    [req.params.code]
  );
  if (!rows[0]) return res.status(404).json({ error: 'org not found' });
  res.json({ id: rows[0].id, name: rows[0].name, logoDataUrl: rows[0].logo_data_url });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { orgCode, idNumber, password } = req.body || {};
  if (!orgCode || !idNumber || !password) {
    return res.status(400).json({ error: 'orgCode, idNumber and password are required' });
  }
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

  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

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

module.exports = router;
