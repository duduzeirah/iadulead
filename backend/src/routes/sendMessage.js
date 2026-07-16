const express = require('express');
const axios = require('axios');
const db = require('../db');
const { auth } = require('../middleware/auth');

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
NORMALIZA TEXTO
=====================================================
*/

function normalizeText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/*
=====================================================
RECONHECE O STATUS PELA MENSAGEM
=====================================================
*/

function detectStatusFromMessage(message) {
  const text = normalizeText(message);

  /*
  Frases negativas evitam mudar o cliente por engano.

  Exemplos:
  - ainda não está confirmado
  - não confirmou
  - pagamento não confirmado
  */

  const negativePatterns = [
    'nao confirmado',
    'nao esta confirmado',
    'ainda nao confirmado',
    'ainda nao esta confirmado',
    'nao confirmou',
    'nao foi confirmado',
    'pagamento nao confirmado',
    'pagamento ainda nao confirmado',
    'pix nao caiu',
    'pix ainda nao caiu',
    'nao foi pago',
    'ainda nao foi pago',
    'servico nao concluido',
    'servico ainda nao concluido'
  ];

  const hasNegativePattern =
    negativePatterns.some(pattern =>
      text.includes(pattern)
    );

  if (hasNegativePattern) {
    return {
      status: 'aguardando',
      reason:
        'Mensagem possui indicação de pendência ou negativa'
    };
  }

  /*
  COMPRA / SERVIÇO REALIZADO

  Tem prioridade sobre "fechado".
  */

  const boughtPatterns = [
    'pagamento confirmado',
    'pix confirmado',
    'pix recebido',
    'pagamento recebido',
    'pagamento aprovado',
    'pedido pago',
    'compra finalizada',
    'compra concluida',
    'venda finalizada',
    'venda concluida',
    'servico realizado',
    'servico concluido',
    'procedimento realizado',
    'procedimento concluido',
    'atendimento concluido',
    'atendimento finalizado',
    'parabens pela compra',
    'obrigado pela compra',
    'produto entregue',
    'pedido entregue'
  ];

  const boughtMatch =
    boughtPatterns.find(pattern =>
      text.includes(pattern)
    );

  if (boughtMatch) {
    return {
      status: 'comprou',
      reason:
        `Frase reconhecida: "${boughtMatch}"`
    };
  }

  /*
  FECHADO / HORÁRIO MARCADO
  */

  const closedPatterns = [
    'agendamento confirmado',
    'horario confirmado',
    'horario marcado',
    'ficou marcado',
    'esta agendado',
    'esta agendada',
    'agendado para',
    'agendada para',
    'confirmado para',
    'confirmada para',
    'pode vir',
    'pode comparecer',
    'te esperamos',
    'esperamos voce',
    'combinado para',
    'fechado para',
    'reserva confirmada',
    'visita confirmada'
  ];

  const closedMatch =
    closedPatterns.find(pattern =>
      text.includes(pattern)
    );

  if (closedMatch) {
    return {
      status: 'fechado',
      reason:
        `Frase reconhecida: "${closedMatch}"`
    };
  }

  /*
  Nenhuma regra encontrada:
  mensagem enviada normalmente fica aguardando resposta.
  */

  return {
    status: 'aguardando',
    reason:
      'Mensagem enviada; aguardando resposta'
  };
}

/*
=====================================================
POST /api/sendmessage
ENVIA E SALVA A MENSAGEM NO CRM
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
        error:
          'Lead não informado'
      });
    }

    const cleanMessage =
      String(message || '').trim();

    if (!cleanMessage) {
      return res.status(400).json({
        success: false,
        error:
          'Mensagem não pode ser vazia'
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
        error:
          'Lead não encontrado'
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
        error:
          'Lead sem telefone válido'
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
    ENVIA A MENSAGEM PARA O WHATSAPP
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
    SALVA A MENSAGEM NO HISTÓRICO
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
    IDENTIFICA O NOVO STATUS
    =====================================================
    */

    const classification =
      detectStatusFromMessage(
        cleanMessage
      );

    const newStatus =
      classification.status;

    /*
    =====================================================
    ATUALIZA O LEAD
    =====================================================
    */

    await db.query(
      `
      UPDATE leads
      SET
        status = $1,
        last_contact_at = NOW(),
        updated_at = NOW(),

        closed_at =
          CASE
            WHEN $1 = 'fechado'
            THEN COALESCE(
              closed_at,
              NOW()
            )
            ELSE closed_at
          END,

        bought_at =
          CASE
            WHEN $1 = 'comprou'
            THEN COALESCE(
              bought_at,
              NOW()
            )
            ELSE bought_at
          END

      WHERE id = $2
      AND tenant_id = $3
      `,
      [
        newStatus,
        lead_id,
        tenantId
      ]
    );

    /*
    =====================================================
    REGISTRA A MUDANÇA NO HISTÓRICO
    =====================================================
    */

    if (
      newStatus !== lead.status
    ) {
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
          lead_id,
          req.user.id,

          `Status alterado automaticamente de "${lead.status}" para "${newStatus}"`,

          JSON.stringify({
            from:
              lead.status,

            to:
              newStatus,

            source:
              'message_rule',

            reason:
              classification.reason,

            message:
              cleanMessage
          })
        ]
      );
    }

    console.log(
      `✅ Mensagem enviada: ${lead.name || phone}`
    );

    console.log(
      `🤖 Status identificado: ${newStatus} — ${classification.reason}`
    );

    return res.status(200).json({
      success: true,
      lead_id,
      phone,
      message:
        cleanMessage,

      automation: {
        previous_status:
          lead.status,

        new_status:
          newStatus,

        changed:
          newStatus !== lead.status,

        reason:
          classification.reason
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
