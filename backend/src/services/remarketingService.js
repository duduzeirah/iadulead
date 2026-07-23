const db = require('../db');
const { evolutionRequest } = require('./evolutionService');
const { publish } = require('./realtimeService');

let schemaReady = false;
let workerStarted = false;
let workerBusy = false;

async function ensureRemarketingSchema() {
  if (schemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS remarketing_campaigns (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      name VARCHAR(255) NOT NULL,
      message_template TEXT NOT NULL,
      audience VARCHAR(40) NOT NULL DEFAULT 'inactive',
      status VARCHAR(30) NOT NULL DEFAULT 'queued',
      total_recipients INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS remarketing_recipients (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      campaign_id UUID NOT NULL REFERENCES remarketing_campaigns(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id, lead_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS remarketing_settings (
      tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      automatic_enabled BOOLEAN NOT NULL DEFAULT false,
      inactive_days INTEGER NOT NULL DEFAULT 30,
      automatic_message TEXT NOT NULL DEFAULT 'Olá {nome}! Sentimos sua falta. Posso te ajudar com alguma coisa?',
      last_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  schemaReady = true;
}

function formatMessage(template, lead) {
  return String(template || '')
    .replace(/\{nome\}/gi, String(lead.name || 'cliente').split(' ')[0])
    .replace(/\{produto\}/gi, String(lead.product || ''))
    .trim();
}

function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  if (!phone) return null;
  if (!phone.startsWith('55') && phone.length <= 11) phone = `55${phone}`;
  return phone;
}

function audienceWhere(audience) {
  if (audience === 'ghosts') return `l.status = 'sumido'`;
  if (audience === 'all') return `l.status <> 'comprou'`;
  if (audience === 'buyers60') return `l.status = 'comprou' AND COALESCE(l.last_contact_at,l.updated_at) < NOW() - INTERVAL '60 days'`;
  return `l.status = 'inativo'`;
}

async function createCampaign({ tenantId, userId, name, message, audience }) {
  await ensureRemarketingSchema();
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) throw new Error('Informe a mensagem da campanha.');

  const campaignResult = await db.query(`
    INSERT INTO remarketing_campaigns (
      tenant_id, created_by, name, message_template, audience, status
    ) VALUES ($1,$2,$3,$4,$5,'queued')
    RETURNING *
  `, [tenantId, userId, String(name || 'Campanha').trim(), cleanMessage, audience || 'inactive']);

  const campaign = campaignResult.rows[0];
  const where = audienceWhere(audience);

  const recipients = await db.query(`
    INSERT INTO remarketing_recipients (campaign_id, tenant_id, lead_id)
    SELECT $1, $2, l.id
    FROM leads l
    WHERE l.tenant_id = $2
      AND ${where}
      AND regexp_replace(COALESCE(l.phone,''), '\\D', '', 'g') <> ''
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [campaign.id, tenantId]);

  await db.query(`
    UPDATE remarketing_campaigns
    SET total_recipients = $1,
        status = CASE WHEN $1 = 0 THEN 'finished' ELSE 'queued' END,
        finished_at = CASE WHEN $1 = 0 THEN NOW() ELSE NULL END
    WHERE id = $2
  `, [recipients.rowCount, campaign.id]);

  return { ...campaign, total_recipients: recipients.rowCount };
}

async function processOneRecipient() {
  await ensureRemarketingSchema();
  if (workerBusy) return false;
  workerBusy = true;

  try {
    const picked = await db.query(`
      SELECT rr.id AS recipient_id, rr.campaign_id, rr.tenant_id, rr.lead_id,
             rc.message_template, l.name, l.phone, l.product,
             wc.instance_name, wc.provider
      FROM remarketing_recipients rr
      JOIN remarketing_campaigns rc ON rc.id = rr.campaign_id
      JOIN leads l ON l.id = rr.lead_id AND l.tenant_id = rr.tenant_id
      LEFT JOIN whatsapp_connections wc ON wc.tenant_id = rr.tenant_id
      WHERE rr.status = 'pending' AND rc.status IN ('queued','sending')
      ORDER BY rr.created_at ASC
      LIMIT 1
    `);

    const item = picked.rows[0];
    if (!item) return false;

    await db.query(`UPDATE remarketing_campaigns SET status='sending', started_at=COALESCE(started_at,NOW()) WHERE id=$1`, [item.campaign_id]);
    await db.query(`UPDATE remarketing_recipients SET status='sending', attempts=attempts+1 WHERE id=$1`, [item.recipient_id]);

    try {
      if (item.provider !== 'evolution' || !item.instance_name) throw new Error('WhatsApp da empresa não está conectado pela Evolution.');
      const phone = normalizePhone(item.phone);
      if (!phone) throw new Error('Telefone inválido.');
      const outgoing = formatMessage(item.message_template, item);

      await evolutionRequest('post', `/message/sendText/${encodeURIComponent(item.instance_name)}`, {
        number: phone,
        text: outgoing
      });

      await db.query(`
        INSERT INTO messages (
          tenant_id, lead_id, direction, message, message_type, sent_by_name, created_at
        ) VALUES ($1,$2,'outbound',$3,'text','Remarketing automático',NOW())
      `, [item.tenant_id, item.lead_id, outgoing]);

      await db.query(`UPDATE remarketing_recipients SET status='sent', sent_at=NOW(), last_error=NULL WHERE id=$1`, [item.recipient_id]);
      await db.query(`UPDATE remarketing_campaigns SET sent_count=sent_count+1 WHERE id=$1`, [item.campaign_id]);
      publish(item.tenant_id, 'chat.update', { lead_id: item.lead_id, direction: 'outbound' });
    } catch (error) {
      await db.query(`UPDATE remarketing_recipients SET status='failed', last_error=$2 WHERE id=$1`, [item.recipient_id, String(error.message || error).slice(0,1000)]);
      await db.query(`UPDATE remarketing_campaigns SET failed_count=failed_count+1 WHERE id=$1`, [item.campaign_id]);
    }

    await db.query(`
      UPDATE remarketing_campaigns rc
      SET status='finished', finished_at=NOW()
      WHERE rc.id=$1
        AND NOT EXISTS (
          SELECT 1 FROM remarketing_recipients rr
          WHERE rr.campaign_id=rc.id AND rr.status IN ('pending','sending')
        )
    `, [item.campaign_id]);

    return true;
  } finally {
    workerBusy = false;
  }
}

async function createAutomaticCampaigns() {
  await ensureRemarketingSchema();
  const settings = await db.query(`
    SELECT * FROM remarketing_settings
    WHERE automatic_enabled = true
      AND (last_run_at IS NULL OR last_run_at < NOW() - INTERVAL '24 hours')
  `);

  for (const setting of settings.rows) {
    const result = await createCampaign({
      tenantId: setting.tenant_id,
      userId: null,
      name: `Remarketing automático ${new Date().toLocaleDateString('pt-BR')}`,
      message: setting.automatic_message,
      audience: 'inactive'
    });
    await db.query(`UPDATE remarketing_settings SET last_run_at=NOW(), updated_at=NOW() WHERE tenant_id=$1`, [setting.tenant_id]);
  }
}

function startRemarketingWorker() {
  if (workerStarted) return;
  workerStarted = true;
  ensureRemarketingSchema().catch(console.error);
  setInterval(() => processOneRecipient().catch(error => console.error('Remarketing worker:', error.message)), 3500);
  setInterval(() => createAutomaticCampaigns().catch(error => console.error('Remarketing automático:', error.message)), 15 * 60 * 1000);
}

module.exports = {
  ensureRemarketingSchema,
  createCampaign,
  startRemarketingWorker
};
