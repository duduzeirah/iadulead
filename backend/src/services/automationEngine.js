// backend/src/services/automationEngine.js

const db = require('../db');

/*
=====================================================
NORMALIZAÇÃO DE TEXTO
=====================================================
*/

function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
=====================================================
NORMALIZA LISTA DE PALAVRAS
=====================================================
*/

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) {
    return [];
  }

  return keywords
    .map(keyword => normalizeText(keyword))
    .filter(Boolean);
}

/*
=====================================================
CONFERE PALAVRAS NEGATIVAS
=====================================================
*/

function hasNegativeKeyword(text, negativeKeywords) {
  const normalizedNegatives =
    normalizeKeywords(negativeKeywords);

  return normalizedNegatives.some(keyword =>
    text.includes(keyword)
  );
}

/*
=====================================================
CONFERE SE A REGRA COMBINA COM A MENSAGEM
=====================================================
*/

function messageMatchesRule(message, rule) {
  const text = normalizeText(message);

  if (!text) {
    return {
      matched: false,
      matchedKeyword: null,
      reason: 'Mensagem vazia'
    };
  }

  const keywords =
    normalizeKeywords(rule.keywords);

  const negativeKeywords =
    normalizeKeywords(
      rule.negative_keywords
    );

  const negativeMatch =
    negativeKeywords.find(keyword =>
      text.includes(keyword)
    );

  if (negativeMatch) {
    return {
      matched: false,
      matchedKeyword: null,
      reason:
        `Frase negativa encontrada: "${negativeMatch}"`
    };
  }

  if (!keywords.length) {
    return {
      matched: false,
      matchedKeyword: null,
      reason:
        'Regra sem palavras configuradas'
    };
  }

  const matchMode =
    rule.match_mode ||
    'contains_any';

  if (matchMode === 'exact') {
    const exactMatch =
      keywords.find(keyword =>
        text === keyword
      );

    return {
      matched:
        Boolean(exactMatch),

      matchedKeyword:
        exactMatch || null,

      reason:
        exactMatch
          ? `Correspondência exata: "${exactMatch}"`
          : 'A mensagem não corresponde exatamente'
    };
  }

  if (matchMode === 'contains_all') {
    const allMatched =
      keywords.every(keyword =>
        text.includes(keyword)
      );

    return {
      matched:
        allMatched,

      matchedKeyword:
        allMatched
          ? keywords.join(', ')
          : null,

      reason:
        allMatched
          ? 'Todas as palavras da regra foram encontradas'
          : 'Nem todas as palavras foram encontradas'
    };
  }

  const foundKeyword =
    keywords.find(keyword =>
      text.includes(keyword)
    );

  return {
    matched:
      Boolean(foundKeyword),

    matchedKeyword:
      foundKeyword || null,

    reason:
      foundKeyword
        ? `Frase encontrada: "${foundKeyword}"`
        : 'Nenhuma palavra da regra foi encontrada'
  };
}

/*
=====================================================
BUSCA REGRAS DA EMPRESA
=====================================================
*/

async function getAutomationRules(
  tenantId,
  eventType
) {
  const result = await db.query(
    `
    SELECT
      id,
      tenant_id,
      name,
      event_type,
      match_mode,
      keywords,
      negative_keywords,
      classification_field,
      classification_value,
      action_status,
      enabled,
      priority
    FROM automation_rules
    WHERE tenant_id = $1
    AND event_type = $2
    AND enabled = TRUE
    ORDER BY
      priority ASC,
      created_at ASC
    `,
    [
      tenantId,
      eventType
    ]
  );

  return result.rows;
}

/*
=====================================================
ENCONTRA REGRA PARA MENSAGEM
=====================================================
*/

async function findMessageRule({
  tenantId,
  eventType,
  message
}) {
  if (
    eventType !== 'outbound_message' &&
    eventType !== 'inbound_message'
  ) {
    throw new Error(
      `Evento de mensagem inválido: ${eventType}`
    );
  }

  const rules =
    await getAutomationRules(
      tenantId,
      eventType
    );

  for (const rule of rules) {
    const match =
      messageMatchesRule(
        message,
        rule
      );

    if (match.matched) {
      return {
        rule,
        matchedKeyword:
          match.matchedKeyword,

        reason:
          match.reason
      };
    }
  }

  return null;
}

/*
=====================================================
ENCONTRA REGRA PARA ALTERAÇÃO DE CLASSIFICAÇÃO
=====================================================
*/

async function findClassificationRule({
  tenantId,
  field,
  value
}) {
  const rules =
    await getAutomationRules(
      tenantId,
      'classification_change'
    );

  const normalizedField =
    String(field || '').trim();

  const normalizedValue =
    normalizeText(value);

  const rule =
    rules.find(item => {
      const ruleField =
        String(
          item.classification_field || ''
        ).trim();

      const ruleValue =
        normalizeText(
          item.classification_value
        );

      return (
        ruleField === normalizedField &&
        ruleValue === normalizedValue
      );
    });

  if (!rule) {
    return null;
  }

  return {
    rule,
    matchedKeyword:
      `${normalizedField}=${normalizedValue}`,

    reason:
      `Classificação reconhecida: ${normalizedField} = ${normalizedValue}`
  };
}

/*
=====================================================
ATUALIZA O STATUS DO LEAD
=====================================================
*/

async function updateLeadStatus({
  tenantId,
  leadId,
  newStatus
}) {
  const result = await db.query(
    `
    UPDATE leads
    SET
      status = $1::lead_status,

      last_contact_at = NOW(),

      updated_at = NOW(),

      closed_at =
        CASE
          WHEN $2::boolean = TRUE
          THEN COALESCE(
            closed_at,
            NOW()
          )
          ELSE closed_at
        END,

      bought_at =
        CASE
          WHEN $3::boolean = TRUE
          THEN COALESCE(
            bought_at,
            NOW()
          )
          ELSE bought_at
        END

    WHERE id = $4
    AND tenant_id = $5

    RETURNING *
    `,
    [
      newStatus,
      newStatus === 'fechado',
      newStatus === 'comprou',
      leadId,
      tenantId
    ]
  );

  return result.rows[0] || null;
}

/*
=====================================================
REGISTRA A AUTOMAÇÃO NO HISTÓRICO DO LEAD
=====================================================
*/

async function registerAutomationActivity({
  tenantId,
  leadId,
  userId = null,
  previousStatus,
  newStatus,
  rule,
  source,
  message = null,
  matchedKeyword = null,
  reason = null
}) {
  if (
    !newStatus ||
    previousStatus === newStatus
  ) {
    return;
  }

  const description =
    `Automação "${rule.name}" moveu o lead ` +
    `de "${previousStatus}" para "${newStatus}"`;

  await db.query(
    `
    INSERT INTO lead_activities (
      tenant_id,
      lead_id,
      user_id,
      type,
      description,
      metadata
    )
    VALUES (
      $1,
      $2,
      $3,
      'status_change',
      $4,
      $5
    )
    `,
    [
      tenantId,
      leadId,
      userId,
      description,

      JSON.stringify({
        from:
          previousStatus,

        to:
          newStatus,

        source,

        automation_rule_id:
          rule.id,

        automation_rule_name:
          rule.name,

        matched_keyword:
          matchedKeyword,

        reason,

        message
      })
    ]
  );
}

/*
=====================================================
REGISTRA EXECUÇÃO NA TABELA AUTOMATION_LOGS
=====================================================
*/

async function registerAutomationLog({
  tenantId,
  leadId,
  rule = null,
  eventType = null,
  source = null,
  previousStatus = null,
  newStatus = null,
  matchedKeyword = null,
  message = null,
  success = true,
  errorMessage = null,
  metadata = {}
}) {
  try {
    await db.query(
      `
      INSERT INTO automation_logs (
        tenant_id,
        automation_rule_id,
        lead_id,
        event_type,
        source,
        previous_status,
        new_status,
        matched_keyword,
        message,
        success,
        error_message,
        metadata,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::lead_status,
        $7::lead_status,
        $8,
        $9,
        $10,
        $11,
        $12::jsonb,
        NOW()
      )
      `,
      [
        tenantId,
        rule?.id || null,
        leadId || null,
        eventType || rule?.event_type || null,
        source,
        previousStatus || null,
        newStatus || null,
        matchedKeyword,
        message,
        Boolean(success),
        errorMessage,
        JSON.stringify(metadata || {})
      ]
    );
  } catch (error) {
    console.error(
      '❌ Erro ao registrar histórico da automação:',
      error
    );
  }
}

/*
=====================================================
EXECUTA A REGRA ENCONTRADA
=====================================================
*/

async function executeRule({
  tenantId,
  leadId,
  userId = null,
  currentStatus,
  match,
  source,
  message = null
}) {
  if (!match?.rule) {
    return {
      matched: false,
      changed: false,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      rule: null,
      reason: 'Nenhuma automação encontrada'
    };
  }

  const newStatus =
    match.rule.action_status;

  if (!newStatus) {
    await registerAutomationLog({
      tenantId,
      leadId,
      rule: match.rule,
      eventType: match.rule.event_type,
      source,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      matchedKeyword: match.matchedKeyword,
      message,
      success: false,
      errorMessage:
        'A regra não possui uma etapa de destino',
      metadata: {
        reason: match.reason
      }
    });

    return {
      matched: true,
      changed: false,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      rule: match.rule,
      matchedKeyword: match.matchedKeyword,
      reason:
        'A regra não possui uma etapa de destino'
    };
  }

  if (newStatus === currentStatus) {
    await registerAutomationLog({
      tenantId,
      leadId,
      rule: match.rule,
      eventType: match.rule.event_type,
      source,
      previousStatus: currentStatus,
      newStatus,
      matchedKeyword: match.matchedKeyword,
      message,
      success: true,
      metadata: {
        changed: false,
        reason:
          'O lead já está na etapa indicada pela regra'
      }
    });

    return {
      matched: true,
      changed: false,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      rule: match.rule,
      matchedKeyword: match.matchedKeyword,
      reason:
        'O lead já está na etapa indicada pela regra'
    };
  }

  try {
    const updatedLead =
      await updateLeadStatus({
        tenantId,
        leadId,
        newStatus
      });

    if (!updatedLead) {
      throw new Error(
        'Lead não encontrado ao executar automação'
      );
    }

    await registerAutomationActivity({
      tenantId,
      leadId,
      userId,
      previousStatus: currentStatus,
      newStatus,
      rule: match.rule,
      source,
      message,
      matchedKeyword: match.matchedKeyword,
      reason: match.reason
    });

    await registerAutomationLog({
      tenantId,
      leadId,
      rule: match.rule,
      eventType: match.rule.event_type,
      source,
      previousStatus: currentStatus,
      newStatus,
      matchedKeyword: match.matchedKeyword,
      message,
      success: true,
      metadata: {
        changed: true,
        reason: match.reason
      }
    });

    console.log(
      `🤖 Automação executada: ` +
      `${match.rule.name} | ` +
      `${currentStatus} → ${newStatus}`
    );

    return {
      matched: true,
      changed: true,
      previousStatus: currentStatus,
      newStatus,
      rule: match.rule,
      matchedKeyword: match.matchedKeyword,
      reason: match.reason,
      lead: updatedLead
    };

  } catch (error) {
    await registerAutomationLog({
      tenantId,
      leadId,
      rule: match.rule,
      eventType: match.rule.event_type,
      source,
      previousStatus: currentStatus,
      newStatus,
      matchedKeyword: match.matchedKeyword,
      message,
      success: false,
      errorMessage: error.message,
      metadata: {
        reason: match.reason
      }
    });

    throw error;
  }
}

/*
=====================================================
PROCESSA MENSAGEM ENVIADA OU RECEBIDA
=====================================================
*/

async function processMessageAutomation({
  tenantId,
  leadId,
  userId = null,
  currentStatus,
  eventType,
  message
}) {
  try {
    const match =
      await findMessageRule({
        tenantId,
        eventType,
        message
      });

    if (!match) {
      return {
        matched: false,
        changed: false,

        previousStatus:
          currentStatus,

        newStatus:
          currentStatus,

        rule: null,

        reason:
          'Nenhuma regra de mensagem encontrada'
      };
    }

    return await executeRule({
      tenantId,
      leadId,
      userId,
      currentStatus,
      match,

      source:
        eventType,

      message
    });

  } catch (error) {
    console.error(
      '❌ Erro no motor de automação de mensagem:',
      error
    );

    return {
      matched: false,
      changed: false,

      previousStatus:
        currentStatus,

      newStatus:
        currentStatus,

      rule: null,

      error:
        error.message,

      reason:
        'Erro ao executar automação'
    };
  }
}

/*
=====================================================
PROCESSA ALTERAÇÃO DE CLASSIFICAÇÃO
=====================================================
*/

async function processClassificationAutomation({
  tenantId,
  leadId,
  userId = null,
  currentStatus,
  field,
  value
}) {
  try {
    const match =
      await findClassificationRule({
        tenantId,
        field,
        value
      });

    if (!match) {
      return {
        matched: false,
        changed: false,

        previousStatus:
          currentStatus,

        newStatus:
          currentStatus,

        rule: null,

        reason:
          'Nenhuma regra de classificação encontrada'
      };
    }

    return await executeRule({
      tenantId,
      leadId,
      userId,
      currentStatus,
      match,

      source:
        'classification_change'
    });

  } catch (error) {
    console.error(
      '❌ Erro no motor de automação de classificação:',
      error
    );

    return {
      matched: false,
      changed: false,

      previousStatus:
        currentStatus,

      newStatus:
        currentStatus,

      rule: null,

      error:
        error.message,

      reason:
        'Erro ao executar automação'
    };
  }
}

/*
=====================================================
EXPORTA AS FUNÇÕES
=====================================================
*/

module.exports = {
  normalizeText,
  messageMatchesRule,
  getAutomationRules,
  findMessageRule,
  findClassificationRule,
  registerAutomationLog,
  processMessageAutomation,
  processClassificationAutomation
};
