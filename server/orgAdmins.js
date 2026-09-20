// Shared org_admins update/delete logic, used by both server/routes/systemAdmin.js (System
// Admin can touch either admin_type) and server/routes/orgPortal.js (Org Admin can only touch
// time_admin rows in their own org) - one implementation, two authorization boundaries.
const { pool } = require('./db');
const { hashPassword } = require('./auth');

const ADMIN_TYPES = ['org_admin', 'time_admin'];

async function updateOrgAdmin(orgId, id, { name, email, adminType, subOrgIds, password }) {
  if (!name || !email) return { status: 400, error: 'name and email are required' };
  if (!ADMIN_TYPES.includes(adminType)) {
    return { status: 400, error: `adminType must be one of ${ADMIN_TYPES.join(', ')}` };
  }
  if (adminType === 'time_admin' && (!Array.isArray(subOrgIds) || subOrgIds.length === 0)) {
    return { status: 400, error: 'time_admin requires at least one sub-organization in subOrgIds' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let updated;
    try {
      const { rows } = password
        ? await client.query(
            `UPDATE org_admins SET name = $1, email = $2, admin_type = $3, password_hash = $4
             WHERE id = $5 AND org_id = $6 RETURNING id, email, name, admin_type`,
            [name, email, adminType, await hashPassword(password), Number(id), Number(orgId)]
          )
        : await client.query(
            `UPDATE org_admins SET name = $1, email = $2, admin_type = $3
             WHERE id = $4 AND org_id = $5 RETURNING id, email, name, admin_type`,
            [name, email, adminType, Number(id), Number(orgId)]
          );
      updated = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return { status: 409, error: 'this email is already an admin for this organization' };
      }
      throw err;
    }
    if (!updated) {
      await client.query('ROLLBACK');
      return { status: 404, error: 'not found' };
    }

    await client.query('DELETE FROM org_admin_sub_orgs WHERE org_admin_id = $1', [Number(id)]);
    if (adminType === 'time_admin') {
      const validSubOrgs = await client.query(
        'SELECT id FROM sub_organizations WHERE org_id = $1 AND id = ANY($2::int[])',
        [orgId, subOrgIds]
      );
      if (validSubOrgs.rows.length !== subOrgIds.length) {
        await client.query('ROLLBACK');
        return { status: 400, error: 'one or more subOrgIds do not belong to this organization' };
      }
      for (const subOrgId of subOrgIds) {
        await client.query('INSERT INTO org_admin_sub_orgs (org_admin_id, sub_org_id) VALUES ($1, $2)', [id, subOrgId]);
      }
    }

    await client.query('COMMIT');
    return { data: updated };
  } finally {
    client.release();
  }
}

// `restrictToType`: when set, only a row of that admin_type can be deleted (used to stop an
// Org Admin session from deleting a fellow org_admin row - only System Admin may do that).
async function deleteOrgAdmin(orgId, id, restrictToType) {
  const params = [Number(id), Number(orgId)];
  let query = 'DELETE FROM org_admins WHERE id = $1 AND org_id = $2';
  if (restrictToType) {
    query += ' AND admin_type = $3';
    params.push(restrictToType);
  }
  const del = await pool.query(query, params);
  if (del.rowCount === 0) return { status: 404, error: 'not found' };
  return { data: { ok: true } };
}

module.exports = { updateOrgAdmin, deleteOrgAdmin, ADMIN_TYPES };
