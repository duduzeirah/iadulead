const express = require('express');
const db = require('../db');

const {
  processMessageAutomation
} = require('../services/automationEngine');

const router = express.Router();

const DEFAULT_TENANT_ID =
  '31bc576d-0b27-4ea9-8a81-769429dde7ed';

/*
=====================================================
SALVA A MENSAGEM SEM DUPLICAR
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
MOVIMENTAÇÃO PADRÃO QUANDO NÃO EXISTE REGRA
=====================================================
*/

async function applyDefaultMovement({
  tenantId,
  leadId,
  currentStatus,
  direction
}) {
  let newStatus =
    currentStatus;

  /*
  Mensagem enviada pela equipe:
  fica aguardando a resposta do cliente.
  */

  if (direction === 'outbound') {
    newStatus =
      'aguardando';
  }

  /*
  Mensagem recebida do cliente:
  volta para atendimento apenas quando estava
  aguardando, novo, inativo ou sumido.

  Não remove automaticamente clientes de:
  - horário marcado;
  - serviço realizado;
  - cliente recorrente.
  */

  if (
    direction === 'inbound' &&
    [
      'novo',
      'aguardando',
      'inativo',
      'sumido'
    ].includes(currentStatus)
  ) {
    newStatus =
      'atendendo';
  }

  await db.query(
    `
    UPDATE leads
    SET
      status = $1::lead_status,
      last_contact_at = NOW(),
      updated_at = NOW()
    WHERE id = $2
    AND tenant_id = $3
    `,
    [
      newStatus,
      leadId,
      tenantId
    ]
  );

  return newStatus;
}

/*
=====================================================
ATUALIZA SOMENTE O ÚLTIMO CONTATO
=====================================================
*/

async function updateLastContact({
  tenantId,
  leadId
}) {
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
      leadId,
      tenantId
    ]
  );
}

/*
=====================================================
WEBHOOK DA EVOLUTION API
=====================================================
*/

router.post('/webhook', async (req, res) => {
  try {
    const event =
      req.body.event;

    const data =
      req.body.data;

    /*
    Aceita somente eventos de mensagem.
    */

    if (
      event !== 'messages.upsert' ||
      !data
    ) {
      return res.status(200).json({
        ignored: true,
        reason:
          'Evento não utilizado'
      });
    }

    const key =
      data.key || {};

    /*
    =====================================================
    IDENTIFICA O CONTATO
    =====================================================
    */

    const jidCandidates = [
      key.remoteJidAlt,
      key.participantAlt,
      data.remoteJidAlt,
      data.senderPn,
      key.remoteJid,
      key.participant
    ].filter(Boolean);

    const phoneJid =
      jidCandidates.find(jid =>
        String(jid).endsWith(
          '@s.whatsapp.net'
        )
      );

    const remoteJid =
      phoneJid ||
      key.remoteJid ||
      '';

    /*
    Ignora grupos e status do WhatsApp.
    */

    if (
      remoteJid.endsWith('@g.us') ||
      remoteJid === 'status@broadcast'
    ) {
      return res.status(200).json({
        ignored: true,
        reason:
          'Grupo ou status do WhatsApp'
      });
    }

    /*
    Quando a Evolution envia apenas @lid,
    tentamos usar os campos alternativos.

    Não usamos o número do LID como telefone real.
    */

    if (
      !phoneJid &&
      String(remoteJid).endsWith('@lid')
    ) {
      console.log(
        '⚠️ Mensagem recebida somente com @lid:',
        {
          remoteJid:
            key.remoteJid,

          remoteJidAlt:
            key.remoteJidAlt,

          participant:
            key.participant,

          participantAlt:
            key.participantAlt,

          senderPn:
            data.senderPn,

          fromMe:
            key.fromMe
        }
      );

      return res.status(200).json({
        ignored: true,
        reason:
          'Telefone verdadeiro não enviado pela Evolution'
      });
    }

    let phone =
      String(remoteJid)
        .split('@')[0]
        .replace(/\D/g, '');

    if (!phone) {
      return res.status(200).json({
        ignored: true,
        reason:
          'Telefone não encontrado'
      });
    }

    if (!phone.startsWith('55')) {
      phone =
        `55${phone}`;
    }

    /*
    =====================================================
    IDENTIFICA A MENSAGEM
    =====================================================
    */

    const message =
      data.message?.conversation ||
      data.message
        ?.extendedTextMessage?.text ||
      data.message
        ?.imageMessage?.caption ||
      data.message
        ?.videoMessage?.caption ||
      data.message
        ?.documentMessage?.caption ||
      '';

    const cleanMessage =
      String(message || '').trim();

    const fromMe =
      key.fromMe === true;

    const direction =
      fromMe
        ? 'outbound'
        : 'inbound';

    const eventType =
      fromMe
        ? 'outbound_message'
        : 'inbound_message';

    const name =
      data.pushName ||
      phone;

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
          name,
          phone,
          status
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

    let leadId =
      null;

    let currentStatus =
      null;

    let isNewLead =
      false;

    /*
    =====================================================
    NOVO LEAD
    =====================================================
    */

    if (
      existingLead.rows.length === 0
    ) {
      /*
      Mensagem enviada pela equipe para um número
      ainda não cadastrado não cria lead automaticamente.
      */

      if (fromMe) {
        return res.status(200).json({
          ignored: true,
          reason:
            'Mensagem enviada para número não cadastrado'
        });
      }

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
            'novo'::lead_status,
            'WhatsApp',
            $4,
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
            cleanMessage || null
          ]
        );

      leadId =
        newLead.rows[0].id;

      currentStatus =
        newLead.rows[0].status;

      isNewLead =
        true;

      console.log(
        `✅ Novo lead criado: ${name} | ${phone}`
      );

    } else {
      leadId =
        existingLead.rows[0].id;

      currentStatus =
        existingLead.rows[0].status;
    }

    /*
    =====================================================
    SALVA A MENSAGEM
    =====================================================
    */

    await saveMessage({
      tenantId:
        DEFAULT_TENANT_ID,

      leadId,

      direction,

      message:
        cleanMessage
    });

    /*
    =====================================================
    EXECUTA O MOTOR CENTRAL
    =====================================================
    */

    const automation =
      cleanMessage
        ? await processMessageAutomation({
            tenantId:
              DEFAULT_TENANT_ID,

            leadId,

            userId:
              null,

            currentStatus,

            eventType,

            message:
              cleanMessage
          })
        : {
            matched: false,
            changed: false,
            newStatus:
              currentStatus,
            rule: null,
            reason:
              'Mensagem sem texto'
          };

    let finalStatus =
      automation.newStatus ||
      currentStatus;

    /*
    =====================================================
    SEM REGRA ENCONTRADA
    =====================================================
    */

    if (!automation.matched) {
      /*
      Novo contato continua como Novo Lead.

      A primeira mensagem não precisa mover imediatamente
      para Em atendimento antes que a equipe responda.
      */

      if (
        isNewLead &&
        direction === 'inbound'
      ) {
        finalStatus =
          currentStatus;

        await updateLastContact({
          tenantId:
            DEFAULT_TENANT_ID,

          leadId
        });

      } else {
        finalStatus =
          await applyDefaultMovement({
            tenantId:
              DEFAULT_TENANT_ID,

            leadId,

            currentStatus,

            direction
          });
      }
    }

    /*
    Se a automação encontrou uma regra, mas o lead já
    estava na etapa correta, atualizamos o último contato.
    */

    if (automation.matched) {
      await updateLastContact({
        tenantId:
          DEFAULT_TENANT_ID,

        leadId
      });
    }

    console.log(
      `${fromMe ? '📤' : '📥'} ${phone} | ` +
      `${currentStatus} → ${finalStatus}`
    );

    console.log(
      '🤖 Resultado do motor:',
      {
        event:
          eventType,

        matched:
          automation.matched,

        changed:
          automation.changed,

        rule:
          automation.rule?.name ||
          null,

        reason:
          automation.reason
      }
    );

    return res.status(200).json({
      success: true,

      lead_id:
        leadId,

      direction,

      event_type:
        eventType,

      previous_status:
        currentStatus,

      new_status:
        finalStatus,

      automation: {
        matched:
          automation.matched,

        changed:
          automation.changed,

        rule_id:
          automation.rule?.id ||
          null,

        rule_name:
          automation.rule?.name ||
          null,

        matched_keyword:
          automation.matchedKeyword ||
          null,

        reason:
          automation.reason
      }
    });

  } catch (error) {
    console.error(
      '❌ Erro webhook Evolution:',
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
