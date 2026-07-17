const express = require('express');
const db = require('../db');

const router = express.Router();

const DEFAULT_TENANT_ID =
  '31bc576d-0b27-4ea9-8a81-769429dde7ed';

/*
=====================================================
NORMALIZA O TEXTO
=====================================================
*/

function normalizeText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
=====================================================
IDENTIFICA STATUS PELA CONVERSA
=====================================================
*/

function detectStatusFromMessage(message, direction) {
  const text = normalizeText(message);

  if (!text) {
    return {
      status: null,
      reason: 'Mensagem sem texto reconhecível'
    };
  }

  /*
  Evita movimentações erradas por frases negativas.
  */

  const negativePatterns = [
    'nao confirmado',
    'nao esta confirmado',
    'ainda nao confirmado',
    'ainda nao esta confirmado',
    'nao confirmou',
    'nao foi confirmado',
    'nao posso confirmar',
    'nao consigo confirmar',
    'nao quero marcar',
    'nao quero agendar',
    'nao posso ir',
    'nao vou conseguir ir',
    'pagamento nao confirmado',
    'pagamento ainda nao confirmado',
    'pix nao caiu',
    'pix ainda nao caiu',
    'nao foi pago',
    'ainda nao foi pago',
    'nao paguei',
    'servico nao concluido',
    'servico ainda nao concluido',
    'pedido nao finalizado'
  ];

  const negativeMatch =
    negativePatterns.find(pattern =>
      text.includes(pattern)
    );

  if (negativeMatch) {
    return {
      status: null,
      reason: `Frase negativa identificada: "${negativeMatch}"`
    };
  }

  /*
  =====================================================
  COMPRA / SERVIÇO REALIZADO
  =====================================================
  */

  const boughtPatterns = [
    'pagamento confirmado',
    'pagamento recebido',
    'pagamento aprovado',
    'pix confirmado',
    'pix recebido',
    'pix caiu',
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
    'agradecemos pela compra',
    'produto entregue',
    'pedido entregue',
    'pedido finalizado',
    'finalizamos seu atendimento',
    'finalizamos o atendimento'
  ];

  /*
  Algumas frases podem vir do próprio cliente.
  */

  const customerBoughtPatterns = [
    'ja fiz o pix',
    'acabei de fazer o pix',
    'pix feito',
    'ja paguei',
    'acabei de pagar',
    'pagamento realizado',
    'pagamento feito',
    'comprovante enviado'
  ];

  const boughtMatch =
    boughtPatterns.find(pattern =>
      text.includes(pattern)
    );

  if (boughtMatch) {
    return {
      status: 'comprou',
      reason: `Compra ou serviço identificado: "${boughtMatch}"`
    };
  }

  if (direction === 'inbound') {
    const customerBoughtMatch =
      customerBoughtPatterns.find(pattern =>
        text.includes(pattern)
      );

    if (customerBoughtMatch) {
      return {
        status: 'comprou',
        reason: `Cliente informou pagamento: "${customerBoughtMatch}"`
      };
    }
  }

  /*
  =====================================================
  FECHADO / AGENDADO
  =====================================================
  */

  const closedPatterns = [
    'agendamento confirmado',
    'agendamento realizado',
    'horario confirmado',
    'horario marcado',
    'ficou marcado',
    'ficou agendado',
    'ficou agendada',
    'esta agendado',
    'esta agendada',
    'agendado para',
    'agendada para',
    'confirmado para',
    'confirmada para',
    'confirmamos para',
    'confirmamos seu horario',
    'seu horario esta confirmado',
    'pode vir',
    'pode comparecer',
    'te esperamos',
    'esperamos voce',
    'combinado para',
    'fechado para',
    'reserva confirmada',
    'visita confirmada',
    'consulta confirmada'
  ];

  const customerClosedPatterns = [
    'pode marcar',
    'pode agendar',
    'quero marcar',
    'quero agendar',
    'pode confirmar',
    'confirmo',
    'esta confirmado',
    'estou confirmado',
    'vou sim',
    'eu vou',
    'estarei ai',
    'pode deixar marcado',
    'esse horario serve',
    'esse horario esta bom',
    'esse horario ta bom',
    'combinado',
    'fechado'
  ];

  const closedMatch =
    closedPatterns.find(pattern =>
      text.includes(pattern)
    );

  if (closedMatch) {
    return {
      status: 'fechado',
      reason: `Agendamento identificado: "${closedMatch}"`
    };
  }

  if (direction === 'inbound') {
    const customerClosedMatch =
      customerClosedPatterns.find(pattern =>
        text.includes(pattern)
      );

    if (customerClosedMatch) {
      return {
        status: 'fechado',
        reason: `Cliente confirmou: "${customerClosedMatch}"`
      };
    }
  }

  /*
  Nenhuma frase especial encontrada.
  */

  return {
    status: null,
    reason: 'Nenhuma regra especial identificada'
  };
}

/*
=====================================================
REGISTRA ALTERAÇÃO AUTOMÁTICA
=====================================================
*/

async function registerStatusActivity({
  tenantId,
  leadId,
  oldStatus,
  newStatus,
  direction,
  reason,
  message
}) {
  if (!newStatus || oldStatus === newStatus) {
    return;
  }

  const description =
    `Status alterado automaticamente de "${oldStatus}" para "${newStatus}"`;

  /*
  Evita atividade duplicada caso a mesma mensagem seja
  processada pelo envio do CRM e também pelo webhook.
  */

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
    SELECT
      $1,
      $2,
      NULL,
      'status_change',
      $3,
      $4
    WHERE NOT EXISTS (
      SELECT 1
      FROM lead_activities
      WHERE tenant_id = $1
      AND lead_id = $2
      AND type = 'status_change'
      AND description = $3
      AND created_at >=
        NOW() - INTERVAL '20 seconds'
    )
    `,
    [
      tenantId,
      leadId,
      description,
      JSON.stringify({
        from: oldStatus,
        to: newStatus,
        source: 'whatsapp_webhook_rule',
        direction,
        reason,
        message
      })
    ]
  );
}

/*
=====================================================
SALVA MENSAGEM SEM DUPLICAR
=====================================================
*/

async function saveMessage({
  tenantId,
  leadId,
  direction,
  message
}) {
  if (!leadId || !message) {
    return;
  }

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
      $3,
      $4,
      'text',
      NOW()
    WHERE NOT EXISTS (
      SELECT 1
      FROM messages
      WHERE tenant_id = $1
      AND lead_id = $2
      AND direction = $3
      AND message = $4
      AND created_at >=
        NOW() - INTERVAL '15 seconds'
    )
    `,
    [
      tenantId,
      leadId,
      direction,
      message
    ]
  );
}

/*
=====================================================
WEBHOOK DA EVOLUTION
=====================================================
*/

router.post('/webhook', async (req, res) => {
  try {
    const event = req.body.event;
    const data = req.body.data;

    if (
      event !== 'messages.upsert' ||
      !data
    ) {
      return res.status(200).json({
        ignored: true
      });
    }

    /*
    Ignora mensagens de grupos.
    */

    const remoteJid =
      data.key?.remoteJid || '';

    if (
      remoteJid.endsWith('@g.us') ||
      remoteJid === 'status@broadcast'
    ) {
      return res.status(200).json({
        ignored: true,
        reason: 'Grupo ou status'
      });
    }

    let phone =
      remoteJid
        .replace('@s.whatsapp.net', '')
        .replace('@lid', '')
        .replace(/\D/g, '');

    if (!phone) {
      return res.status(200).json({
        ignored: true,
        reason: 'Telefone não encontrado'
      });
    }

    if (!phone.startsWith('55')) {
      phone = `55${phone}`;
    }

    const name =
      data.pushName ||
      phone;

    const message =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text ||
      data.message?.imageMessage?.caption ||
      data.message?.videoMessage?.caption ||
      data.message?.documentMessage?.caption ||
      '';

    const fromMe =
      data.key?.fromMe === true;

    const direction =
      fromMe
        ? 'outbound'
        : 'inbound';

    /*
    =====================================================
    PROCURA O LEAD
    =====================================================
    */

    const existingLead =
      await db.query(
        `
        SELECT
          id,
          status,
          name,
          phone
        FROM leads
        WHERE tenant_id = $1
        AND phone = $2
        LIMIT 1
        `,
        [
          DEFAULT_TENANT_ID,
          phone
        ]
      );

    let leadId = null;
    let previousStatus = null;

    /*
    =====================================================
    NOVO CONTATO
    =====================================================
    */

    if (
      existingLead.rows.length === 0
    ) {
      /*
      Uma mensagem enviada pela própria equipe para um
      número ainda não cadastrado não cria lead neste momento.
      */

      if (fromMe) {
        return res.status(200).json({
          ignored: true,
          reason:
            'Mensagem enviada para número ainda não cadastrado'
        });
      }

      const classification =
        detectStatusFromMessage(
          message,
          'inbound'
        );

      const initialStatus =
        classification.status ||
        'novo';

      const newLead =
        await db.query(
          `
          INSERT INTO leads (
            tenant_id,
            name,
            phone,
            status,
            origin,
            notes,
            last_contact_at,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'WhatsApp',
            $5,
            NOW(),
            NOW(),
            NOW()
          )
          RETURNING
            id,
            status
          `,
          [
            DEFAULT_TENANT_ID,
            name,
            phone,
            initialStatus,
            message || null
          ]
        );

      leadId =
        newLead.rows[0].id;

      previousStatus =
        'novo';

      console.log(
        `✅ Novo lead criado automaticamente: ${name} | ${phone}`
      );

    } else {
      leadId =
        existingLead.rows[0].id;

      previousStatus =
        existingLead.rows[0].status;
    }

    /*
    =====================================================
    SALVA A MENSAGEM
    =====================================================
    */

    await saveMessage({
      tenantId: DEFAULT_TENANT_ID,
      leadId,
      direction,
      message
    });

    /*
    =====================================================
    IDENTIFICA MOVIMENTAÇÃO
    =====================================================
    */

    const classification =
      detectStatusFromMessage(
        message,
        direction
      );

    let newStatus =
      classification.status;

    /*
    Mensagem comum enviada pela equipe:
    aguarda resposta do cliente.
    */

    if (
      fromMe &&
      !newStatus
    ) {
      newStatus =
        'aguardando';

      classification.reason =
        'Mensagem enviada pela equipe; aguardando resposta';
    }

    /*
    Mensagem comum recebida:
    movimenta apenas etapas que representam ausência
    de atendimento. Não tira comprado, fechado ou
    assinante das etapas automaticamente.
    */

    if (
      !fromMe &&
      !newStatus
    ) {
      if (
        [
          'novo',
          'aguardando',
          'inativo',
          'sumido'
        ].includes(previousStatus)
      ) {
        newStatus =
          'atendendo';

        classification.reason =
          'Cliente respondeu novamente';
      } else {
        newStatus =
          previousStatus;

        classification.reason =
          'Status atual preservado';
      }
    }

    /*
    =====================================================
    ATUALIZA O LEAD
    =====================================================
    */

    await db.query(
      `
      UPDATE leads
      SET
       status = $1::lead_status,
        last_contact_at = NOW(),
        updated_at = NOW(),

        closed_at =
          CASE
           WHEN $1::lead_status = 'fechado'::lead_status
            THEN COALESCE(
              closed_at,
              NOW()
            )
            ELSE closed_at
          END,

        bought_at =
          CASE
            WHEN $1::lead_status = 'comprou'::lead_status
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
        leadId,
        DEFAULT_TENANT_ID
      ]
    );

    await registerStatusActivity({
      tenantId:
        DEFAULT_TENANT_ID,

      leadId,

      oldStatus:
        previousStatus,

      newStatus,

      direction,

      reason:
        classification.reason,

      message
    });

    console.log(
      `${fromMe ? '📤' : '📥'} ${phone} | ` +
      `${previousStatus} → ${newStatus} | ` +
      classification.reason
    );

    return res.status(200).json({
      success: true,
      lead_id: leadId,
      direction,
      previous_status:
        previousStatus,
      new_status:
        newStatus,
      reason:
        classification.reason
    });

  } catch (error) {
    console.error(
      'Erro webhook Evolution:',
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error.message
    });
  }
});

module.exports = router;
