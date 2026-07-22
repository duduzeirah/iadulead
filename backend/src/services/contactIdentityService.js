const db = require('../db');

let schemaReady = false;

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  let phone = digits(String(value || '').split('@')[0]);
  if (!phone) return null;
  if (!phone.startsWith('55') && phone.length <= 11) phone = `55${phone}`;
  return phone;
}

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function identifierType(value) {
  const id = normalizeIdentifier(value);
  if (!id) return null;
  if (id.endsWith('@lid')) return 'lid';
  if (id.endsWith('@s.whatsapp.net')) return 'jid';
  if (id.endsWith('@g.us')) return 'group';
  return id.includes('@') ? 'jid_other' : 'phone';
}

function collectIdentifiers(data = {}) {
  const key = data.key || data.data?.key || {};
  const raw = [
    key.remoteJid,
    key.remoteJidAlt,
    key.participant,
    key.participantAlt,
    data.remoteJid,
    data.remoteJidAlt,
    data.senderPn,
    data.data?.remoteJid,
    data.data?.remoteJidAlt,
    data.data?.senderPn
  ].filter(Boolean).map(normalizeIdentifier);

  const identifiers = [];
  for (const value of raw) {
    const type = identifierType(value);
    if (!type || type === 'group') continue;
    identifiers.push({ type, value });
    const phone = normalizePhone(value);
    if (phone && type !== 'lid') {
      identifiers.push({ type: 'phone', value: phone });
      identifiers.push({ type: 'jid', value: `${phone}@s.whatsapp.net` });
    }
  }

  const seen = new Set();
  return identifiers.filter(item => {
    const compound = `${item.type}:${item.value}`;
    if (seen.has(compound)) return false;
    seen.add(compound);
    return true;
  });
}

async function ensureContactIdentitySchema() {
  if (schemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS lead_contact_identities (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      identifier_type VARCHAR(30) NOT NULL,
      identifier_value VARCHAR(255) NOT NULL,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, identifier_type, identifier_value)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_lead_identity_lead
    ON lead_contact_identities(tenant_id, lead_id)
  `);

  await db.query(`
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS contact_identifier VARCHAR(255),
      ADD COLUMN IF NOT EXISTS contact_identifiers JSONB NOT NULL DEFAULT '[]'::jsonb
  `);

  schemaReady = true;
}

async function bindIdentifiers({ tenantId, leadId, identifiers }) {
  await ensureContactIdentitySchema();
  for (const item of identifiers || []) {
    if (!item?.type || !item?.value) continue;
    await db.query(`
      INSERT INTO lead_contact_identities (
        tenant_id, lead_id, identifier_type, identifier_value, is_primary, updated_at
      ) VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (tenant_id, identifier_type, identifier_value)
      DO UPDATE SET lead_id = EXCLUDED.lead_id, updated_at = NOW()
    `, [tenantId, leadId, item.type, item.value, item.type === 'phone']);
  }
}

async function findLeadByIdentifiers({ tenantId, identifiers }) {
  await ensureContactIdentitySchema();
  if (!identifiers?.length) return null;
  const values = identifiers.map(item => item.value);

  const result = await db.query(`
    SELECT l.*
    FROM lead_contact_identities i
    JOIN leads l ON l.id = i.lead_id AND l.tenant_id = i.tenant_id
    WHERE i.tenant_id = $1 AND i.identifier_value = ANY($2::text[])
    ORDER BY l.updated_at DESC
    LIMIT 1
  `, [tenantId, values]);

  return result.rows[0] || null;
}

async function findLeadByPhone({ tenantId, phone }) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const local = normalized.startsWith('55') ? normalized.slice(2) : normalized;

  const result = await db.query(`
    SELECT * FROM leads
    WHERE tenant_id = $1
      AND (
        regexp_replace(phone, '\\D', '', 'g') = $2
        OR regexp_replace(phone, '\\D', '', 'g') = $3
        OR right(regexp_replace(phone, '\\D', '', 'g'), 10) = right($2, 10)
        OR right(regexp_replace(phone, '\\D', '', 'g'), 11) = right($2, 11)
      )
    ORDER BY updated_at DESC
    LIMIT 1
  `, [tenantId, normalized, local]);

  return result.rows[0] || null;
}

async function resolveLead({ tenantId, data, name, allowCreate = true, fromMe = false }) {
  await ensureContactIdentitySchema();
  const identifiers = collectIdentifiers(data);
  let lead = await findLeadByIdentifiers({ tenantId, identifiers });

  const phoneIdentity = identifiers.find(item => item.type === 'phone');
  if (!lead && phoneIdentity) {
    lead = await findLeadByPhone({ tenantId, phone: phoneIdentity.value });
  }

  if (!lead && (!allowCreate || fromMe)) return { lead: null, identifiers };

  if (!lead) {
    const lid = identifiers.find(item => item.type === 'lid')?.value;
    const phone = phoneIdentity?.value || `LID:${String(lid || Date.now()).split('@')[0]}`;
    const result = await db.query(`
      INSERT INTO leads (
        tenant_id, name, phone, status, origin, last_contact_at, created_at, updated_at
      ) VALUES ($1,$2,$3,'novo'::lead_status,'WhatsApp',NOW(),NOW(),NOW())
      RETURNING *
    `, [tenantId, String(name || phone).trim(), phone]);
    lead = result.rows[0];
  }

  if (phoneIdentity && String(lead.phone || '').startsWith('LID:')) {
    const updated = await db.query(`
      UPDATE leads SET phone = $1, updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
      RETURNING *
    `, [phoneIdentity.value, lead.id, tenantId]);
    lead = updated.rows[0] || lead;
  }

  await bindIdentifiers({ tenantId, leadId: lead.id, identifiers });
  return { lead, identifiers };
}

async function repairMessagesForLead({ tenantId, leadId }) {
  await ensureContactIdentitySchema();
  const identities = await db.query(`
    SELECT identifier_value
    FROM lead_contact_identities
    WHERE tenant_id = $1 AND lead_id = $2
  `, [tenantId, leadId]);

  const values = identities.rows.map(row => row.identifier_value);
  if (!values.length) return 0;

  const result = await db.query(`
    UPDATE messages m
    SET lead_id = $1
    WHERE m.tenant_id = $2
      AND m.lead_id <> $1
      AND (
        m.contact_identifier = ANY($3::text[])
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(m.contact_identifiers, '[]'::jsonb)) value
          WHERE value = ANY($3::text[])
        )
      )
  `, [leadId, tenantId, values]);

  return result.rowCount || 0;
}

module.exports = {
  ensureContactIdentitySchema,
  collectIdentifiers,
  normalizePhone,
  resolveLead,
  bindIdentifiers,
  repairMessagesForLead
};
