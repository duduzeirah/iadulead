const db = require('../db');

let schemaReady = false;

async function ensureLeadContextSchema() {
  if (schemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS lead_commercial_context (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id UUID NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
      source_channel VARCHAR(100),
      source_detail VARCHAR(255),
      campaign_name VARCHAR(255),
      ad_name VARCHAR(255),
      commercial_summary TEXT,
      main_interest VARCHAR(255),
      purchase_intent VARCHAR(30) NOT NULL DEFAULT 'unknown',
      urgency VARCHAR(30) NOT NULL DEFAULT 'normal',
      objections JSONB NOT NULL DEFAULT '[]'::jsonb,
      next_best_action TEXT,
      customer_profile TEXT,
      last_analyzed_message_at TIMESTAMPTZ,
      confidence NUMERIC(5,2) DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_lead_context_tenant
    ON lead_commercial_context(tenant_id, updated_at DESC)
  `);

  schemaReady = true;
}

function normalize(value) {
  return String(value || '').trim();
}

function compactText(value) {
  return normalize(value).replace(/\s+/g, ' ');
}

function detectContext(lead, messages) {
  const inbound = messages.filter(item => item.direction !== 'outbound');
  const allText = messages.map(item => normalize(item.message)).filter(Boolean).join(' ').toLowerCase();
  const latestInbound = [...inbound].reverse().find(item => normalize(item.message));
  const latestText = compactText(latestInbound?.message || '');

  let purchaseIntent = 'unknown';
  if (/quero|tenho interesse|como faço|agendar|marcar|fechar|vou fazer|pode reservar/.test(allText)) purchaseIntent = 'high';
  else if (/valor|preço|quanto|parcela|pagamento|funciona|como é/.test(allText)) purchaseIntent = 'medium';
  else if (inbound.length) purchaseIntent = 'low';

  let urgency = 'normal';
  if (/hoje|agora|urgente|amanhã|essa semana|o quanto antes/.test(allText)) urgency = 'urgent';
  else if (/este mês|essa semana|logo|breve/.test(allText)) urgency = 'soon';

  const objections = [];
  if (/caro|valor alto|preço alto|desconto|mais barato/.test(allText)) objections.push('preço');
  if (/medo|receio|natural|resultado|fica bom/.test(allText)) objections.push('resultado');
  if (/manutenção|durabilidade|quanto tempo dura/.test(allText)) objections.push('manutenção');
  if (/vou pensar|depois|ainda não|não sei/.test(allText)) objections.push('indecisão');

  let mainInterest = normalize(lead.product);
  if (!mainInterest) {
    if (/pr[oó]tese|capilar/.test(allText)) mainInterest = 'Prótese capilar';
    else if (/barba/.test(allText)) mainInterest = 'Barba';
    else if (/corte/.test(allText)) mainInterest = 'Corte';
    else if (/manuten[cç][aã]o/.test(allText)) mainInterest = 'Manutenção';
    else if (/curso/.test(allText)) mainInterest = 'Curso';
  }

  let nextBestAction = 'Entender a principal necessidade do cliente.';
  if (purchaseIntent === 'high') nextBestAction = 'Conduzir para agendamento ou fechamento.';
  else if (objections.includes('preço')) nextBestAction = 'Explicar valor, formas de pagamento e benefício.';
  else if (objections.includes('resultado')) nextBestAction = 'Apresentar resultado real e esclarecer expectativas.';
  else if (/hor[aá]rio|agenda|marcar/.test(allText)) nextBestAction = 'Oferecer opções objetivas de dia e horário.';
  else if (latestText) nextBestAction = 'Responder a última dúvida e terminar com uma pergunta de avanço.';

  const sourceChannel = normalize(lead.origin) || 'WhatsApp';
  const fields = lead.custom_fields || {};
  const sourceDetail = normalize(fields.source_detail || fields.referral_source || fields.source);
  const campaignName = normalize(fields.campaign_name || fields.campaign);
  const adName = normalize(fields.ad_name || fields.ad);

  const summaryParts = [];
  if (mainInterest) summaryParts.push(`Interesse principal: ${mainInterest}.`);
  if (latestText) summaryParts.push(`Última fala do cliente: ${latestText.slice(0, 220)}${latestText.length > 220 ? '…' : ''}`);
  if (objections.length) summaryParts.push(`Objeções identificadas: ${objections.join(', ')}.`);
  summaryParts.push(`Intenção de compra: ${purchaseIntent}.`);

  return {
    sourceChannel,
    sourceDetail,
    campaignName,
    adName,
    commercialSummary: summaryParts.join(' '),
    mainInterest,
    purchaseIntent,
    urgency,
    objections,
    nextBestAction,
    customerProfile: lead.customer_relationship || 'nao_identificado',
    lastAnalyzedMessageAt: messages.length ? messages[messages.length - 1].created_at : null,
    confidence: messages.length ? Math.min(95, 40 + messages.length * 5) : 20,
    metadata: { message_count: messages.length, inbound_count: inbound.length }
  };
}

async function refreshLeadContext({ tenantId, leadId }) {
  await ensureLeadContextSchema();

  const leadResult = await db.query(`
    SELECT id, tenant_id, assigned_to, name, phone, status, origin, product,
           conversation_topic, commercial_priority, customer_relationship,
           custom_fields
    FROM leads
    WHERE id = $1 AND tenant_id = $2
    LIMIT 1
  `, [leadId, tenantId]);

  const lead = leadResult.rows[0];
  if (!lead) return null;

  const messagesResult = await db.query(`
    SELECT direction, message, message_type, created_at
    FROM messages
    WHERE lead_id = $1 AND tenant_id = $2
    ORDER BY created_at ASC
    LIMIT 300
  `, [leadId, tenantId]);

  const context = detectContext(lead, messagesResult.rows);

  const result = await db.query(`
    INSERT INTO lead_commercial_context (
      tenant_id, lead_id, source_channel, source_detail, campaign_name, ad_name,
      commercial_summary, main_interest, purchase_intent, urgency, objections,
      next_best_action, customer_profile, last_analyzed_message_at, confidence,
      metadata, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,NOW(),NOW()
    )
    ON CONFLICT (lead_id) DO UPDATE SET
      source_channel = EXCLUDED.source_channel,
      source_detail = EXCLUDED.source_detail,
      campaign_name = EXCLUDED.campaign_name,
      ad_name = EXCLUDED.ad_name,
      commercial_summary = EXCLUDED.commercial_summary,
      main_interest = EXCLUDED.main_interest,
      purchase_intent = EXCLUDED.purchase_intent,
      urgency = EXCLUDED.urgency,
      objections = EXCLUDED.objections,
      next_best_action = EXCLUDED.next_best_action,
      customer_profile = EXCLUDED.customer_profile,
      last_analyzed_message_at = EXCLUDED.last_analyzed_message_at,
      confidence = EXCLUDED.confidence,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *
  `, [
    tenantId, leadId, context.sourceChannel, context.sourceDetail || null,
    context.campaignName || null, context.adName || null,
    context.commercialSummary || null, context.mainInterest || null,
    context.purchaseIntent, context.urgency, JSON.stringify(context.objections),
    context.nextBestAction || null, context.customerProfile || null,
    context.lastAnalyzedMessageAt, context.confidence,
    JSON.stringify(context.metadata)
  ]);

  return result.rows[0];
}

async function getLeadContext({ tenantId, leadId, refreshIfMissing = true }) {
  await ensureLeadContextSchema();

  const result = await db.query(`
    SELECT c.*, l.assigned_to, u.name AS assigned_user_name, u.email AS assigned_user_email
    FROM lead_commercial_context c
    JOIN leads l ON l.id = c.lead_id AND l.tenant_id = c.tenant_id
    LEFT JOIN users u ON u.id = l.assigned_to
    WHERE c.lead_id = $1 AND c.tenant_id = $2
    LIMIT 1
  `, [leadId, tenantId]);

  if (result.rows[0] || !refreshIfMissing) return result.rows[0] || null;
  await refreshLeadContext({ tenantId, leadId });
  return getLeadContext({ tenantId, leadId, refreshIfMissing: false });
}

module.exports = { ensureLeadContextSchema, refreshLeadContext, getLeadContext };
