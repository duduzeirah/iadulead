const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { evolutionRequest, publicBackendUrl, safeInstanceName, extractQr, extractState } = require('../services/evolutionService');
const { publish } = require('../services/realtimeService');

const {
  processMessageAutomation
} = require('../services/automationEngine');

const router = express.Router();


/*
=====================================================
CONEXÃO EVOLUTION MULTIEMPRESA
=====================================================
*/

async function getTenantConnection(tenantId, { bootstrap = true } = {}) {
  let result = await db.query(
    `SELECT * FROM whatsapp_connections WHERE tenant_id = $1 LIMIT 1`,
    [tenantId]
  );

  if (result.rows[0] || !bootstrap) return result.rows[0] || null;

  // Preserva a instância antiga para a primeira empresa já existente.
  const legacyInstance = String(process.env.EVOLUTION_INSTANCE || '').trim();
  let instanceName = safeInstanceName(tenantId);

  if (legacyInstance) {
    const used = await db.query(
      `SELECT tenant_id FROM whatsapp_connections WHERE instance_name = $1 LIMIT 1`,
      [legacyInstance]
    );
    if (!used.rows.length) instanceName = legacyInstance;
  }

  result = await db.query(
    `INSERT INTO whatsapp_connections (
       tenant_id, provider, instance_name, status, created_at, updated_at
     ) VALUES ($1, 'evolution', $2, 'disconnected', NOW(), NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [tenantId, instanceName]
  );

  return result.rows[0];
}

async function getConnectionByInstance(instanceName) {
  if (!instanceName) return null;
  const result = await db.query(
    `SELECT * FROM whatsapp_connections WHERE instance_name = $1 LIMIT 1`,
    [String(instanceName)]
  );
  return result.rows[0] || null;
}

async function updateConnection(tenantId, values = {}) {
  const result = await db.query(
    `UPDATE whatsapp_connections SET
       status = COALESCE($2, status),
       phone_number = COALESCE($3, phone_number),
       connected_at = CASE WHEN $2 = 'connected' THEN COALESCE(connected_at, NOW()) ELSE connected_at END,
       last_error = $4,
       metadata = COALESCE($5::jsonb, metadata),
       updated_at = NOW()
     WHERE tenant_id = $1
     RETURNING *`,
    [tenantId, values.status || null, values.phoneNumber || null, values.lastError || null, values.metadata ? JSON.stringify(values.metadata) : null]
  );
  return result.rows[0] || null;
}

router.get('/status', auth, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const connection = await getTenantConnection(tenantId);
    let state = connection.status || 'disconnected';

    try {
      const response = await evolutionRequest('get', `/instance/connectionState/${encodeURIComponent(connection.instance_name)}`);
      const rawState = extractState(response.data);
      state = ['open', 'connected'].includes(String(rawState).toLowerCase()) ? 'connected' :
        ['connecting'].includes(String(rawState).toLowerCase()) ? 'connecting' : 'disconnected';
      await updateConnection(tenantId, { status: state, metadata: response.data });
    } catch (error) {
      // Uma instância ainda não criada deve aparecer apenas como desconectada.
      if (![400, 404].includes(error.response?.status)) throw error;
      state = 'disconnected';
    }

    return res.json({
      provider: connection.provider,
      instance_name: connection.instance_name,
      status: state,
      phone_number: connection.phone_number,
      connected_at: connection.connected_at,
      meta_available: Boolean(process.env.META_APP_ID && process.env.META_CONFIG_ID)
    });
  } catch (error) {
    console.error('Erro ao consultar conexão WhatsApp:', error.response?.data || error);
    return res.status(500).json({ error: error.message || 'Erro ao consultar conexão' });
  }
});

router.post('/evolution/connect', auth, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const connection = await getTenantConnection(tenantId);
    const instanceName = connection.instance_name;

    try {
      await evolutionRequest('post', '/instance/create', {
        instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true
      });
    } catch (error) {
      // Se a instância já existe, seguimos para gerar/consultar o QR.
      if (![400, 403, 409].includes(error.response?.status)) throw error;
    }

    try {
      await evolutionRequest('post', `/webhook/set/${encodeURIComponent(instanceName)}`, {
        webhook: {
          enabled: true,
          url: `${publicBackendUrl()}/api/whatsapp/webhook`,
          webhookByEvents: false,
          webhookBase64: false,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
        }
      });
    } catch (error) {
      console.warn('Não foi possível atualizar webhook:', error.response?.data || error.message);
    }

    const qrResponse = await evolutionRequest('get', `/instance/connect/${encodeURIComponent(instanceName)}`);
    const qr = extractQr(qrResponse.data);

    await updateConnection(tenantId, { status: 'connecting', metadata: qrResponse.data });

    return res.json({
      success: true,
      provider: 'evolution',
      instance_name: instanceName,
      status: 'connecting',
      qr_code: qr,
      raw: qr ? undefined : qrResponse.data
    });
  } catch (error) {
    console.error('Erro ao conectar Evolution:', error.response?.data || error);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message || 'Erro ao gerar QR Code'
    });
  }
});

router.post('/evolution/disconnect', auth, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const connection = await getTenantConnection(tenantId, { bootstrap: false });
    if (!connection) return res.status(404).json({ error: 'Conexão não encontrada' });

    try {
      await evolutionRequest('delete', `/instance/logout/${encodeURIComponent(connection.instance_name)}`);
    } catch (error) {
      if (![400, 404].includes(error.response?.status)) throw error;
    }

    await updateConnection(tenantId, { status: 'disconnected', metadata: {} });
    return res.json({ success: true, status: 'disconnected' });
  } catch (error) {
    console.error('Erro ao desconectar Evolution:', error.response?.data || error);
    return res.status(error.response?.status || 500).json({ error: error.message || 'Erro ao desconectar' });
  }
});


function extractEvolutionMessageText(item) {
  const msg = item?.message || item?.data?.message || {};
  return String(
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    (msg.audioMessage ? '🎵 Áudio' : '') ||
    (msg.imageMessage ? '🖼️ Imagem' : '') ||
    (msg.videoMessage ? '🎥 Vídeo' : '') ||
    (msg.documentMessage ? `📎 Documento${msg.documentMessage.fileName ? ': '+msg.documentMessage.fileName : ''}` : '') ||
    (msg.stickerMessage ? '🏷️ Figurinha' : '') ||
    (msg.contactMessage ? '👤 Contato' : '') ||
    (msg.locationMessage ? '📍 Localização' : '') ||
    '[Mensagem não textual]'
  ).trim();
}

router.post('/evolution/sync/:leadId', auth, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { leadId } = req.params;
    const leadResult = await db.query(
      'SELECT id, phone FROM leads WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [leadId, tenantId]
    );
    const lead = leadResult.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });

    const connection = await getTenantConnection(tenantId, { bootstrap: false });
    if (!connection?.instance_name) return res.status(409).json({ error: 'WhatsApp não conectado.' });

    let phone = String(lead.phone || '').replace(/\D/g, '');
    if (!phone.startsWith('55')) phone = `55${phone}`;
    const remoteJid = `${phone}@s.whatsapp.net`;

    const response = await evolutionRequest(
      'post',
      `/chat/findMessages/${encodeURIComponent(connection.instance_name)}`,
      { where: { key: { remoteJid } }, page: 1, offset: 1000 }
    );

    const payload = response.data || {};
    const records = payload.messages?.records || payload.records || payload.messages || payload.data || [];
    const list = Array.isArray(records) ? records : [];
    let imported = 0;

    for (const item of list) {
      const key = item.key || item.data?.key || {};
      const direction = key.fromMe === true ? 'outbound' : 'inbound';
      const text = extractEvolutionMessageText(item);
      const rawTs = item.messageTimestamp || item.timestamp || item.createdAt || item.data?.messageTimestamp;
      const createdAt = /^\d+$/.test(String(rawTs || ''))
        ? new Date(Number(rawTs) * (String(rawTs).length <= 10 ? 1000 : 1))
        : new Date(rawTs || Date.now());

      const result = await db.query(
        `INSERT INTO messages (tenant_id, lead_id, direction, message, message_type, created_at)
         SELECT $1,$2,$3,$4,'text',$5
         WHERE NOT EXISTS (
           SELECT 1 FROM messages
           WHERE tenant_id=$1 AND lead_id=$2 AND direction=$3 AND message=$4
           AND created_at BETWEEN $5::timestamptz - INTERVAL '3 seconds'
                              AND $5::timestamptz + INTERVAL '3 seconds'
         )`,
        [tenantId, leadId, direction, text, createdAt.toISOString()]
      );
      imported += result.rowCount || 0;
    }

    publish(tenantId, 'message.created', { lead_id: leadId, synced: true, imported });
    return res.json({ success: true, found: list.length, imported });
  } catch (error) {
    console.error('Erro ao sincronizar histórico:', error.response?.data || error);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message || 'Erro ao sincronizar histórico.'
    });
  }
});

router.get('/meta/start', auth, async (req, res) => {
  return res.status(501).json({
    error: 'A conexão oficial da Meta está preparada na interface, mas depende do cadastro do aplicativo e do Embedded Signup.'
  });
});

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
    const event = req.body.event;
    const data = req.body.data;
    const instanceName = req.body.instance || data?.instance || req.query.instance;
    const connection = await getConnectionByInstance(instanceName);

    if (!connection) {
      return res.status(200).json({ ignored: true, reason: 'Instância não vinculada a uma empresa' });
    }

    const tenantId = connection.tenant_id;

    if (event === 'connection.update') {
      const rawState = data?.state || data?.status || data?.connectionStatus;
      const status = ['open', 'connected'].includes(String(rawState).toLowerCase())
        ? 'connected'
        : ['connecting'].includes(String(rawState).toLowerCase())
          ? 'connecting'
          : 'disconnected';

      const phoneNumber = String(data?.wuid || data?.number || '').split('@')[0].replace(/\D/g, '') || null;
      await updateConnection(tenantId, { status, phoneNumber, metadata: data || {} });
      publish(tenantId, 'whatsapp.status', {
        status,
        phone_number: phoneNumber,
        instance_name: instanceName
      });
      return res.status(200).json({ success: true, status });
    }

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

    const rawMessage = data.message || {};
    const message =
      rawMessage.conversation ||
      rawMessage.extendedTextMessage?.text ||
      rawMessage.imageMessage?.caption ||
      rawMessage.videoMessage?.caption ||
      rawMessage.documentMessage?.caption ||
      rawMessage.buttonsResponseMessage?.selectedDisplayText ||
      rawMessage.listResponseMessage?.title ||
      '';

    const mediaLabel =
      rawMessage.audioMessage ? '🎵 Áudio' :
      rawMessage.imageMessage ? '🖼️ Imagem' :
      rawMessage.videoMessage ? '🎥 Vídeo' :
      rawMessage.documentMessage ? `📎 Documento${rawMessage.documentMessage.fileName ? ': '+rawMessage.documentMessage.fileName : ''}` :
      rawMessage.stickerMessage ? '🏷️ Figurinha' :
      rawMessage.contactMessage ? '👤 Contato' :
      rawMessage.locationMessage ? '📍 Localização' :
      rawMessage.reactionMessage ? `Reação ${rawMessage.reactionMessage.text || ''}`.trim() :
      '';

    const cleanMessage = String(message || mediaLabel || '[Mensagem não textual]').trim();

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
          tenantId,
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
            tenantId,
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
        tenantId,

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
              tenantId,

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
            tenantId,

          leadId
        });

      } else {
        finalStatus =
          await applyDefaultMovement({
            tenantId:
              tenantId,

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
          tenantId,

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

    publish(tenantId, 'message.created', {
      lead_id: leadId,
      direction,
      message: cleanMessage,
      previous_status: currentStatus,
      new_status: finalStatus,
      is_new_lead: isNewLead,
      created_at: new Date().toISOString()
    });

    publish(tenantId, 'lead.updated', {
      lead_id: leadId,
      status: finalStatus,
      is_new_lead: isNewLead
    });

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
