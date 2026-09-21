// One-time population of the `holidays` table for 2026. Unlike cities/streets there is no single
// authoritative open API for this, so the data is inline here from a mix of a verified source
// (Hebcal's own JSON API, queried directly for unambiguous single dates - for the Jewish dates)
// and general knowledge (Christian, Muslim). The Muslim dates in particular are moon-sighting-
// dependent and can shift by a day depending on local authority - treat this whole table as a
// best-effort starting point the System Admin can correct, not an authoritative religious calendar.
//
// Usage: node scripts/seed-holidays.js
// Safe to re-run: every calendar's rows are deleted and reinserted each run, rather than a plain
// append (this is how an earlier, off-by-one-day version of the Jewish data got corrected in
// place instead of left duplicated alongside the fix - and running it a second time without this
// duplicated the Christian/Muslim rows the first time it was tried).
require('dotenv').config();

const { pool, init } = require('../server/db');

// Jewish: [date, name, isEve]. Second-half-of-2026 dates verified via
// hebcal.com/hebcal?v=1&cfg=json&year=2026... directly (earlier summarized fetches disagreed
// with each other and with the originally-seeded dates, which turned out to be one day early
// for several entries - this raw JSON listing is the ground truth used here).
const JEWISH_HOLIDAYS = [
  ['2026-02-02', "ט\"ו בשבט", false],
  ['2026-03-02', 'ערב פורים', true],
  ['2026-03-03', 'פורים', false],
  ['2026-04-01', 'ערב פסח', true],
  ['2026-04-02', 'פסח - יום ראשון', false],
  ['2026-04-09', 'פסח - יום אחרון', false],
  ['2026-05-21', 'ערב שבועות', true],
  ['2026-05-22', 'שבועות - יום א׳', false],
  ['2026-05-23', 'שבועות - יום ב׳', false],
  ['2026-07-22', 'ערב תשעה באב', true],
  ['2026-07-23', 'תשעה באב', false],
  ['2026-09-11', 'ערב ראש השנה', true],
  ['2026-09-12', 'ראש השנה - יום א׳', false],
  ['2026-09-13', 'ראש השנה - יום ב׳', false],
  ['2026-09-20', 'ערב יום כיפור', true],
  ['2026-09-21', 'יום כיפור', false],
  ['2026-09-25', 'ערב סוכות', true],
  ['2026-09-26', 'סוכות - יום ראשון', false],
  ['2026-10-02', 'הושענא רבה', false],
  ['2026-10-03', 'שמיני עצרת', false],
  ['2026-10-04', 'שמחת תורה', false],
  ['2026-12-04', 'חנוכה - יום ראשון', false]
];

const OTHER_HOLIDAYS = [
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

  const { rowCount } = await pool.query("DELETE FROM holidays WHERE calendar_type = 'jewish'");
  if (rowCount) console.log(`Removed ${rowCount} existing Jewish holiday rows before reseeding`);

  for (const [date, name, isEve] of JEWISH_HOLIDAYS) {
    await pool.query(
      'INSERT INTO holidays (date, calendar_type, name, is_eve) VALUES ($1, $2, $3, $4)',
      [date, 'jewish', name, isEve]
    );
  }
  console.log(`Inserted ${JEWISH_HOLIDAYS.length} Jewish holiday rows for 2026`);

  const { rowCount: otherRemoved } = await pool.query("DELETE FROM holidays WHERE calendar_type IN ('christian', 'muslim')");
  if (otherRemoved) console.log(`Removed ${otherRemoved} existing Christian/Muslim holiday rows before reseeding`);

  for (const [date, calendarType, name] of OTHER_HOLIDAYS) {
    await pool.query('INSERT INTO holidays (date, calendar_type, name) VALUES ($1, $2, $3)', [date, calendarType, name]);
  }
  console.log(`Inserted ${OTHER_HOLIDAYS.length} Christian/Muslim holiday rows for 2026`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
