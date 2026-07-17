const express = require('express');
const axios = require('axios');
const db = require('../db');
const { auth } = require('../middleware/auth');

const {
  processMessageAutomation
} = require('../services/automationEngine');

const router = express.Router();

router.use(auth);

/*
=====================================================
CONFIGURAÇÃO DA EVOLUTION
=====================================================
*/

const EVOLUTION_URL =
  'https://evolution-api-production-0819.up.railway.app';

const EVOLUTION_INSTANCE =
  process.env.EVOLUTION_INSTANCE || 'iadulead';

const EVOLUTION_API_KEY =
  process.env.EVOLUTION_API_KEY;

/*
=====================================================
POST /api/sendmessage
ENVIA, SALVA E EXECUTA AUTOMAÇÕES
=====================================================
*/

router.post('/', async (req, res) => {
  try {
    const tenantId =
      req.user.tenant_id;

    const {
      lead_id,
      message
    } = req.body;

    if (!lead_id) {
      return res.status(400).json({
        success: false,
        error: 'Lead não informado'
      });
    }

    const cleanMessage =
      String(message || '').trim();

    if (!cleanMessage) {
      return res.status(400).json({
        success: false,
        error: 'Mensagem não pode ser vazia'
      });
    }

    /*
    =====================================================
    BUSCA O LEAD
    =====================================================
    */

    const leadResult =
      await db.query(
        `
        SELECT
          id,
          name,
          phone,
          status
        FROM leads
        WHERE id = $1
        AND tenant_id = $2
        LIMIT 1
        `,
        [
          lead_id,
          tenantId
        ]
      );

    if (
      leadResult.rows.length === 0
    ) {
      return res.status(404).json({
        success: false,
        error: 'Lead não encontrado'
      });
    }

    const lead =
      leadResult.rows[0];

    /*
    =====================================================
    PADRONIZA O TELEFONE
    =====================================================
    */

    let phone =
      String(lead.phone || '')
        .replace(/\D/g, '');

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Lead sem telefone válido'
      });
    }

    if (!phone.startsWith('55')) {
      phone = `55${phone}`;
    }

    /*
    =====================================================
    CONFERE CONFIGURAÇÃO DA EVOLUTION
    =====================================================
    */

    if (!EVOLUTION_API_KEY) {
      return res.status(500).json({
        success: false,
        error:
          'EVOLUTION_API_KEY não configurada no serviço iadulead'
      });
    }

    const endpoint =
      `${EVOLUTION_URL}/message/sendText/` +
      encodeURIComponent(
        EVOLUTION_INSTANCE
      );

    /*
    =====================================================
    ENVIA PARA O WHATSAPP
    =====================================================
    */

    const evolutionResponse =
      await axios({
        method: 'post',
        url: endpoint,

        headers: {
          apikey:
            EVOLUTION_API_KEY,

          'Content-Type':
            'application/json'
        },

        data: {
          number: phone,
          text: cleanMessage
        },

        timeout: 20000
      });

    /*
    =====================================================
    SALVA A MENSAGEM SEM DUPLICAR
    =====================================================
    */

    await db.query(
      `
      INSERT INTO messages (
        tenant_id,
        lead_id,
        direction,
        message,
        message_type,
        created_at
      )
      SELECT
        $1,
        $2,
        'outbound',
        $3,
        'text',
        NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM messages
        WHERE tenant_id = $1
        AND lead_id = $2
        AND direction = 'outbound'
        AND message = $3
        AND created_at >=
          NOW() - INTERVAL '15 seconds'
      )
      `,
      [
        tenantId,
        lead_id,
        cleanMessage
      ]
    );

    /*
    =====================================================
    EXECUTA O MOTOR CENTRAL DE AUTOMAÇÕES
    =====================================================
    */

    const automation =
      await processMessageAutomation({
        tenantId,
        leadId:
          lead_id,

        userId:
          req.user.id,

        currentStatus:
          lead.status,

        eventType:
          'outbound_message',

        message:
          cleanMessage
      });

    /*
    =====================================================
    SEM REGRA ENCONTRADA:
    MOVE NORMALMENTE PARA AGUARDANDO
    =====================================================
    */

    let finalStatus =
      automation.newStatus ||
      lead.status;

    if (!automation.matched) {
      await db.query(
        `
        UPDATE leads
        SET
          status = 'aguardando'::lead_status,
          last_contact_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        AND tenant_id = $2
        `,
        [
          lead_id,
          tenantId
        ]
      );

      finalStatus =
        'aguardando';
    }

    /*
    Mesmo quando a regra encontrou a mesma etapa,
    atualizamos o horário do contato.
    */

    if (automation.matched) {
      await db.query(
        `
        UPDATE leads
        SET
          last_contact_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        AND tenant_id = $2
        `,
        [
          lead_id,
          tenantId
        ]
      );
    }

    console.log(
      `✅ Mensagem enviada: ${lead.name || phone}`
    );

    console.log(
      `🤖 Resultado da automação:`,
      {
        matched:
          automation.matched,

        changed:
          automation.changed,

        previous_status:
          lead.status,

        final_status:
          finalStatus,

        rule:
          automation.rule?.name || null,

        reason:
          automation.reason
      }
    );

    return res.status(200).json({
      success: true,

      lead_id,

      phone,

      message:
        cleanMessage,

      automation: {
        matched:
          automation.matched,

        changed:
          automation.changed,

        previous_status:
          lead.status,

        new_status:
          finalStatus,

        rule_id:
          automation.rule?.id || null,

        rule_name:
          automation.rule?.name || null,

        matched_keyword:
          automation.matchedKeyword || null,

        reason:
          automation.reason
      },

      evolution:
        evolutionResponse.data
    });

  } catch (error) {
    const status =
      error.response?.status || 500;

    const details =
      error.response?.data || null;

    const errorMessage =
      details?.response?.message?.[0] ||
      details?.message ||
      details?.error ||
      error.message ||
      'Erro ao enviar mensagem';

    console.error(
      '❌ Erro no envio:',
      {
        message:
          error.message,

        status,

        details
      }
    );

    return res.status(
      status >= 400 &&
      status < 600
        ? status
        : 500
    ).json({
      success: false,

      error:
        typeof errorMessage === 'string'
          ? errorMessage
          : JSON.stringify(
              errorMessage
            ),

      details
    });
  }
});

module.exports = router;
