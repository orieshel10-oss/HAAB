// Shared org_admins CRUD logic, used by both server/routes/systemAdmin.js (System Admin can
// touch either admin_type) and server/routes/orgPortal.js (Org Admin can only touch time_admin
// rows in their own org) - one implementation, two authorization boundaries.
const { pool } = require('./db');
const { hashPassword, generateTotpSecret, totpEnrollUri } = require('./auth');

const ADMIN_TYPES = ['org_admin', 'time_admin'];

async function listOrgAdmins(orgId) {
  const { rows: admins } = await pool.query(
    `SELECT id, email, name, admin_type, created_at FROM org_admins WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId]
  );
  const { rows: subOrgLinks } = await pool.query(
    `SELECT oas.org_admin_id, so.id AS sub_org_id, so.sub_org_code, so.name
     FROM org_admin_sub_orgs oas
     JOIN sub_organizations so ON so.id = oas.sub_org_id
     WHERE oas.org_admin_id = ANY($1::int[])`,
    [admins.map((a) => a.id)]
  );
  const byAdmin = {};
  subOrgLinks.forEach((l) => { (byAdmin[l.org_admin_id] = byAdmin[l.org_admin_id] || []).push({ id: l.sub_org_id, code: l.sub_org_code, name: l.name }); });
  return admins.map((a) => ({ ...a, subOrganizations: byAdmin[a.id] || [] }));
}

// `restrictToType`: when set, the created row can only be of that admin_type (used to stop an
// Org Admin session from creating a fellow org_admin row - only System Admin may do that).
async function createOrgAdmin(orgId, { email, name, password, adminType, subOrgIds }, restrictToType) {
  if (!email || !name || !password) {
    return { status: 400, error: 'email, name and password are required' };
  }
  if (!ADMIN_TYPES.includes(adminType)) {
    return { status: 400, error: `adminType must be one of ${ADMIN_TYPES.join(', ')}` };
  }
  if (restrictToType && adminType !== restrictToType) {
    return { status: 403, error: 'not authorized to create this admin type' };
  }
  if (adminType === 'time_admin' && (!Array.isArray(subOrgIds) || subOrgIds.length === 0)) {
    return { status: 400, error: 'time_admin requires at least one sub-organization in subOrgIds' };
  }

  const passwordHash = await hashPassword(password);
  const totpSecret = generateTotpSecret();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let created;
    try {
      const { rows } = await client.query(
        `INSERT INTO org_admins (org_id, email, name, password_hash, totp_secret, admin_type)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name, admin_type`,
        [orgId, email, name, passwordHash, totpSecret, adminType]
      );
      created = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return { status: 409, error: 'this email is already an admin for this organization' };
      }
      throw err;
    }

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
        await client.query('INSERT INTO org_admin_sub_orgs (org_admin_id, sub_org_id) VALUES ($1, $2)', [created.id, subOrgId]);
      }
    }

    await client.query('COMMIT');
    // Label includes role + org code: the same email can end up as a System Admin AND an Org/Time
    // Admin (or an admin in more than one org), and without this the entries look identical in
    // an authenticator app - easy to enroll the wrong one and get "invalid code" forever after.
    const orgRow = await pool.query('SELECT org_code FROM organizations WHERE id = $1', [orgId]);
    const roleLabel = adminType === 'time_admin' ? 'Time Admin' : 'Org Admin';
    const label = `${email} (${roleLabel} ${orgRow.rows[0] ? orgRow.rows[0].org_code : orgId})`;
    return { data: { ...created, totpEnrollUri: totpEnrollUri(totpSecret, label) } };
  } finally {
    client.release();
  }
}

// `restrictToType`: when set, only a row currently of that admin_type may be updated, and the
// update may not change adminType away from it (used to stop an Org Admin session from touching
// or repurposing a fellow org_admin row - only System Admin may do that).
async function updateOrgAdmin(orgId, id, { name, email, adminType, subOrgIds, password }, restrictToType) {
  if (!name || !email) return { status: 400, error: 'name and email are required' };
  if (!ADMIN_TYPES.includes(adminType)) {
    return { status: 400, error: `adminType must be one of ${ADMIN_TYPES.join(', ')}` };
  }
  if (restrictToType && adminType !== restrictToType) {
    return { status: 403, error: 'not authorized to set this admin type' };
  }
  if (adminType === 'time_admin' && (!Array.isArray(subOrgIds) || subOrgIds.length === 0)) {
    return { status: 400, error: 'time_admin requires at least one sub-organization in subOrgIds' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (restrictToType) {
      const current = await client.query('SELECT admin_type FROM org_admins WHERE id = $1 AND org_id = $2', [Number(id), Number(orgId)]);
      if (!current.rows[0] || current.rows[0].admin_type !== restrictToType) {
        await client.query('ROLLBACK');
        return { status: current.rows[0] ? 403 : 404, error: current.rows[0] ? 'not authorized' : 'not found' };
      }
    }
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

module.exports = { listOrgAdmins, createOrgAdmin, updateOrgAdmin, deleteOrgAdmin, ADMIN_TYPES };
