const db = require('../db');

let schemaReady = false;

async function ensureTeamSchema() {
  if (schemaReady) return;

  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS job_title VARCHAR(120),
      ADD COLUMN IF NOT EXISTS signature_enabled BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS signature_mode VARCHAR(30) NOT NULL DEFAULT 'first_message',
      ADD COLUMN IF NOT EXISTS signature_text VARCHAR(255)
  `);

  await db.query(`
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS sent_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS sent_by_name VARCHAR(255)
  `);

  schemaReady = true;
}

function isAdmin(user) {
  return ['admin', 'owner'].includes(String(user?.role || '').toLowerCase());
}

async function getUserProfile(userId, tenantId) {
  await ensureTeamSchema();
  const result = await db.query(`
    SELECT id, tenant_id, name, email, role, avatar_color, job_title,
           signature_enabled, signature_mode, signature_text, is_active
    FROM users
    WHERE id = $1 AND tenant_id = $2
    LIMIT 1
  `, [userId, tenantId]);
  return result.rows[0] || null;
}

module.exports = { ensureTeamSchema, isAdmin, getUserProfile };
