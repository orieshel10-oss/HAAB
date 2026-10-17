// Shared attendance-approval logic (Phase 4d), used by both server/routes/orgPortal.js (the
// web admin screen) and server/routes/employeePortal.js (the same functionality surfaced inside
// the employee PWA for an employee who is also linked to an org_admin/time_admin row - Phase 4e
// follow-up). One implementation so "what counts as a day with attendance" and the approve/reject
// write paths can never drift between the two entry points.
const { pool } = require('./db');
const { pairSessions, groupSessionsIntoRows, shiftDateStr, toDateKey, pad } = require('./attendance');

function monthRange(year, month) {
  const start = `${year}-${pad(month)}-01`;
  const end = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;
  return { start, end };
}

// Employees a given org context is allowed to see - same scope rule GET /employees already uses.
async function employeesInScope(orgId, subOrgRestriction) {
  const params = [orgId];
  let query = `SELECT id, name, first_name, last_name FROM employees WHERE client_id = $1`;
  if (subOrgRestriction) {
    query += ' AND sub_org_id = ANY($2::int[])';
    params.push(subOrgRestriction);
  }
  const { rows } = await pool.query(query, params);
  return rows;
}

function fmtTimeIL(ts) {
  return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
}

// Returns { [employeeId]: { [date]: { summary, totalMinutes } } }, built from the same
// session-pairing pipeline the sheet handler itself uses (server/index.js), but without the
// per-agreement pay-category split - this screen reviews what was reported, not computed pay.
async function buildDayEntriesByEmployee(employeeIds, start, end) {
  const paddedStart = shiftDateStr(start, -1);
  const paddedEnd = shiftDateStr(end, 1);
  const { rows: events } = await pool.query(
    `SELECT employee_id, type, ts FROM attendance_events
     WHERE employee_id = ANY($1::int[]) AND ts >= $2 AND ts <= $3 ORDER BY employee_id, ts`,
    [employeeIds, `${paddedStart}T00:00:00.000Z`, `${paddedEnd}T23:59:59.999Z`]
  );
  const { rows: reports } = await pool.query(
    `SELECT employee_id, date, type, entry_ts, exit_ts FROM attendance_reports
     WHERE employee_id = ANY($1::int[]) AND date BETWEEN $2 AND $3`,
    [employeeIds, start, end]
  );

  const byEmployee = {};
  for (const employeeId of employeeIds) {
    const empEvents = events.filter((e) => e.employee_id === employeeId);
    const empReports = reports.filter((r) => r.employee_id === employeeId);
    const clockSessions = pairSessions(empEvents).map((s) => ({ ...s, type: 'attendance' }));
    const timedReports = empReports
      .filter((r) => r.entry_ts && r.exit_ts)
      .map((r) => ({ inTs: r.entry_ts, outTs: r.exit_ts, type: r.type }));
    const allSessions = [...clockSessions, ...timedReports]
      .filter((s) => { const key = toDateKey(s.inTs); return key >= start && key <= end; })
      .sort((a, b) => new Date(a.inTs) - new Date(b.inTs));
    const groups = groupSessionsIntoRows(allSessions);

    const byDate = {};
    for (const group of groups) {
      const totalMinutes = group.sessions.reduce((sum, s) => sum + (new Date(s.outTs) - new Date(s.inTs)) / 60000, 0);
      const summary = group.sessions.map((s) => ({ type: s.type, timeLabel: `${fmtTimeIL(s.inTs)}-${fmtTimeIL(s.outTs)}` }));
      byDate[group.date] = { summary, totalMinutes: Math.round(totalMinutes) };
    }
    // Whole-day reports (no entry_ts) have no session/time to show - listed with a "יום שלם" label.
    empReports.filter((r) => !r.entry_ts).forEach((r) => {
      const entry = byDate[r.date] || { summary: [], totalMinutes: 0 };
      entry.summary.push({ type: r.type, timeLabel: 'יום שלם' });
      byDate[r.date] = entry;
    });
    byEmployee[employeeId] = byDate;
  }
  return byEmployee;
}

async function assertEmployeeInScope(employeeId, orgId, subOrgRestriction) {
  const { rows } = await pool.query('SELECT id FROM employees WHERE id = $1 AND client_id = $2', [employeeId, orgId]);
  if (!rows[0]) return false;
  if (!subOrgRestriction) return true;
  const { rows: subRows } = await pool.query('SELECT sub_org_id FROM employees WHERE id = $1', [employeeId]);
  return subRows[0] && subOrgRestriction.includes(subRows[0].sub_org_id);
}

async function listApprovals({ orgId, subOrgRestriction, year, month }) {
  const { start, end } = monthRange(year, month);
  const employees = await employeesInScope(orgId, subOrgRestriction);
  if (!employees.length) return [];
  const employeeIds = employees.map((e) => e.id);
  const nameById = Object.fromEntries(employees.map((e) => [e.id, [e.first_name, e.last_name].filter(Boolean).join(' ') || e.name]));

  const byEmployee = await buildDayEntriesByEmployee(employeeIds, start, end);
  const { rows: approvals } = await pool.query(
    `SELECT employee_id, date, status, rejection_reason, reviewed_by_name, reviewed_at FROM attendance_approvals
     WHERE employee_id = ANY($1::int[]) AND date BETWEEN $2 AND $3`,
    [employeeIds, start, end]
  );
  const approvalByKey = Object.fromEntries(approvals.map((a) => [`${a.employee_id}|${a.date}`, a]));

  const results = [];
  for (const employeeId of employeeIds) {
    for (const [date, entry] of Object.entries(byEmployee[employeeId] || {})) {
      const approval = approvalByKey[`${employeeId}|${date}`];
      results.push({
        employeeId,
        employeeName: nameById[employeeId],
        date,
        summary: entry.summary,
        totalMinutes: entry.totalMinutes,
        status: approval ? approval.status : 'pending',
        rejectionReason: approval ? approval.rejection_reason : null,
        reviewedByName: approval ? approval.reviewed_by_name : null,
        reviewedAt: approval ? approval.reviewed_at : null
      });
    }
  }
  results.sort((a, b) => (a.date === b.date ? a.employeeName.localeCompare(b.employeeName, 'he') : a.date.localeCompare(b.date)));
  return results;
}

async function approveDay(employeeId, date, reviewer) {
  await pool.query(
    `INSERT INTO attendance_approvals (employee_id, date, status, rejection_reason, reviewed_by_role, reviewed_by_name, reviewed_at)
     VALUES ($1, $2, 'approved', NULL, $3, $4, now())
     ON CONFLICT (employee_id, date) DO UPDATE SET status = 'approved', rejection_reason = NULL,
       reviewed_by_role = $3, reviewed_by_name = $4, reviewed_at = now()`,
    [employeeId, date, reviewer.role, reviewer.name]
  );
}

async function rejectDay(employeeId, date, reason, reviewer) {
  await pool.query(
    `INSERT INTO attendance_approvals (employee_id, date, status, rejection_reason, reviewed_by_role, reviewed_by_name, reviewed_at)
     VALUES ($1, $2, 'rejected', $3, $4, $5, now())
     ON CONFLICT (employee_id, date) DO UPDATE SET status = 'rejected', rejection_reason = $3,
       reviewed_by_role = $4, reviewed_by_name = $5, reviewed_at = now()`,
    [employeeId, date, reason.trim(), reviewer.role, reviewer.name]
  );
}

// Never overwrites an existing 'approved' or 'rejected' row - bulk action is additive-approve only.
async function approveAllPending({ orgId, subOrgRestriction, year, month }, reviewer) {
  const employees = await employeesInScope(orgId, subOrgRestriction);
  if (!employees.length) return 0;
  const { start, end } = monthRange(year, month);
  const employeeIds = employees.map((e) => e.id);

  const byEmployee = await buildDayEntriesByEmployee(employeeIds, start, end);
  const { rows: existing } = await pool.query(
    `SELECT employee_id, date, status FROM attendance_approvals
     WHERE employee_id = ANY($1::int[]) AND date BETWEEN $2 AND $3`,
    [employeeIds, start, end]
  );
  const existingByKey = Object.fromEntries(existing.map((a) => [`${a.employee_id}|${a.date}`, a.status]));

  const pendingKeys = new Set();
  for (const employeeId of employeeIds) {
    Object.keys(byEmployee[employeeId] || {}).forEach((date) => pendingKeys.add(`${employeeId}|${date}`));
  }

  let count = 0;
  for (const key of pendingKeys) {
    if (existingByKey[key] === 'approved' || existingByKey[key] === 'rejected') continue;
    const [employeeId, date] = key.split('|');
    await approveDay(Number(employeeId), date, reviewer);
    count += 1;
  }
  return count;
}

module.exports = {
  monthRange,
  employeesInScope,
  buildDayEntriesByEmployee,
  assertEmployeeInScope,
  listApprovals,
  approveDay,
  rejectDay,
  approveAllPending
};
