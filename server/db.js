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
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_data_url TEXT;
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
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash TEXT;
    -- id_number is the employee's login username, unique per org once set - partial index so the
    -- legacy single-tenant seed row (no id_number) never conflicts.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_client_id_number ON employees(client_id, id_number) WHERE id_number IS NOT NULL;

    -- Product-level catalog, defined by System Admin (Phase 3: structured form; Phase 4 adds the
    -- AI conversational "expert" flow on top of the same fields).
    CREATE TABLE IF NOT EXISTS attendance_agreements (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      day_standard_minutes INTEGER NOT NULL DEFAULT 480,
      shortened_day_standard_minutes INTEGER NOT NULL DEFAULT 420,
      weekly_rest_day INTEGER NOT NULL DEFAULT 6,
      workdays_per_week INTEGER NOT NULL DEFAULT 6,
      holiday_calendar TEXT NOT NULL DEFAULT 'jewish' CHECK (holiday_calendar IN ('jewish', 'christian', 'muslim', 'none')),
      created_by INTEGER REFERENCES system_admins(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Free-text field stored alongside the structured fields for Phase 4's AI conversational
    -- flow to consume later - not processed/analyzed yet, just captured.
    ALTER TABLE attendance_agreements ADD COLUMN IF NOT EXISTS prompt_text TEXT;

    -- Whitelist: which catalog agreements a given org may actually assign to its employees.
    -- effective_from/effective_until (nullable) further restrict *when* within that whitelisting
    -- the agreement can actually be assigned to an employee - both null means no restriction.
    CREATE TABLE IF NOT EXISTS org_attendance_agreements (
      org_id INTEGER NOT NULL REFERENCES organizations(id),
      agreement_code TEXT NOT NULL REFERENCES attendance_agreements(code),
      PRIMARY KEY (org_id, agreement_code)
    );
    ALTER TABLE org_attendance_agreements ADD COLUMN IF NOT EXISTS effective_from TEXT;
    ALTER TABLE org_attendance_agreements ADD COLUMN IF NOT EXISTS effective_until TEXT;

    ALTER TABLE employees ADD COLUMN IF NOT EXISTS agreement_code TEXT REFERENCES attendance_agreements(code);

    -- Populated once via scripts/seed-holidays.js (inline data, no external API). One row per
    -- observed calendar day, so "is this date a holiday" is a plain existence check.
    CREATE TABLE IF NOT EXISTS holidays (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      calendar_type TEXT NOT NULL CHECK (calendar_type IN ('jewish', 'christian', 'muslim')),
      name TEXT NOT NULL
    );
    ALTER TABLE holidays ADD COLUMN IF NOT EXISTS is_eve BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_holidays_date_calendar ON holidays(date, calendar_type);

    CREATE TABLE IF NOT EXISTS special_days (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_by INTEGER REFERENCES system_admins(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

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
    -- Superseded by the report_types catalog below: type is now validated at the app layer
    -- against that org's whitelist instead of a fixed list baked into a CHECK constraint.
    ALTER TABLE absences DROP CONSTRAINT IF EXISTS absences_type_check;
    -- Superseded entirely by attendance_reports below (kept, not dropped, to avoid a destructive
    -- change to the shared DB over a table that might still hold data worth a look) - the app no
    -- longer reads or writes this table.

    -- The exclusive source for anything entered via the עדכון נוכחות screen: each report (type,
    -- optional entry/exit, optional note) is its own row, independent of real clock-machine
    -- punches (attendance_events, driven only by the home screen's live in/out buttons). A day
    -- can now carry several reports of different types (e.g. half attendance, half sick).
    -- entry_ts/exit_ts are full timestamps (not bare HH:MM) for the same cross-midnight reasons
    -- attendance_events already uses full timestamps - both null only for a whole-day report
    -- with no specific times.
    CREATE TABLE IF NOT EXISTS attendance_reports (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      entry_ts TIMESTAMPTZ,
      exit_ts TIMESTAMPTZ,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_reports_emp_date ON attendance_reports(employee_id, date);

    -- Product-level catalog of reportable attendance/absence types (replaces the old hardcoded
    -- ABSENCE_TYPES list). category drives the sheet's presence/absence/off-site dot color.
    CREATE TABLE IF NOT EXISTS report_types (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('presence', 'absence')),
      created_by INTEGER REFERENCES system_admins(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Org whitelist for report_types, same effective_from/effective_until validity-window
    -- pattern as org_attendance_agreements.
    CREATE TABLE IF NOT EXISTS org_report_types (
      org_id INTEGER NOT NULL REFERENCES organizations(id),
      type_code TEXT NOT NULL REFERENCES report_types(code),
      effective_from TEXT,
      effective_until TEXT,
      PRIMARY KEY (org_id, type_code)
    );
  `);

  // Small fixed catalog (7 rows) - seeded directly here rather than via a standalone script,
  // same precedent as the single special_days row below.
  const REPORT_TYPES = [
    ['vacation', 'חופשה', 'absence'],
    ['sick', 'מחלת עובד', 'absence'],
    ['spouse_sick', 'מחלת בן זוג', 'absence'],
    ['child_sick', 'מחלת ילד', 'absence'],
    ['unpaid', 'היעדרות שלא בתשלום', 'absence'],
    ['conference', 'כנס', 'presence'],
    ['company_event', 'אירוע חברה', 'presence']
  ];
  for (const [code, name, category] of REPORT_TYPES) {
    await pool.query(
      'INSERT INTO report_types (code, name, category) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING',
      [code, name, category]
    );
  }

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM organizations');
  if (rows[0].c === 0) {
    const org = await pool.query("INSERT INTO organizations (name) VALUES ('לקוח ראשון') RETURNING id");
    await pool.query('INSERT INTO employees (client_id, name) VALUES ($1, $2)', [org.rows[0].id, 'עובד ראשי']);
  }

  // A single fixed row the user asked for explicitly (not a bulk external dataset like
  // holidays, hence seeded here rather than via a standalone script).
  await pool.query(
    `INSERT INTO special_days (date, name) VALUES ('2026-10-27', 'יום בחירות')
     ON CONFLICT (date) DO NOTHING`
  );
}

module.exports = { pool, init };
