// One-time population of the `cities` table from the official data.gov.il open-data API
// (Ministry of Interior settlements list). Not run automatically on server boot - keeps startup
// independent of an external network call. Safe to re-run: upserts by city code.
//
// Usage: node scripts/seed-cities.js
require('dotenv').config();

const { pool, init } = require('../server/db');

const API_URL = 'https://data.gov.il/api/action/datastore_search';
const RESOURCE_ID = 'b7cf8f14-64a2-4b33-8d4b-edb286fdbd37';

async function fetchAllCities() {
  const url = `${API_URL}?resource_id=${RESOURCE_ID}&limit=1500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`data.gov.il request failed: ${res.status}`);
  const data = await res.json();
  return data.result.records;
}

async function main() {
  await init();
  const records = await fetchAllCities();
  console.log(`Fetched ${records.length} city records from data.gov.il`);

  let count = 0;
  for (const rec of records) {
    const code = rec['סמל_ישוב'];
    const nameHe = (rec['שם_ישוב'] || '').trim();
    const nameEn = (rec['שם_ישוב_לועזי'] || '').trim() || null;
    const district = (rec['שם_נפה'] || '').trim() || null;
    if (!code || !nameHe) continue;
    await pool.query(
      `INSERT INTO cities (code, name_he, name_en, district) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET name_he = excluded.name_he, name_en = excluded.name_en, district = excluded.district`,
      [code, nameHe, nameEn, district]
    );
    count++;
  }
  console.log(`Upserted ${count} cities`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
