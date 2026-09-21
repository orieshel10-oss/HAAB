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
  ABSENCE_TYPES,
  pad,
  toDateKey,
  nowIso,
  computeMinutes,
  minutesToLabel,
  shiftDateStr,
  dayTypeFromDate,
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

// Every clock-in/out/absence/sheet route below acts on the logged-in employee's own record -
// CLIENT_ID/EMPLOYEE_ID are gone, replaced by req.session.employeeOrgId/employeeId.
app.use(['/api/status', '/api/clock', '/api/absences', '/api/attendance'], requireEmployee);

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

app.get('/api/absences', asyncHandler(async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const { start, end } = monthRange(year, month);
  const { rows } = await pool.query(
    'SELECT date, type, note FROM absences WHERE employee_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date',
    [req.session.employeeId, start, end]
  );
  res.json(rows);
}));

app.post('/api/absences', asyncHandler(async (req, res) => {
  const { date, type, note } = req.body || {};
  if (!date || !ABSENCE_TYPES.includes(type)) {
    return res.status(400).json({ error: `date and type (one of ${ABSENCE_TYPES.join(', ')}) are required` });
  }
  await pool.query(
    `INSERT INTO absences (client_id, employee_id, date, type, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (employee_id, date) DO UPDATE SET type = excluded.type, note = excluded.note`,
    [req.session.employeeOrgId, req.session.employeeId, date, type, note || null]
  );
  res.json({ ok: true });
}));

app.delete('/api/absences/:date', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM absences WHERE employee_id = $1 AND date = $2', [req.session.employeeId, req.params.date]);
  res.json({ ok: true });
}));

app.get('/api/attendance/summary', asyncHandler(async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const { start, end } = monthRange(year, month);
  const events = await fetchEventsPadded(req.session.employeeId, start, end);

  const byDay = {};
  for (const ev of events) {
    const key = toDateKey(ev.ts);
    if (key < start || key > end) continue;
    (byDay[key] = byDay[key] || []).push(ev);
  }
  const result = Object.entries(byDay).map(([date, evs]) => {
    const minutes = computeMinutes(evs);
    return { date, minutes, label: minutesToLabel(minutes) };
  });
  res.json(result);
}));

app.get('/api/attendance/day', asyncHandler(async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date is required' });
  const events = (await fetchEventsPadded(req.session.employeeId, date, date))
    .filter((ev) => toDateKey(ev.ts) === date)
    .map((ev) => ({ id: ev.id, type: ev.type, ts: ev.ts, source: ev.source }));
  const { rows } = await pool.query(
    'SELECT type, note FROM absences WHERE employee_id = $1 AND date = $2',
    [req.session.employeeId, date]
  );
  res.json({ events, absence: rows[0] || null, minutes: computeMinutes(events) });
}));

app.get('/api/attendance/sheet', asyncHandler(async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const { start, end } = monthRange(year, month);

  const rawEvents = await fetchEventsPadded(req.session.employeeId, start, end);
  const byDay = {};
  for (const ev of rawEvents) {
    const key = toDateKey(ev.ts);
    if (key < start || key > end) continue;
    (byDay[key] = byDay[key] || []).push(ev);
  }

  const { rows: absenceRows } = await pool.query(
    'SELECT date, type, note FROM absences WHERE employee_id = $1 AND date BETWEEN $2 AND $3',
    [req.session.employeeId, start, end]
  );
  const absenceMap = {};
  absenceRows.forEach((a) => { absenceMap[a.date] = a; });

  const daysInMonth = new Date(year, month, 0).getDate();
  const totals = { regular: 0, ot125: 0, ot150: 0, shabbat: 0, absenceCounts: {} };
  const days = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${pad(month)}-${pad(d)}`;
    const dayEvents = byDay[ds] || [];
    const minutes = computeMinutes(dayEvents);
    const dayType = dayTypeFromDate(year, month, d);
    const absence = absenceMap[ds] || null;
    // An absence with no clock events has no start/end time to go on - per policy, that
    // means a full day off, credited as a full standard day rather than showing zero hours.
    const split = (absence && minutes === 0)
      ? { regular: standardDayMinutes(dayType), ot125: 0, ot150: 0, shabbat: 0 }
      : splitDayMinutes(minutes, dayType);
    const firstIn = dayEvents.find((e) => e.type === 'in') || null;
    const outs = dayEvents.filter((e) => e.type === 'out');
    const lastOut = outs.length ? outs[outs.length - 1] : null;

    if (absence) totals.absenceCounts[absence.type] = (totals.absenceCounts[absence.type] || 0) + 1;
    totals.regular += split.regular;
    totals.ot125 += split.ot125;
    totals.ot150 += split.ot150;
    totals.shabbat += split.shabbat;

    days.push({
      date: ds,
      weekday: new Date(year, month - 1, d).getDay(),
      dayType,
      firstIn: firstIn ? firstIn.ts : null,
      lastOut: lastOut ? lastOut.ts : null,
      minutes: split,
      absence
    });
  }

  res.json({ days, totals });
}));

app.post('/api/attendance/manual', asyncHandler(async (req, res) => {
  const { date, type, time } = req.body || {};
  if (!date || !time || (type !== 'in' && type !== 'out')) {
    return res.status(400).json({ error: 'date, time and type ("in"|"out") are required' });
  }
  const ts = new Date(`${date}T${time}:00`).toISOString();
  const { rows } = await pool.query(
    'INSERT INTO attendance_events (client_id, employee_id, type, ts, source) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.session.employeeOrgId, req.session.employeeId, type, ts, 'manual']
  );
  res.json({ id: rows[0].id, type, ts });
}));

app.put('/api/attendance/event/:id', asyncHandler(async (req, res) => {
  const { time } = req.body || {};
  if (!time) return res.status(400).json({ error: 'time is required' });
  const { rows } = await pool.query(
    'SELECT ts FROM attendance_events WHERE id = $1 AND employee_id = $2',
    [Number(req.params.id), req.session.employeeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  const dateKey = toDateKey(rows[0].ts);
  const ts = new Date(`${dateKey}T${time}:00`).toISOString();
  await pool.query("UPDATE attendance_events SET ts = $1, source = 'manual' WHERE id = $2", [ts, Number(req.params.id)]);
  res.json({ ok: true, ts });
}));

app.delete('/api/attendance/event/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM attendance_events WHERE id = $1 AND employee_id = $2', [
    Number(req.params.id),
    req.session.employeeId
  ]);
  res.json({ ok: true });
}));

app.delete('/api/attendance/day/:date/events', asyncHandler(async (req, res) => {
  const date = req.params.date;
  const ids = (await fetchEventsPadded(req.session.employeeId, date, date))
    .filter((ev) => toDateKey(ev.ts) === date)
    .map((ev) => ev.id);
  if (ids.length) {
    await pool.query('DELETE FROM attendance_events WHERE employee_id = $1 AND id = ANY($2::int[])', [req.session.employeeId, ids]);
  }
  res.json({ ok: true, deleted: ids.length });
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
