const express = require('express');
const path = require('node:path');
const db = require('./db');
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

// Phase 1: single client / single employee, no auth yet.
const CLIENT_ID = Number(process.env.CLIENT_ID || 1);
const EMPLOYEE_ID = Number(process.env.EMPLOYEE_ID || 1);

function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(endDate).padStart(2, '0')}`;
  return { start, end };
}

// Stored timestamps are UTC while the app deals in local (Israel) calendar dates, so a plain
// UTC-string range can miss/misfile events near local midnight. Fetch a 1-day-padded UTC window
// and let callers group/filter by local toDateKey instead of trusting the UTC date boundary.
function fetchEventsPadded(startDate, endDate) {
  const paddedStart = shiftDateStr(startDate, -1);
  const paddedEnd = shiftDateStr(endDate, 1);
  return db
    .prepare(
      'SELECT id, type, ts, source FROM attendance_events WHERE employee_id = ? AND ts >= ? AND ts <= ? ORDER BY ts'
    )
    .all(EMPLOYEE_ID, `${paddedStart}T00:00:00.000Z`, `${paddedEnd}T23:59:59.999Z`);
}

app.get('/api/status', (req, res) => {
  const last = db
    .prepare('SELECT type, ts FROM attendance_events WHERE employee_id = ? ORDER BY ts DESC LIMIT 1')
    .get(EMPLOYEE_ID);
  res.json({ lastEvent: last || null, isIn: !!last && last.type === 'in' });
});

app.post('/api/clock', (req, res) => {
  const { type } = req.body || {};
  if (type !== 'in' && type !== 'out') {
    return res.status(400).json({ error: 'type must be "in" or "out"' });
  }
  const ts = nowIso();
  db.prepare(
    'INSERT INTO attendance_events (client_id, employee_id, type, ts, source) VALUES (?, ?, ?, ?, ?)'
  ).run(CLIENT_ID, EMPLOYEE_ID, type, ts, 'live');
  res.json({ lastEvent: { type, ts }, isIn: type === 'in' });
});

app.get('/api/absences', (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const { start, end } = monthRange(year, month);
  const rows = db
    .prepare(
      'SELECT date, type, note FROM absences WHERE employee_id = ? AND date BETWEEN ? AND ? ORDER BY date'
    )
    .all(EMPLOYEE_ID, start, end);
  res.json(rows);
});

app.post('/api/absences', (req, res) => {
  const { date, type, note } = req.body || {};
  if (!date || !ABSENCE_TYPES.includes(type)) {
    return res.status(400).json({ error: `date and type (one of ${ABSENCE_TYPES.join(', ')}) are required` });
  }
  db.prepare(
    `INSERT INTO absences (client_id, employee_id, date, type, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, date) DO UPDATE SET type = excluded.type, note = excluded.note`
  ).run(CLIENT_ID, EMPLOYEE_ID, date, type, note || null);
  res.json({ ok: true });
});

app.delete('/api/absences/:date', (req, res) => {
  db.prepare('DELETE FROM absences WHERE employee_id = ? AND date = ?').run(EMPLOYEE_ID, req.params.date);
  res.json({ ok: true });
});

app.get('/api/attendance/summary', (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const { start, end } = monthRange(year, month);
  const events = fetchEventsPadded(start, end);

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
});

app.get('/api/attendance/day', (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date is required' });
  const events = fetchEventsPadded(date, date)
    .filter((ev) => toDateKey(ev.ts) === date)
    .map((ev) => ({ id: ev.id, type: ev.type, ts: ev.ts, source: ev.source }));
  const absence = db
    .prepare('SELECT type, note FROM absences WHERE employee_id = ? AND date = ?')
    .get(EMPLOYEE_ID, date);
  res.json({ events, absence: absence || null, minutes: computeMinutes(events) });
});

app.get('/api/attendance/sheet', (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const { start, end } = monthRange(year, month);

  const rawEvents = fetchEventsPadded(start, end);
  const byDay = {};
  for (const ev of rawEvents) {
    const key = toDateKey(ev.ts);
    if (key < start || key > end) continue;
    (byDay[key] = byDay[key] || []).push(ev);
  }

  const absenceRows = db
    .prepare('SELECT date, type, note FROM absences WHERE employee_id = ? AND date BETWEEN ? AND ?')
    .all(EMPLOYEE_ID, start, end);
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
});

app.post('/api/attendance/manual', (req, res) => {
  const { date, type, time } = req.body || {};
  if (!date || !time || (type !== 'in' && type !== 'out')) {
    return res.status(400).json({ error: 'date, time and type ("in"|"out") are required' });
  }
  const ts = new Date(`${date}T${time}:00`).toISOString();
  const id = db
    .prepare(
      'INSERT INTO attendance_events (client_id, employee_id, type, ts, source) VALUES (?, ?, ?, ?, ?)'
    )
    .run(CLIENT_ID, EMPLOYEE_ID, type, ts, 'manual').lastInsertRowid;
  res.json({ id, type, ts });
});

app.put('/api/attendance/event/:id', (req, res) => {
  const { time } = req.body || {};
  if (!time) return res.status(400).json({ error: 'time is required' });
  const ev = db
    .prepare('SELECT ts FROM attendance_events WHERE id = ? AND employee_id = ?')
    .get(Number(req.params.id), EMPLOYEE_ID);
  if (!ev) return res.status(404).json({ error: 'not found' });
  const dateKey = toDateKey(ev.ts);
  const ts = new Date(`${dateKey}T${time}:00`).toISOString();
  db.prepare("UPDATE attendance_events SET ts = ?, source = 'manual' WHERE id = ?").run(
    ts,
    Number(req.params.id)
  );
  res.json({ ok: true, ts });
});

app.delete('/api/attendance/event/:id', (req, res) => {
  db.prepare('DELETE FROM attendance_events WHERE id = ? AND employee_id = ?').run(
    Number(req.params.id),
    EMPLOYEE_ID
  );
  res.json({ ok: true });
});

app.delete('/api/attendance/day/:date/events', (req, res) => {
  const date = req.params.date;
  const ids = fetchEventsPadded(date, date)
    .filter((ev) => toDateKey(ev.ts) === date)
    .map((ev) => ev.id);
  const del = db.prepare('DELETE FROM attendance_events WHERE id = ? AND employee_id = ?');
  ids.forEach((id) => del.run(id, EMPLOYEE_ID));
  res.json({ ok: true, deleted: ids.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance app listening on http://localhost:${PORT}`);
});
