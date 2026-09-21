// One-time population of the `streets` table from the official data.gov.il open-data API
// (~51,500 rows - the Ministry of Interior street list). Paginates the fetch and batches the
// inserts (500 rows/statement) since row-by-row would be far too slow at this size.
//
// Usage: node scripts/seed-streets.js
require('dotenv').config();

const { pool, init } = require('../server/db');

const API_URL = 'https://data.gov.il/api/action/datastore_search';
const RESOURCE_ID = 'a7296d1a-f8c9-4b70-96c2-6ebb4352f8e3';
const PAGE_SIZE = 5000;
const BATCH_SIZE = 500;

async function fetchPage(offset) {
  const url = `${API_URL}?resource_id=${RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`data.gov.il request failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function insertBatch(rows) {
  if (rows.length === 0) return;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * 3;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(r.cityCode, r.streetCode, r.name);
  });
  await pool.query(
    `INSERT INTO streets (city_code, street_code, name_he) VALUES ${values.join(',')}
     ON CONFLICT (city_code, street_code) DO UPDATE SET name_he = excluded.name_he`,
    params
  );
}

async function main() {
  await init();

  let offset = 0;
  let total = null;
  let totalUpserted = 0;
  let batch = [];

  while (total === null || offset < total) {
    const page = await fetchPage(offset);
    total = page.total;
    for (const rec of page.records) {
      const cityCode = rec['סמל_ישוב'];
      const streetCode = rec['סמל_רחוב'];
      const name = (rec['שם_רחוב'] || '').trim();
      if (!cityCode || streetCode == null || !name) continue;
      batch.push({ cityCode, streetCode, name });
      if (batch.length >= BATCH_SIZE) {
        await insertBatch(batch);
        totalUpserted += batch.length;
        batch = [];
      }
    }
    offset += PAGE_SIZE;
    console.log(`Fetched ${Math.min(offset, total)} / ${total}`);
  }
  await insertBatch(batch);
  totalUpserted += batch.length;

  console.log(`Upserted ${totalUpserted} streets`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
