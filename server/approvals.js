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

// Returns { byEmployee: { [employeeId]: { [date]: { summary, totalMinutes } } }, reportDatesByEmployee:
// { [employeeId]: Set<date> } }, built from the same session-pairing pipeline the sheet handler
// itself uses (server/index.js), but without the per-agreement pay-category split - this screen
// reviews what was reported, not computed pay. reportDatesByEmployee lets callers exempt a day
// built entirely from real clock punches (no manual attendance_reports row at all) from needing
// approval - callers decide the actual filtering since that also depends on whether an approval
// row already exists for that day (an edge case: a day rejected while it still had a report that
// was since deleted must stay visible/respected, not silently re-exempted).
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
  const reportDatesByEmployee = {};
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
    reportDatesByEmployee[employeeId] = new Set(empReports.map((r) => r.date));
  }
  return { byEmployee, reportDatesByEmployee };
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

  const { byEmployee, reportDatesByEmployee } = await buildDayEntriesByEmployee(employeeIds, start, end);
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
      // A day built entirely from real clock punches (no manual report) needs no approval and
      // never shows here - unless an approval row already exists for it (an edge case worth
      // staying visible/manageable for, e.g. a rejection made while it still had a report that
      // was since deleted).
      if (!reportDatesByEmployee[employeeId].has(date) && !approval) continue;
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

  const { byEmployee, reportDatesByEmployee } = await buildDayEntriesByEmployee(employeeIds, start, end);
  const { rows: existing } = await pool.query(
    `SELECT employee_id, date, status FROM attendance_approvals
     WHERE employee_id = ANY($1::int[]) AND date BETWEEN $2 AND $3`,
    [employeeIds, start, end]
  );
  const existingByKey = Object.fromEntries(existing.map((a) => [`${a.employee_id}|${a.date}`, a.status]));

  const pendingKeys = new Set();
  for (const employeeId of employeeIds) {
    // Same exemption as listApprovals: a pure-clock day with no existing approval row never
    // needed one, so bulk-approve must not manufacture one for it.
    Object.keys(byEmployee[employeeId] || {})
      .filter((date) => reportDatesByEmployee[employeeId].has(date) || existingByKey[`${employeeId}|${date}`])
      .forEach((date) => pendingKeys.add(`${employeeId}|${date}`));
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

async function unrejectDay(employeeId, date) {
  await pool.query('DELETE FROM attendance_approvals WHERE employee_id = $1 AND date = $2', [employeeId, date]);
}

// Validates a non-'attendance' type against an org's report-types whitelist (same
// effective_from/effective_until window check used throughout the org-scoped routes). Shared by
// the employee's own /api/attendance/reports (server/index.js) and the admin day-editor routes
// below, so the two can never drift on what's a valid type for an org.
async function isReportTypeWhitelisted(orgId, type) {
  const { rows } = await pool.query(
    `SELECT 1 FROM org_report_types
     WHERE org_id = $1 AND type_code = $2
       AND (effective_from IS NULL OR effective_from <= to_char(now(), 'YYYY-MM-DD'))
       AND (effective_until IS NULL OR effective_until >= to_char(now(), 'YYYY-MM-DD'))`,
    [orgId, type]
  );
  return !!rows[0];
}

// entry/exit are bare 'HH:MM'; exitDate is resolved client-side (today or tomorrow, per the
// cross-midnight rule) so this stays a simple date+time-string join, same as attendance_events.
function resolveReportBody(body) {
  const { date, type, entry, exit, exitDate, wholeDay, note } = body || {};
  if (!date || !type) return { error: 'date and type are required' };
  if (type === 'attendance' && wholeDay) return { error: 'wholeDay is not valid for type attendance' };
  if (wholeDay) return { data: { date, type, entryTs: null, exitTs: null, note: note || null } };
  if (!entry) return { error: 'entry is required unless wholeDay is set' };
  const entryTs = new Date(`${date}T${entry}:00`).toISOString();
  const exitTs = exit ? new Date(`${exitDate || date}T${exit}:00`).toISOString() : null;
  return { data: { date, type, entryTs, exitTs, note: note || null } };
}

// Phase 4f: lets an admin (time_admin/org_admin, or a linked-employee session acting as one) view
// and correct an employee's day from the approval screen, mirroring the employee's own
// GET /api/attendance/day (server/index.js) but parameterized instead of session-scoped.
async function getEmployeeDay(employeeId, date) {
  const { rows: events } = await pool.query(
    `SELECT id, type, ts, source FROM attendance_events
     WHERE employee_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts`,
    [employeeId, `${shiftDateStr(date, -1)}T00:00:00.000Z`, `${shiftDateStr(date, 1)}T23:59:59.999Z`]
  );
  const { rows: reports } = await pool.query(
    `SELECT id, type, entry_ts, exit_ts, note FROM attendance_reports
     WHERE employee_id = $1 AND date = $2 ORDER BY entry_ts NULLS FIRST, created_at`,
    [employeeId, date]
  );
  return {
    events: events.filter((e) => toDateKey(e.ts) === date).map((e) => ({ id: e.id, type: e.type, ts: e.ts, source: e.source })),
    reports: reports.map((r) => ({ id: r.id, type: r.type, entryTs: r.entry_ts, exitTs: r.exit_ts, note: r.note }))
  };
}

async function createReport({ orgId, employeeId, body }) {
  const resolved = resolveReportBody(body);
  if (resolved.error) return { error: resolved.error };
  const d = resolved.data;
  if (d.type !== 'attendance' && !(await isReportTypeWhitelisted(orgId, d.type))) {
    return { error: 'type is not enabled for this organization' };
  }
  const { rows } = await pool.query(
    `INSERT INTO attendance_reports (client_id, employee_id, date, type, entry_ts, exit_ts, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, type, entry_ts, exit_ts, note`,
    [orgId, employeeId, d.date, d.type, d.entryTs, d.exitTs, d.note]
  );
  const r = rows[0];
  return { data: { id: r.id, type: r.type, entryTs: r.entry_ts, exitTs: r.exit_ts, note: r.note } };
}

// Looks up the report's own employee_id first so the caller can scope-check it (e.g. against a
// time_admin's sub-org restriction) before this ever touches the row.
async function findReportEmployee(reportId) {
  const { rows } = await pool.query('SELECT employee_id, client_id FROM attendance_reports WHERE id = $1', [reportId]);
  return rows[0] || null;
}

async function updateReport({ orgId, employeeId, reportId, body }) {
  const resolved = resolveReportBody(body);
  if (resolved.error) return { error: resolved.error };
  const d = resolved.data;
  if (d.type !== 'attendance' && !(await isReportTypeWhitelisted(orgId, d.type))) {
    return { error: 'type is not enabled for this organization' };
  }
  const { rows } = await pool.query(
    `UPDATE attendance_reports SET date=$1, type=$2, entry_ts=$3, exit_ts=$4, note=$5
     WHERE id = $6 AND employee_id = $7
     RETURNING id, type, entry_ts, exit_ts, note`,
    [d.date, d.type, d.entryTs, d.exitTs, d.note, reportId, employeeId]
  );
  if (!rows[0]) return { error: 'not found', status: 404 };
  const r = rows[0];
  return { data: { id: r.id, type: r.type, entryTs: r.entry_ts, exitTs: r.exit_ts, note: r.note } };
}

async function deleteReport(reportId, employeeId) {
  const del = await pool.query('DELETE FROM attendance_reports WHERE id = $1 AND employee_id = $2', [reportId, employeeId]);
  return del.rowCount > 0;
}

module.exports = {
  monthRange,
  employeesInScope,
  buildDayEntriesByEmployee,
  assertEmployeeInScope,
  listApprovals,
  approveDay,
  rejectDay,
  approveAllPending,
  unrejectDay,
  isReportTypeWhitelisted,
  resolveReportBody,
  getEmployeeDay,
  createReport,
  findReportEmployee,
  updateReport,
  deleteReport
};
