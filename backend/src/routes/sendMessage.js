const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { evolutionRequest } = require('../services/evolutionService');
const { publish } = require('../services/realtimeService');
const { scheduleLeadContextRefresh } = require('../services/contextQueueService');
const { ensureTeamSchema, getUserProfile } = require('../services/teamService');

const {
  processMessageAutomation
} = require('../services/automationEngine');

const router = express.Router();

router.use(auth);


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

    await ensureTeamSchema();
    const attendant = await getUserProfile(req.user.id, tenantId);
    let outgoingMessage = cleanMessage;

    if (attendant?.signature_enabled && attendant.signature_mode !== 'off') {
      let shouldSign = attendant.signature_mode === 'always';

      if (attendant.signature_mode === 'first_message') {
        const previous = await db.query(`
          SELECT id FROM messages
          WHERE tenant_id = $1 AND lead_id = $2 AND direction = 'outbound'
            AND sent_by_user_id = $3
            AND created_at >= NOW() - INTERVAL '12 hours'
          LIMIT 1
        `, [tenantId, lead_id, req.user.id]);
        shouldSign = previous.rows.length === 0;
      }

      if (shouldSign) {
        const signature = String(attendant.signature_text || `Olá, aqui é o ${attendant.name}.`).trim();
        if (signature && !cleanMessage.toLowerCase().startsWith(signature.toLowerCase())) {
          outgoingMessage = `${signature}

${cleanMessage}`;
        }
      }
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

    await db.query(`
      UPDATE leads
      SET assigned_to = COALESCE(assigned_to, $1), updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
    `, [req.user.id, lead_id, tenantId]);

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
    BUSCA A CONEXÃO DA EMPRESA
    =====================================================
    */

    const connectionResult = await db.query(
      `SELECT provider, instance_name, status
       FROM whatsapp_connections
       WHERE tenant_id = $1
       LIMIT 1`,
      [tenantId]
    );

    const connection = connectionResult.rows[0];

    if (!connection) {
      return res.status(409).json({
        success: false,
        error: 'Conecte o WhatsApp nas Configurações antes de enviar mensagens.'
      });
    }

    if (connection.provider !== 'evolution') {
      return res.status(409).json({
        success: false,
        error: 'O provedor de WhatsApp desta empresa ainda não está disponível para envio.'
      });
    }

    if (!connection.instance_name) {
      return res.status(409).json({
        success: false,
        error: 'Instância Evolution não configurada para esta empresa.'
      });
    }

    /*
    =====================================================
    ENVIA PARA O WHATSAPP
    =====================================================
    */

    const evolutionResponse = await evolutionRequest(
      'post',
      `/message/sendText/${encodeURIComponent(connection.instance_name)}`,
      { number: phone, text: outgoingMessage }
    );

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
        sent_by_user_id,
        sent_by_name,
        created_at
      )
      SELECT
        $1,
        $2,
        'outbound',
        $3,
        'text',
        $4,
        $5,
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
        outgoingMessage,
        req.user.id,
        attendant?.name || req.user.name || 'Equipe'
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

    publish(tenantId, 'message.created', {
      lead_id,
      direction: 'outbound',
      message: outgoingMessage,
      previous_status: lead.status,
      new_status: finalStatus,
      created_at: new Date().toISOString()
    });

    publish(tenantId, 'lead.updated', {
      lead_id,
      status: finalStatus
    });

    scheduleLeadContextRefresh({
      tenantId,
      leadId: lead_id,
      delayMs: 2500
    });

    return res.status(200).json({
      success: true,

      lead_id,

      phone,

      message:
        outgoingMessage,

      sent_by:
        attendant?.name || req.user.name || 'Equipe',

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
