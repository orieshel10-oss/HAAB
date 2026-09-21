// One-time population of the `holidays` table for 2026. Unlike cities/streets there is no single
// authoritative open API for this, so the data is inline here from a mix of a verified source
// (Hebcal, for the Jewish dates - checked during planning) and general knowledge (Christian,
// Muslim). The Muslim dates in particular are moon-sighting-dependent and can shift by a day
// depending on local authority - treat this whole table as a best-effort starting point the
// System Admin can correct, not an authoritative religious calendar.
//
// Usage: node scripts/seed-holidays.js
require('dotenv').config();

const { pool, init } = require('../server/db');

const HOLIDAYS = [
  // Jewish (dates verified via Hebcal during planning)
  ['2026-02-02', 'jewish', "ט\"ו בשבט"],
  ['2026-03-03', 'jewish', 'פורים'],
  ['2026-04-02', 'jewish', 'פסח - יום ראשון'],
  ['2026-04-08', 'jewish', 'פסח - יום אחרון'],
  ['2026-05-21', 'jewish', 'שבועות'],
  ['2026-07-23', 'jewish', "תשעה באב"],
  ['2026-09-11', 'jewish', 'ראש השנה - יום א׳'],
  ['2026-09-12', 'jewish', 'ראש השנה - יום ב׳'],
  ['2026-09-20', 'jewish', 'יום כיפור'],
  ['2026-09-25', 'jewish', 'סוכות - יום ראשון'],
  ['2026-10-01', 'jewish', 'הושענא רבה'],
  ['2026-10-02', 'jewish', 'שמיני עצרת'],
  ['2026-10-03', 'jewish', 'שמחת תורה'],
  ['2026-12-04', 'jewish', 'חנוכה - יום ראשון'],

  // Christian (general knowledge - Western/Gregorian calendar; Orthodox Christmas added since
  // it's the more commonly observed date among Israel's Christian population)
  ['2026-01-01', 'christian', "New Year's Day"],
  ['2026-01-07', 'christian', 'Orthodox Christmas'],
  ['2026-04-03', 'christian', 'Good Friday'],
  ['2026-04-05', 'christian', 'Easter Sunday'],
  ['2026-04-06', 'christian', 'Easter Monday'],
  ['2026-12-25', 'christian', 'Christmas Day'],
  ['2026-12-26', 'christian', "St. Stephen's Day"],

  // Muslim (approximate - Islamic/Hijri calendar, moon-sighting-dependent, may shift ±1-2 days)
  ['2026-02-18', 'muslim', 'תחילת רמדאן (משוער)'],
  ['2026-03-20', 'muslim', 'עיד אל-פיטר (משוער)'],
  ['2026-05-27', 'muslim', 'עיד אל-אדחא (משוער)'],
  ['2026-06-16', 'muslim', 'ראש השנה המוסלמית (משוער)'],
  ['2026-08-25', 'muslim', "מולד הנביא (משוער)"]
];

async function main() {
  await init();
  for (const [date, calendarType, name] of HOLIDAYS) {
    await pool.query('INSERT INTO holidays (date, calendar_type, name) VALUES ($1, $2, $3)', [date, calendarType, name]);
  }
  console.log(`Inserted ${HOLIDAYS.length} holiday rows for 2026`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
