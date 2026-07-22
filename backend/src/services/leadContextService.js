const db = require('../db');

const OPENAI_URL = 'https://api.openai.com/v1/responses';
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
      recommended_status VARCHAR(30),
      last_analyzed_message_at TIMESTAMPTZ,
      confidence NUMERIC(5,2) DEFAULT 0,
      analysis_provider VARCHAR(30) DEFAULT 'local',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE lead_commercial_context
      ADD COLUMN IF NOT EXISTS recommended_status VARCHAR(30),
      ADD COLUMN IF NOT EXISTS analysis_provider VARCHAR(30) DEFAULT 'local'
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

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function detectLocalContext(lead, messages) {
  const inbound = messages.filter(item => item.direction !== 'outbound');
  const outbound = messages.filter(item => item.direction === 'outbound');
  const texts = messages.map(item => normalize(item.message)).filter(Boolean);
  const allText = texts.join(' ').toLowerCase();
  const latestInbound = [...inbound].reverse().find(item => normalize(item.message));
  const latestText = compactText(latestInbound?.message || '');

  let purchaseIntent = 'unknown';
  if (/quero|tenho interesse|como faço|agend[ae]|agenda (um|1)|marca(r)?|marque|hor[aá]rio|encaix[ae]|fechar|vou fazer|pode reservar|pode marcar|onde pago/.test(allText)) {
    purchaseIntent = 'high';
  } else if (/valor|pre[cç]o|quanto|parcela|pagamento|funciona|como [ée]|tem desconto|forma de pagamento/.test(allText)) {
    purchaseIntent = 'medium';
  } else if (inbound.length) {
    purchaseIntent = 'low';
  }

  let urgency = 'normal';
  if (/hoje|agora|urgente|amanh[ãa]|o quanto antes|pra já|para já/.test(allText)) {
    urgency = 'urgent';
  } else if (/essa semana|esta semana|este m[eê]s|logo|breve/.test(allText)) {
    urgency = 'soon';
  }

  const objections = [];
  if (/caro|valor alto|pre[cç]o alto|desconto|mais barato|sem dinheiro|apertado/.test(allText)) objections.push('preço');
  if (/medo|receio|natural|resultado|fica bom|vai aparecer/.test(allText)) objections.push('resultado');
  if (/manuten[cç][aã]o|durabilidade|quanto tempo dura|dura quanto/.test(allText)) objections.push('manutenção');
  if (/vou pensar|depois|ainda n[aã]o|n[aã]o sei|falo depois/.test(allText)) objections.push('indecisão');
  if (/longe|dist[aâ]ncia|onde fica|localiza[cç][aã]o/.test(allText)) objections.push('localização');
  if (/hor[aá]rio|agenda|n[aã]o tenho tempo|sem tempo/.test(allText)) objections.push('disponibilidade');

  let mainInterest = normalize(lead.product);
  if (!mainInterest) {
    if (/pr[oó]tese|capilar|calv[ií]cie/.test(allText)) mainInterest = 'Prótese capilar';
    else if (/manuten[cç][aã]o/.test(allText)) mainInterest = 'Manutenção';
    else if (/barba/.test(allText)) mainInterest = 'Barba';
    else if (/corte/.test(allText)) mainInterest = 'Corte';
    else if (/curso|aprender/.test(allText)) mainInterest = 'Curso';
    else if (/plano|assinatura|mensal/.test(allText)) mainInterest = 'Plano';
  }

  let conversationTopic = lead.conversation_topic || 'nao_identificado';
  if (conversationTopic === 'nao_identificado') {
    if (mainInterest === 'Prótese capilar') conversationTopic = 'protese';
    else if (mainInterest === 'Manutenção') conversationTopic = 'manutencao';
    else if (mainInterest === 'Barba') conversationTopic = 'barba';
    else if (mainInterest === 'Corte') conversationTopic = 'corte';
    else if (mainInterest === 'Curso') conversationTopic = 'curso';
    else if (mainInterest === 'Plano') conversationTopic = 'plano';
    else if (/agendar|marcar|hor[aá]rio|agenda/.test(allText)) conversationTopic = 'agendamento';
    else if (/valor|pre[cç]o|or[cç]amento/.test(allText)) conversationTopic = 'orcamento';
  }

  let commercialPriority = lead.commercial_priority || 'comum';
  if (urgency === 'urgent') commercialPriority = 'urgente';
  else if (purchaseIntent === 'high') commercialPriority = 'quente';
  else if (purchaseIntent === 'medium') commercialPriority = 'negociacao';
  else if (inbound.length && commercialPriority === 'comum') commercialPriority = 'acompanhar';

  let customerProfile = lead.customer_relationship || 'nao_identificado';
  if (customerProfile === 'nao_identificado') {
    customerProfile = messages.length <= 3 ? 'primeiro_contato' : 'cliente_conhecido';
  }

  let recommendedStatus = lead.status || 'novo';
  if (purchaseIntent === 'high' && /(marcado|confirmado|pode ser|fechado|reservado)/.test(allText) && /agend|hor[aá]rio|marca/.test(allText)) recommendedStatus = 'fechado';
  else if (inbound.length && lead.status === 'novo') recommendedStatus = 'atendendo';
  else if (outbound.length && latestInbound && lead.status === 'atendendo') recommendedStatus = 'aguardando';

  let nextBestAction = 'Entender a principal necessidade do cliente.';
  if (purchaseIntent === 'high' && /agendar|marcar/.test(allText)) nextBestAction = 'Confirmar dia, horário e dados necessários para o agendamento.';
  else if (purchaseIntent === 'high') nextBestAction = 'Conduzir para agendamento ou fechamento com uma pergunta objetiva.';
  else if (objections.includes('preço')) nextBestAction = 'Explicar valor, formas de pagamento e benefício percebido.';
  else if (objections.includes('resultado')) nextBestAction = 'Apresentar resultado real e alinhar expectativas.';
  else if (objections.includes('manutenção')) nextBestAction = 'Explicar duração, manutenção e cuidados necessários.';
  else if (objections.includes('localização')) nextBestAction = 'Informar localização e facilitar a chegada do cliente.';
  else if (/hor[aá]rio|agenda|marcar/.test(allText)) nextBestAction = 'Oferecer duas opções objetivas de dia e horário.';
  else if (latestText) nextBestAction = 'Responder a última dúvida e terminar com uma pergunta que avance o atendimento.';

  const fields = lead.custom_fields || {};
  const sourceChannel = normalize(lead.origin) || 'WhatsApp';
  const sourceDetail = normalize(fields.source_detail || fields.referral_source || fields.source);
  const campaignName = normalize(fields.campaign_name || fields.campaign || fields.referral_campaign);
  const adName = normalize(fields.ad_name || fields.ad || fields.referral_ad);

  const summaryParts = [];
  if (mainInterest) summaryParts.push(`Interesse principal: ${mainInterest}.`);
  if (latestText) summaryParts.push(`Última fala do cliente: ${latestText.slice(0, 240)}${latestText.length > 240 ? '…' : ''}`);
  if (objections.length) summaryParts.push(`Objeções: ${unique(objections).join(', ')}.`);
  summaryParts.push(`Intenção de compra: ${purchaseIntent}.`);
  summaryParts.push(`Urgência: ${urgency}.`);

  return {
    sourceChannel,
    sourceDetail,
    campaignName,
    adName,
    commercialSummary: summaryParts.join(' '),
    mainInterest,
    purchaseIntent,
    urgency,
    objections: unique(objections),
    nextBestAction,
    customerProfile,
    conversationTopic,
    commercialPriority,
    recommendedStatus,
    lastAnalyzedMessageAt: messages.length ? messages[messages.length - 1].created_at : null,
    confidence: messages.length ? Math.min(94, 45 + messages.length * 4) : 20,
    provider: 'local',
    metadata: {
      message_count: messages.length,
      inbound_count: inbound.length,
      outbound_count: outbound.length
    }
  };
}

function safeJson(value) {
  try {
    const cleaned = String(value || '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function analyzeWithOpenAI({ lead, messages, fallback }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback;

  const history = messages.slice(-35).map(message => {
    const author = message.direction === 'outbound' ? 'ATENDENTE' : 'CLIENTE';
    return `${author}: ${compactText(message.message).slice(0, 1000)}`;
  }).join('\n');

  const prompt = `
Você analisa conversas comerciais do sistema Iadu Lead.
Retorne APENAS JSON válido, sem markdown.

Campos obrigatórios:
commercial_summary: resumo objetivo em português, máximo 450 caracteres
main_interest: serviço/produto principal ou null
purchase_intent: unknown|low|medium|high
urgency: normal|soon|urgent
objections: array de textos curtos
next_best_action: ação prática em português, máximo 220 caracteres
customer_profile: nao_identificado|primeiro_contato|cliente_conhecido|ex_cliente|parceiro|fornecedor
conversation_topic: nao_identificado|protese|corte|barba|manutencao|agendamento|orcamento|curso|plano|financeiro|parceria|outro
commercial_priority: comum|acompanhar|negociacao|quente|urgente|resolvido
recommended_status: novo|atendendo|aguardando|fechado|comprou|assinante|inativo|sumido
confidence: número de 0 a 100

Não invente preço, campanha, origem ou fatos ausentes.
A etapa recomendada é apenas recomendação; seja conservador.

LEAD:
Nome: ${normalize(lead.name)}
Etapa atual: ${normalize(lead.status)}
Origem: ${normalize(lead.origin)}
Produto atual: ${normalize(lead.product)}
Relação atual: ${normalize(lead.customer_relationship)}

CONVERSA:
${history || 'Sem mensagens'}
`.trim();

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5-mini',
        input: prompt,
        max_output_tokens: 500,
        store: false
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) return fallback;

    const parsed = safeJson(data.output_text);
    if (!parsed) return fallback;

    return {
      ...fallback,
      commercialSummary: normalize(parsed.commercial_summary) || fallback.commercialSummary,
      mainInterest: normalize(parsed.main_interest) || fallback.mainInterest,
      purchaseIntent: ['unknown','low','medium','high'].includes(parsed.purchase_intent)
        ? parsed.purchase_intent : fallback.purchaseIntent,
      urgency: ['normal','soon','urgent'].includes(parsed.urgency)
        ? parsed.urgency : fallback.urgency,
      objections: Array.isArray(parsed.objections)
        ? unique(parsed.objections.map(item => compactText(item).slice(0, 80)))
        : fallback.objections,
      nextBestAction: normalize(parsed.next_best_action) || fallback.nextBestAction,
      customerProfile: ['nao_identificado','primeiro_contato','cliente_conhecido','ex_cliente','parceiro','fornecedor'].includes(parsed.customer_profile)
        ? parsed.customer_profile : fallback.customerProfile,
      conversationTopic: ['nao_identificado','protese','corte','barba','manutencao','agendamento','orcamento','curso','plano','financeiro','parceria','outro'].includes(parsed.conversation_topic)
        ? parsed.conversation_topic : fallback.conversationTopic,
      commercialPriority: ['comum','acompanhar','negociacao','quente','urgente','resolvido'].includes(parsed.commercial_priority)
        ? parsed.commercial_priority : fallback.commercialPriority,
      recommendedStatus: ['novo','atendendo','aguardando','fechado','comprou','assinante','inativo','sumido'].includes(parsed.recommended_status)
        ? parsed.recommended_status : fallback.recommendedStatus,
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || fallback.confidence)),
      provider: 'openai'
    };
  } catch {
    return fallback;
  }
}

async function refreshLeadContext({ tenantId, leadId, force = false }) {
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

  const messages = messagesResult.rows;
  const latestMessageAt = messages.length ? messages[messages.length - 1].created_at : null;

  if (!force && latestMessageAt) {
    const existing = await db.query(`
      SELECT last_analyzed_message_at
      FROM lead_commercial_context
      WHERE lead_id = $1 AND tenant_id = $2
      LIMIT 1
    `, [leadId, tenantId]);

    const analyzedAt = existing.rows[0]?.last_analyzed_message_at;
    if (analyzedAt && new Date(analyzedAt).getTime() >= new Date(latestMessageAt).getTime()) {
      return getLeadContext({ tenantId, leadId, refreshIfMissing: false });
    }
  }

  const localContext = detectLocalContext(lead, messages);
  const context = await analyzeWithOpenAI({ lead, messages, fallback: localContext });

  // Atualiza automaticamente apenas campos de organização.
  // A etapa do funil continua como recomendação para evitar movimentação indevida.
  await db.query(`
    UPDATE leads
    SET
      product = COALESCE(NULLIF(product, ''), $1),
      conversation_topic = CASE
        WHEN conversation_topic IS NULL OR conversation_topic = '' OR conversation_topic = 'nao_identificado'
          THEN $2
        ELSE conversation_topic
      END,
      commercial_priority = CASE
        WHEN commercial_priority IS NULL OR commercial_priority = '' OR commercial_priority IN ('comum','acompanhar')
          THEN $3
        ELSE commercial_priority
      END,
      customer_relationship = CASE
        WHEN customer_relationship IS NULL OR customer_relationship = '' OR customer_relationship = 'nao_identificado'
          THEN $4
        ELSE customer_relationship
      END,
      updated_at = NOW()
    WHERE id = $5 AND tenant_id = $6
  `, [
    context.mainInterest || null,
    context.conversationTopic,
    context.commercialPriority,
    context.customerProfile,
    leadId,
    tenantId
  ]);

  // Movimentação automática conservadora.
  const safeTransitions = {
    novo: ['atendendo'],
    aguardando: ['atendendo', 'fechado'],
    inativo: ['atendendo'],
    sumido: ['atendendo'],
    atendendo: ['aguardando', 'fechado']
  };

  const allowed = safeTransitions[lead.status] || [];
  if (
    allowed.includes(context.recommendedStatus) &&
    Number(context.confidence || 0) >= 65
  ) {
    await db.query(`
      UPDATE leads
      SET status = $1::lead_status, updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
    `, [context.recommendedStatus, leadId, tenantId]);
  }

  const result = await db.query(`
    INSERT INTO lead_commercial_context (
      tenant_id, lead_id, source_channel, source_detail, campaign_name, ad_name,
      commercial_summary, main_interest, purchase_intent, urgency, objections,
      next_best_action, customer_profile, recommended_status,
      last_analyzed_message_at, confidence, analysis_provider,
      metadata, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb,NOW(),NOW()
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
      recommended_status = EXCLUDED.recommended_status,
      last_analyzed_message_at = EXCLUDED.last_analyzed_message_at,
      confidence = EXCLUDED.confidence,
      analysis_provider = EXCLUDED.analysis_provider,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *
  `, [
    tenantId,
    leadId,
    context.sourceChannel,
    context.sourceDetail || null,
    context.campaignName || null,
    context.adName || null,
    context.commercialSummary || null,
    context.mainInterest || null,
    context.purchaseIntent,
    context.urgency,
    JSON.stringify(context.objections),
    context.nextBestAction || null,
    context.customerProfile || null,
    context.recommendedStatus || null,
    context.lastAnalyzedMessageAt,
    context.confidence,
    context.provider,
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

  await refreshLeadContext({ tenantId, leadId, force: true });
  return getLeadContext({ tenantId, leadId, refreshIfMissing: false });
}

module.exports = {
  ensureLeadContextSchema,
  refreshLeadContext,
  getLeadContext
};
