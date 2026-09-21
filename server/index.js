// This app's whole notion of a "local date"/"local time" (manual clock entries, day-type/rest-day
// rules, the sheet's day boundaries, cities/streets, everything) is implicitly Israel time - not
// whatever timezone the host machine happens to be in. On Render that's UTC, which silently
// mis-stamped every manual time entry by 2-3 hours (a real bug: a browser reporting "22:00"
// Israel time got stored as 22:00 UTC). Pinning this before any Date object is constructed makes
// Node's local-time interpretation match what the app has always assumed, regardless of host.
process.env.TZ = 'Asia/Jerusalem';

require('dotenv').config();

const express = require('express');
const path = require('node:path');
const session = require('express-session');
const pgSessionStore = require('connect-pg-simple')(session);
const { pool, init } = require('./db');
const systemAdminRouter = require('./routes/systemAdmin');
const orgPortalRouter = require('./routes/orgPortal');
const employeePortalRouter = require('./routes/employeePortal');
const { requireEmployee } = require('./auth');
const {
  pad,
  toDateKey,
  nowIso,
  pairSessions,
  groupSessionsIntoRows,
  shiftDateStr,
  dayTypeFromDate,
  calendarRestDow,
  splitDayMinutes,
  standardDayMinutes
} = require('./attendance');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  store: new pgSessionStore({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  // Render's proxy terminates TLS in front of the app, so `secure: true` here would silently
  // stop the cookie from being set. Keep it false for now; harden this once the deployment's
  // proxy trust is set up deliberately.
  cookie: { maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax', secure: false }
}));

app.use('/api/system', systemAdminRouter);
app.use('/api/org', orgPortalRouter);
app.use('/api/employee', employeePortalRouter);

// Every clock-in/out/reports/sheet route below acts on the logged-in employee's own record -
// CLIENT_ID/EMPLOYEE_ID are gone, replaced by req.session.employeeOrgId/employeeId.
app.use(['/api/status', '/api/clock', '/api/attendance'], requireEmployee);

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(endDate).padStart(2, '0')}`;
  return { start, end };
}

// Stored timestamps are UTC while the app deals in local (Israel) calendar dates, so a plain
// UTC-string range can miss/misfile events near local midnight. Fetch a 1-day-padded UTC window
// and let callers group/filter by local toDateKey instead of trusting the UTC date boundary.
async function fetchEventsPadded(employeeId, startDate, endDate) {
  const paddedStart = shiftDateStr(startDate, -1);
  const paddedEnd = shiftDateStr(endDate, 1);
  const { rows } = await pool.query(
    'SELECT id, type, ts, source FROM attendance_events WHERE employee_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts',
    [employeeId, `${paddedStart}T00:00:00.000Z`, `${paddedEnd}T23:59:59.999Z`]
  );
  return rows;
}

app.get('/api/status', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT type, ts FROM attendance_events WHERE employee_id = $1 ORDER BY ts DESC LIMIT 1',
    [req.session.employeeId]
  );
  const last = rows[0] || null;
  res.json({ lastEvent: last, isIn: !!last && last.type === 'in' });
}));

app.post('/api/clock', asyncHandler(async (req, res) => {
  const { type } = req.body || {};
  if (type !== 'in' && type !== 'out') {
    return res.status(400).json({ error: 'type must be "in" or "out"' });
  }
  const ts = nowIso();
  await pool.query(
    'INSERT INTO attendance_events (client_id, employee_id, type, ts, source) VALUES ($1, $2, $3, $4, $5)',
    [req.session.employeeOrgId, req.session.employeeId, type, ts, 'live']
  );
  res.json({ lastEvent: { type, ts }, isIn: type === 'in' });
}));

// Validates a non-'attendance' type against this org's report-types whitelist (same
// effective_from/effective_until window check used throughout the org-scoped routes).
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

app.get('/api/attendance/day', asyncHandler(async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date is required' });
  const events = (await fetchEventsPadded(req.session.employeeId, date, date))
    .filter((ev) => toDateKey(ev.ts) === date)
    .map((ev) => ({ id: ev.id, type: ev.type, ts: ev.ts, source: ev.source }));
  const { rows: reports } = await pool.query(
    `SELECT id, type, entry_ts, exit_ts, note FROM attendance_reports
     WHERE employee_id = $1 AND date = $2 ORDER BY entry_ts NULLS FIRST, created_at`,
    [req.session.employeeId, date]
  );
  res.json({
    events,
    reports: reports.map((r) => ({ id: r.id, type: r.type, entryTs: r.entry_ts, exitTs: r.exit_ts, note: r.note }))
  });
}));

app.post('/api/attendance/reports', asyncHandler(async (req, res) => {
  const resolved = resolveReportBody(req.body);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const d = resolved.data;
  if (d.type !== 'attendance' && !(await isReportTypeWhitelisted(req.session.employeeOrgId, d.type))) {
    return res.status(400).json({ error: 'type is not enabled for this organization' });
  }
  const { rows } = await pool.query(
    `INSERT INTO attendance_reports (client_id, employee_id, date, type, entry_ts, exit_ts, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, type, entry_ts, exit_ts, note`,
    [req.session.employeeOrgId, req.session.employeeId, d.date, d.type, d.entryTs, d.exitTs, d.note]
  );
  const r = rows[0];
  res.json({ id: r.id, type: r.type, entryTs: r.entry_ts, exitTs: r.exit_ts, note: r.note });
}));

app.put('/api/attendance/reports/:id', asyncHandler(async (req, res) => {
  const resolved = resolveReportBody(req.body);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const d = resolved.data;
  if (d.type !== 'attendance' && !(await isReportTypeWhitelisted(req.session.employeeOrgId, d.type))) {
    return res.status(400).json({ error: 'type is not enabled for this organization' });
  }
  const { rows } = await pool.query(
    `UPDATE attendance_reports SET date=$1, type=$2, entry_ts=$3, exit_ts=$4, note=$5
     WHERE id = $6 AND employee_id = $7
     RETURNING id, type, entry_ts, exit_ts, note`,
    [d.date, d.type, d.entryTs, d.exitTs, d.note, Number(req.params.id), req.session.employeeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  const r = rows[0];
  res.json({ id: r.id, type: r.type, entryTs: r.entry_ts, exitTs: r.exit_ts, note: r.note });
}));

app.delete('/api/attendance/reports/:id', asyncHandler(async (req, res) => {
  const del = await pool.query(
    'DELETE FROM attendance_reports WHERE id = $1 AND employee_id = $2',
    [Number(req.params.id), req.session.employeeId]
  );
  if (del.rowCount === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

app.get('/api/attendance/sheet', asyncHandler(async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const { start, end } = monthRange(year, month);

  // Two independent sources feed the same "sessions" pipeline: real clock-machine punches
  // (attendance_events, tagged type='attendance'/note=null here) and manually-entered reports
  // that have their own time (attendance_reports.entry_ts, carrying their own type/note - a day
  // can now mix e.g. half attendance and half sick). Sessions are attributed to their check-in's
  // own calendar date (so an overnight shift's hours land entirely on the day it started), then
  // merged together chronologically before groupSessionsIntoRows's existing merge rule runs -
  // unrelated to the padded fetch window, which exists purely so a session crossing the month
  // boundary is still visible to the pairing step.
  const rawEvents = await fetchEventsPadded(req.session.employeeId, start, end);
  const clockSessions = pairSessions(rawEvents).map((s) => ({ ...s, type: 'attendance', note: null }));

  const { rows: reportRows } = await pool.query(
    `SELECT date, type, entry_ts, exit_ts, note FROM attendance_reports
     WHERE employee_id = $1 AND date BETWEEN $2 AND $3`,
    [req.session.employeeId, start, end]
  );
  // A report can have an entry with no exit yet (still open - exit unknown), same as a real
  // clock-in with no matching clock-out. Such a session can never enter the merge/duration math
  // below (null outTs there would corrupt the date arithmetic) - it always renders as its own
  // zero-hours row instead, exactly like an unmatched clock-in is already dropped by pairSessions.
  const timedReportSessions = reportRows
    .filter((r) => r.entry_ts && r.exit_ts)
    .map((r) => ({ inTs: r.entry_ts, outTs: r.exit_ts, type: r.type, note: r.note }));
  const openReportsByDate = {};
  reportRows.filter((r) => r.entry_ts && !r.exit_ts).forEach((r) => {
    (openReportsByDate[r.date] = openReportsByDate[r.date] || []).push(r);
  });
  const wholeDayReportsByDate = {};
  reportRows.filter((r) => !r.entry_ts).forEach((r) => {
    (wholeDayReportsByDate[r.date] = wholeDayReportsByDate[r.date] || []).push(r);
  });

  const allSessions = [...clockSessions, ...timedReportSessions]
    .filter((s) => {
      const key = toDateKey(s.inTs);
      return key >= start && key <= end;
    })
    .sort((a, b) => new Date(a.inTs) - new Date(b.inTs));
  const groups = groupSessionsIntoRows(allSessions);

  const rowsByDate = {};
  for (const group of groups) {
    const dayType = dayTypeFromDate(...group.date.split('-').map(Number));
    const totalMinutes = group.sessions.reduce((sum, s) => sum + (new Date(s.outTs) - new Date(s.inTs)) / 60000, 0);
    const split = splitDayMinutes(Math.round(totalMinutes), dayType);
    const rows = group.sessions.map((s, i) => ({
      firstIn: s.inTs,
      lastOut: s.outTs,
      type: s.type,
      note: s.note,
      minutes: i === group.sessions.length - 1 ? split : { regular: 0, ot125: 0, ot150: 0, shabbat: 0 },
      showTotals: i === group.sessions.length - 1
    }));
    (rowsByDate[group.date] = rowsByDate[group.date] || []).push(...rows);
  }
  Object.entries(openReportsByDate).forEach(([ds, reports]) => {
    const openRows = reports.map((r) => ({
      firstIn: r.entry_ts,
      lastOut: null,
      type: r.type,
      note: r.note,
      minutes: { regular: 0, ot125: 0, ot150: 0, shabbat: 0 },
      showTotals: true
    }));
    (rowsByDate[ds] = rowsByDate[ds] || []).push(...openRows);
  });
  Object.entries(wholeDayReportsByDate).forEach(([ds, reports]) => {
    const dayType = dayTypeFromDate(...ds.split('-').map(Number));
    const wholeDayRows = reports.map((r) => ({
      firstIn: null,
      lastOut: null,
      type: r.type,
      note: r.note,
      minutes: { regular: standardDayMinutes(dayType), ot125: 0, ot150: 0, shabbat: 0 },
      showTotals: true
    }));
    (rowsByDate[ds] = rowsByDate[ds] || []).push(...wholeDayRows);
  });

  // Holiday/eve indicators follow the employee's own agreement's linked holiday calendar (no
  // agreement, or holiday_calendar='none', means neither is ever shown).
  const { rows: agreementRows } = await pool.query(
    `SELECT aa.holiday_calendar FROM employees e
     JOIN attendance_agreements aa ON aa.code = e.agreement_code
     WHERE e.id = $1`,
    [req.session.employeeId]
  );
  const holidayCalendar = agreementRows[0] ? agreementRows[0].holiday_calendar : null;
  let holidaySet = new Set();
  let holidayEveSet = new Set();
  if (holidayCalendar && holidayCalendar !== 'none') {
    const { rows: holidayRows } = await pool.query(
      'SELECT date, is_eve FROM holidays WHERE calendar_type = $1 AND date BETWEEN $2 AND $3',
      [holidayCalendar, start, end]
    );
    holidaySet = new Set(holidayRows.filter((h) => !h.is_eve).map((h) => h.date));
    holidayEveSet = new Set(holidayRows.filter((h) => h.is_eve).map((h) => h.date));
  }
  const restDow = calendarRestDow(holidayCalendar);

  const daysInMonth = new Date(year, month, 0).getDate();
  const totals = { regular: 0, ot125: 0, ot150: 0, shabbat: 0, absenceCounts: {} };
  const days = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${pad(month)}-${pad(d)}`;
    const weekday = new Date(year, month - 1, d).getDay();
    const dayType = dayTypeFromDate(year, month, d);
    const isHoliday = holidaySet.has(ds);
    let rows = rowsByDate[ds];
    if (!rows || !rows.length) {
      // No reports or clock sessions that day: a single blank placeholder row keeps the sheet
      // showing every day of the month, not just ones with something reported.
      rows = [{
        firstIn: null,
        lastOut: null,
        type: null,
        note: null,
        minutes: { regular: 0, ot125: 0, ot150: 0, shabbat: 0 },
        showTotals: true
      }];
    }

    rows.forEach((r) => {
      totals.regular += r.minutes.regular;
      totals.ot125 += r.minutes.ot125;
      totals.ot150 += r.minutes.ot150;
      totals.shabbat += r.minutes.shabbat;
      if (r.type && r.type !== 'attendance') totals.absenceCounts[r.type] = (totals.absenceCounts[r.type] || 0) + 1;
    });

    days.push({
      date: ds,
      weekday,
      dayType,
      isHoliday,
      isHolidayEve: holidayEveSet.has(ds),
      isDayOff: weekday === restDow || isHoliday,
      rows
    });
  }

  res.json({ days, totals });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Attendance app listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
