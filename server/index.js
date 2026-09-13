const express = require('express');
const path = require('node:path');
const db = require('./db');
const { toDateKey, nowIso, computeMinutes, minutesToLabel } = require('./attendance');

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
  if (!date || (type !== 'vacation' && type !== 'sick')) {
    return res.status(400).json({ error: 'date and type ("vacation"|"sick") are required' });
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
  const events = db
    .prepare(
      'SELECT type, ts FROM attendance_events WHERE employee_id = ? AND ts >= ? AND ts < ? ORDER BY ts'
    )
    .all(EMPLOYEE_ID, `${start}T00:00:00.000Z`, `${end}T23:59:59.999Z`);

  const byDay = {};
  for (const ev of events) {
    const key = toDateKey(ev.ts);
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
  const events = db
    .prepare(
      "SELECT id, type, ts, source FROM attendance_events WHERE employee_id = ? AND date(ts) = date(?) ORDER BY ts"
    )
    .all(EMPLOYEE_ID, date);
  const absence = db
    .prepare('SELECT type, note FROM absences WHERE employee_id = ? AND date = ?')
    .get(EMPLOYEE_ID, date);
  res.json({ events, absence: absence || null, minutes: computeMinutes(events) });
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

app.delete('/api/attendance/event/:id', (req, res) => {
  db.prepare('DELETE FROM attendance_events WHERE id = ? AND employee_id = ?').run(
    Number(req.params.id),
    EMPLOYEE_ID
  );
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance app listening on http://localhost:${PORT}`);
});
