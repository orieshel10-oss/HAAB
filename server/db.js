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
    -- "clients" is the pre-multi-tenant name for what is now "organizations". Rename in place
    -- (idempotent: a no-op once organizations exists) so existing data/FKs carry over untouched.
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'clients')
         AND NOT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'organizations') THEN
        ALTER TABLE clients RENAME TO organizations;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS org_code TEXT UNIQUE;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_reg_number TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_file_income TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_file_bituach_leumi TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_first_name TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_last_name TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_email TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_mobile TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS payment_card_last4 TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS payment_card_holder_name TEXT;
    -- Superseded: entering an org now re-checks the System Admin's own login password
    -- (step-up auth) instead of a separate per-org secret.
    ALTER TABLE organizations DROP COLUMN IF EXISTS org_entry_password_hash;

    CREATE TABLE IF NOT EXISTS sub_organizations (
      id SERIAL PRIMARY KEY,
      sub_org_code TEXT NOT NULL UNIQUE,
      org_id INTEGER NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      business_reg_number TEXT,
      tax_file_income TEXT,
      tax_file_bituach_leumi TEXT,
      contact_first_name TEXT,
      contact_last_name TEXT,
      contact_email TEXT,
      contact_mobile TEXT,
      payment_card_last4 TEXT,
      payment_card_holder_name TEXT,
      sub_org_type TEXT NOT NULL CHECK (sub_org_type IN ('factory_unit', 'division', 'department')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Seeded once via scripts/seed-root-admin.js (direct DB access), never through the app's own
    -- UI. is_root protects that one row: application code must refuse to delete it.
    CREATE TABLE IF NOT EXISTS system_admins (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      totp_secret TEXT,
      is_root BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS org_admins (
      id SERIAL PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES organizations(id),
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      totp_secret TEXT,
      admin_type TEXT NOT NULL CHECK (admin_type IN ('org_admin', 'time_admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(org_id, email)
    );

    -- Required (enforced at the API layer) for every admin_type='time_admin' row: which
    -- sub-organizations they're authorized to see/approve attendance for.
    CREATE TABLE IF NOT EXISTS org_admin_sub_orgs (
      org_admin_id INTEGER NOT NULL REFERENCES org_admins(id) ON DELETE CASCADE,
      sub_org_id INTEGER NOT NULL REFERENCES sub_organizations(id) ON DELETE CASCADE,
      PRIMARY KEY (org_admin_id, sub_org_id)
    );

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Forward reference for the sub-organization delete guard (Phase 1) even though the full
    -- employee management screens land in Phase 2 - keeps that guard real/testable once they do.
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS sub_org_id INTEGER REFERENCES sub_organizations(id);
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS id_number TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS id_type TEXT NOT NULL DEFAULT 'israeli_id' CHECK (id_type IN ('israeli_id', 'passport'));
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name_en TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name_en TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS mobile TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS city_code INTEGER;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS street TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS house_number TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS apartment TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS entrance TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS zip_code TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_start_date TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_end_date TEXT;

    -- Populated once via scripts/seed-streets.js from the official data.gov.il dataset (~51k
    -- rows), not on every boot. A street code is only unique within its city, hence the
    -- composite key.
    CREATE TABLE IF NOT EXISTS streets (
      city_code INTEGER NOT NULL,
      street_code INTEGER NOT NULL,
      name_he TEXT NOT NULL,
      PRIMARY KEY (city_code, street_code)
    );
    CREATE INDEX IF NOT EXISTS idx_streets_city_name ON streets(city_code, name_he);

    -- Populated once via scripts/seed-cities.js from the official data.gov.il dataset, not on
    -- every boot (keeps server startup independent of an external network call).
    CREATE TABLE IF NOT EXISTS cities (
      code INTEGER PRIMARY KEY,
      name_he TEXT NOT NULL,
      name_en TEXT,
      district TEXT
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

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM organizations');
  if (rows[0].c === 0) {
    const org = await pool.query("INSERT INTO organizations (name) VALUES ('לקוח ראשון') RETURNING id");
    await pool.query('INSERT INTO employees (client_id, name) VALUES ($1, $2)', [org.rows[0].id, 'עובד ראשי']);
  }
}

module.exports = { pool, init };
