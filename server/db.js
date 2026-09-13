const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill in your Neon connection string.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS attendance_events (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('in', 'out')),
      ts TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'manual')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_events_emp_ts ON attendance_events(employee_id, ts);

    -- date stays TEXT ('YYYY-MM-DD'), not a native DATE column: node-postgres would hand back
    -- DATE columns as JS Date objects at UTC midnight, which re-serializes to the wrong local
    -- day. Keeping it TEXT preserves the lexical-string date logic used throughout the server.
    CREATE TABLE IF NOT EXISTS absences (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('vacation', 'sick', 'child_sick', 'spouse_sick', 'conference')),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(employee_id, date)
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM clients');
  if (rows[0].c === 0) {
    const client = await pool.query("INSERT INTO clients (name) VALUES ('לקוח ראשון') RETURNING id");
    await pool.query('INSERT INTO employees (client_id, name) VALUES ($1, $2)', [client.rows[0].id, 'עובד ראשי']);
  }
}

module.exports = { pool, init };
