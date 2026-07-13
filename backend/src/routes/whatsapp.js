const express = require('express');
const db = require('../db');

const router = express.Router();

const DEFAULT_TENANT_ID = '31bc576d-0b27-4ea9-8a81-769429dde7ed';

router.post('/webhook', async (req, res) => {
  try {

    const event = req.body.event;
    const data = req.body.data;

    // aceita apenas mensagens
    if (
      event !== 'messages.upsert' ||
      !data
    ) {
      return res.status(200).json({
        ignored: true
      });
    }

    let phone = data.key?.remoteJid
      ?.replace('@s.whatsapp.net', '')
      ?.replace('@lid', '')
      ?.replace(/\D/g, '');

    if (!phone) {
      return res.status(200).json({
        ignored: true
      });
    }

    // padroniza todos os números
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
      '';

    /*
    ============================================
    PROCURA LEAD EXISTENTE
    ============================================
    */

    const existingLead = await db.query(`
      SELECT id, status
      FROM leads
      WHERE tenant_id = $1
      AND phone = $2
      LIMIT 1
    `, [
      DEFAULT_TENANT_ID,
      phone
    ]);

    let leadId = null;

    /*
    ============================================
    MENSAGEM ENVIADA PELA EQUIPE
    move para AGUARDANDO
    ============================================
    */

    if (data.key?.fromMe === true) {

      if (existingLead.rows.length > 0) {

        leadId = existingLead.rows[0].id;

        await db.query(`
          UPDATE leads
          SET
            status = 'aguardando',
            last_contact_at = NOW(),
            updated_at = NOW()
          WHERE tenant_id = $1
          AND phone = $2
        `, [
          DEFAULT_TENANT_ID,
          phone
        ]);

        if (message) {
          await db.query(`
            INSERT INTO messages (
              tenant_id,
              lead_id,
              direction,
              message,
              message_type,
              created_at
            )
            VALUES (
              $1,
              $2,
              'outbound',
              $3,
              'text',
              NOW()
            )
          `, [
            DEFAULT_TENANT_ID,
            leadId,
            message
          ]);
        }

        console.log(
          `🟡 Lead movido para aguardando: ${phone}`
        );
      }

      return res.status(200).json({
        moved: true
      });
    }

    /*
    ============================================
    NOVO LEAD
    ============================================
    */

    if (existingLead.rows.length === 0) {

      const newLead = await db.query(`
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
          'novo',
          'WhatsApp',
          $4,
          NOW(),
          NOW(),
          NOW()
        )
        RETURNING id
      `, [
        DEFAULT_TENANT_ID,
        name,
        phone,
        message
      ]);

      leadId = newLead.rows[0].id;

      console.log(
        `✅ Novo lead criado automaticamente: ${name} | ${phone}`
      );

    } else {

      leadId = existingLead.rows[0].id;

      /*
      ============================================
      CLIENTE RESPONDEU NOVAMENTE
      ============================================
      */

      await db.query(`
        UPDATE leads
        SET
          status = CASE
            WHEN status IN (
              'novo',
              'aguardando',
              'inativo',
              'sumido'
            )
            THEN 'atendendo'
            ELSE status
          END,
          last_contact_at = NOW(),
          updated_at = NOW()
        WHERE tenant_id = $1
        AND phone = $2
      `, [
        DEFAULT_TENANT_ID,
        phone
      ]);

      console.log(
        `🔄 Lead atualizado automaticamente: ${phone}`
      );
    }

    /*
    ============================================
    SALVA MENSAGEM RECEBIDA
    ============================================
    */

    if (leadId && message) {

      await db.query(`
        INSERT INTO messages (
          tenant_id,
          lead_id,
          direction,
          message,
          message_type,
          created_at
        )
        VALUES (
          $1,
          $2,
          'inbound',
          $3,
          'text',
          NOW()
        )
      `, [
        DEFAULT_TENANT_ID,
        leadId,
        message
      ]);
    }

    return res.status(200).json({
      success: true
    });

  } catch (error) {

    console.error(
      'Erro webhook Evolution:',
      error
    );

    return res.status(500).json({
      success: false,
      error: error.message
    });

  }
});

module.exports = router;
