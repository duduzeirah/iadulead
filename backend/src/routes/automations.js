// backend/src/routes/automations.js

const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

const ALLOWED_EVENTS = [
  'outbound_message',
  'inbound_message',
  'classification_change'
];

const ALLOWED_MATCH_MODES = [
  'contains_any',
  'contains_all',
  'exact'
];

const ALLOWED_CLASSIFICATION_FIELDS = [
  'commercial_priority',
  'conversation_topic',
  'customer_relationship'
];

const ALLOWED_STATUSES = [
  'novo',
  'atendendo',
  'aguardando',
  'fechado',
  'comprou',
  'assinante',
  'inativo',
  'sumido'
];

function cleanTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function validateRule(body, partial = false) {
  const errors = [];

  if (
    !partial ||
    body.name !== undefined
  ) {
    if (!String(body.name || '').trim()) {
      errors.push('O nome da automação é obrigatório');
    }
  }

  if (
    !partial ||
    body.event_type !== undefined
  ) {
    if (!ALLOWED_EVENTS.includes(body.event_type)) {
      errors.push('Tipo de evento inválido');
    }
  }

  if (
    body.match_mode !== undefined &&
    !ALLOWED_MATCH_MODES.includes(body.match_mode)
  ) {
    errors.push('Modo de reconhecimento inválido');
  }

  if (
    body.action_status !== undefined &&
    body.action_status !== null &&
    !ALLOWED_STATUSES.includes(body.action_status)
  ) {
    errors.push('Etapa de destino inválida');
  }

  if (
    body.classification_field !== undefined &&
    body.classification_field !== null &&
    body.classification_field !== '' &&
    !ALLOWED_CLASSIFICATION_FIELDS.includes(
      body.classification_field
    )
  ) {
    errors.push('Campo de classificação inválido');
  }

  if (
    body.event_type === 'classification_change' &&
    !partial
  ) {
    if (
      !ALLOWED_CLASSIFICATION_FIELDS.includes(
        body.classification_field
      )
    ) {
      errors.push(
        'Escolha o campo de classificação'
      );
    }

    if (
      !String(
        body.classification_value || ''
      ).trim()
    ) {
      errors.push(
        'Informe o valor da classificação'
      );
    }
  }

  if (
    (
      body.event_type === 'outbound_message' ||
      body.event_type === 'inbound_message'
    ) &&
    !partial
  ) {
    const keywords =
      cleanTextArray(body.keywords);

    if (!keywords.length) {
      errors.push(
        'Informe pelo menos uma palavra ou frase'
      );
    }
  }

  return errors;
}

/*
=====================================================
GET /api/automations
LISTA TODAS AS AUTOMAÇÕES DA EMPRESA
=====================================================
*/

router.get('/', async (req, res) => {
  try {
    const tenantId =
      req.user.tenant_id;

    const result =
      await db.query(
        `
        SELECT
          id,
          name,
          event_type,
          match_mode,
          keywords,
          negative_keywords,
          classification_field,
          classification_value,
          action_status,
          enabled,
          priority,
          created_at,
          updated_at
        FROM automation_rules
        WHERE tenant_id = $1
        ORDER BY
          priority ASC,
          created_at ASC
        `,
        [
          tenantId
        ]
      );

    return res.json({
      automations:
        result.rows
    });

  } catch (error) {
    console.error(
      'Erro ao listar automações:',
      error
    );

    return res.status(500).json({
      error:
        'Erro ao listar automações'
    });
  }
});

/*
=====================================================
GET /api/automations/:id
BUSCA UMA AUTOMAÇÃO
=====================================================
*/

router.get('/:id', async (req, res) => {
  try {
    const tenantId =
      req.user.tenant_id;

    const result =
      await db.query(
        `
        SELECT *
        FROM automation_rules
        WHERE id = $1
        AND tenant_id = $2
        LIMIT 1
        `,
        [
          req.params.id,
          tenantId
        ]
      );

    if (!result.rows[0]) {
      return res.status(404).json({
        error:
          'Automação não encontrada'
      });
    }

    return res.json(
      result.rows[0]
    );

  } catch (error) {
    console.error(
      'Erro ao buscar automação:',
      error
    );

    return res.status(500).json({
      error:
        'Erro ao buscar automação'
    });
  }
});

/*
=====================================================
POST /api/automations
CRIA UMA AUTOMAÇÃO
=====================================================
*/

router.post('/', async (req, res) => {
  try {
    const tenantId =
      req.user.tenant_id;

    const errors =
      validateRule(req.body);

    if (errors.length) {
      return res.status(400).json({
        error:
          errors[0],

        errors
      });
    }

    const {
      name,
      event_type,
      match_mode = 'contains_any',
      classification_field,
      classification_value,
      action_status,
      enabled = true,
      priority = 100
    } = req.body;

    const keywords =
      cleanTextArray(
        req.body.keywords
      );

    const negativeKeywords =
      cleanTextArray(
        req.body.negative_keywords
      );

    const result =
      await db.query(
        `
        INSERT INTO automation_rules (
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
          priority,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::lead_status,
          $10,
          $11,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          tenantId,
          String(name).trim(),
          event_type,
          match_mode,
          keywords,
          negativeKeywords,
          classification_field || null,
          classification_value
            ? String(
                classification_value
              ).trim()
            : null,
          action_status,
          Boolean(enabled),
          Number(priority) || 100
        ]
      );

    return res
      .status(201)
      .json(
        result.rows[0]
      );

  } catch (error) {
    console.error(
      'Erro ao criar automação:',
      error
    );

    return res.status(500).json({
      error:
        'Erro ao criar automação'
    });
  }
});

/*
=====================================================
PATCH /api/automations/:id
EDITA UMA AUTOMAÇÃO
=====================================================
*/

router.patch('/:id', async (req, res) => {
  try {
    const tenantId =
      req.user.tenant_id;

    const currentResult =
      await db.query(
        `
        SELECT *
        FROM automation_rules
        WHERE id = $1
        AND tenant_id = $2
        LIMIT 1
        `,
        [
          req.params.id,
          tenantId
        ]
      );

    const current =
      currentResult.rows[0];

    if (!current) {
      return res.status(404).json({
        error:
          'Automação não encontrada'
      });
    }

    const merged = {
      ...current,
      ...req.body
    };

    const errors =
      validateRule(
        merged,
        false
      );

    if (errors.length) {
      return res.status(400).json({
        error:
          errors[0],

        errors
      });
    }

    const updates = [];
    const values = [];
    let p = 1;

    function set(column, value, cast = '') {
      updates.push(
        `${column} = $${p++}${cast}`
      );

      values.push(value);
    }

    if (req.body.name !== undefined) {
      set(
        'name',
        String(
          req.body.name
        ).trim()
      );
    }

    if (
      req.body.event_type !== undefined
    ) {
      set(
        'event_type',
        req.body.event_type
      );
    }

    if (
      req.body.match_mode !== undefined
    ) {
      set(
        'match_mode',
        req.body.match_mode
      );
    }

    if (
      req.body.keywords !== undefined
    ) {
      set(
        'keywords',
        cleanTextArray(
          req.body.keywords
        )
      );
    }

    if (
      req.body.negative_keywords !==
      undefined
    ) {
      set(
        'negative_keywords',
        cleanTextArray(
          req.body.negative_keywords
        )
      );
    }

    if (
      req.body.classification_field !==
      undefined
    ) {
      set(
        'classification_field',
        req.body.classification_field ||
        null
      );
    }

    if (
      req.body.classification_value !==
      undefined
    ) {
      set(
        'classification_value',
        req.body.classification_value
          ? String(
              req.body
                .classification_value
            ).trim()
          : null
      );
    }

    if (
      req.body.action_status !== undefined
    ) {
      set(
        'action_status',
        req.body.action_status,
        '::lead_status'
      );
    }

    if (
      req.body.enabled !== undefined
    ) {
      set(
        'enabled',
        Boolean(
          req.body.enabled
        )
      );
    }

    if (
      req.body.priority !== undefined
    ) {
      set(
        'priority',
        Number(
          req.body.priority
        ) || 100
      );
    }

    if (!updates.length) {
      return res.json(current);
    }

    values.push(
      req.params.id,
      tenantId
    );

    const result =
      await db.query(
        `
        UPDATE automation_rules
        SET
          ${updates.join(', ')},
          updated_at = NOW()
        WHERE id = $${p}
        AND tenant_id = $${p + 1}
        RETURNING *
        `,
        values
      );

    return res.json(
      result.rows[0]
    );

  } catch (error) {
    console.error(
      'Erro ao editar automação:',
      error
    );

    return res.status(500).json({
      error:
        'Erro ao editar automação'
    });
  }
});

/*
=====================================================
PATCH /api/automations/:id/toggle
ATIVA OU DESATIVA RAPIDAMENTE
=====================================================
*/

router.patch(
  '/:id/toggle',
  async (req, res) => {
    try {
      const tenantId =
        req.user.tenant_id;

      const result =
        await db.query(
          `
          UPDATE automation_rules
          SET
            enabled = NOT enabled,
            updated_at = NOW()
          WHERE id = $1
          AND tenant_id = $2
          RETURNING *
          `,
          [
            req.params.id,
            tenantId
          ]
        );

      if (!result.rows[0]) {
        return res.status(404).json({
          error:
            'Automação não encontrada'
        });
      }

      return res.json(
        result.rows[0]
      );

    } catch (error) {
      console.error(
        'Erro ao ativar/desativar automação:',
        error
      );

      return res.status(500).json({
        error:
          'Erro ao ativar ou desativar automação'
      });
    }
  }
);

/*
=====================================================
DELETE /api/automations/:id
EXCLUI UMA AUTOMAÇÃO
=====================================================
*/

router.delete('/:id', async (req, res) => {
  try {
    const tenantId =
      req.user.tenant_id;

    const result =
      await db.query(
        `
        DELETE FROM automation_rules
        WHERE id = $1
        AND tenant_id = $2
        RETURNING id
        `,
        [
          req.params.id,
          tenantId
        ]
      );

    if (!result.rows[0]) {
      return res.status(404).json({
        error:
          'Automação não encontrada'
      });
    }

    return res.json({
      success: true,
      id:
        result.rows[0].id
    });

  } catch (error) {
    console.error(
      'Erro ao excluir automação:',
      error
    );

    return res.status(500).json({
      error:
        'Erro ao excluir automação'
    });
  }
});
/*
=====================================================
POST /api/automations/test/message
TESTA UMA MENSAGEM SEM ALTERAR NENHUM LEAD
=====================================================
*/

router.post('/test/message', async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    const {
      event_type,
      message
    } = req.body;

    if (
      ![
        'outbound_message',
        'inbound_message'
      ].includes(event_type)
    ) {
      return res.status(400).json({
        error: 'Tipo de evento inválido'
      });
    }

    const cleanMessage =
      String(message || '').trim();

    if (!cleanMessage) {
      return res.status(400).json({
        error: 'Digite uma mensagem para testar'
      });
    }

    const {
      findMessageRule
    } = require('../services/automationEngine');

    const match =
      await findMessageRule({
        tenantId,
        eventType: event_type,
        message: cleanMessage
      });

    if (!match) {
      return res.json({
        matched: false,
        message: cleanMessage,
        reason:
          'Nenhuma automação reconheceu essa mensagem'
      });
    }

    return res.json({
      matched: true,
      message: cleanMessage,

      rule: {
        id: match.rule.id,
        name: match.rule.name,
        event_type:
          match.rule.event_type,
        action_status:
          match.rule.action_status,
        priority:
          match.rule.priority
      },

      matched_keyword:
        match.matchedKeyword,

      reason:
        match.reason
    });

  } catch (error) {
    console.error(
      'Erro ao testar automação:',
      error
    );

    return res.status(500).json({
      error: 'Erro ao testar automação'
    });
  }
});

module.exports = router;
