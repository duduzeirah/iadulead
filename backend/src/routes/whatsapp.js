const express = require('express');
const db = require('../db');

const router = express.Router();

const DEFAULT_TENANT_ID = '31bc576d-0b27-4ea9-8a81-769429dde7ed';

router.post('/webhook', async (req, res) => {
  try {

    const event = req.body.event;
    const data = req.body.data;
// mensagem enviada pela equipe
if (
  event === 'send.message' &&
  data?.key?.fromMe === true
) {

  let phone = data.key.remoteJid
    ?.replace('@s.whatsapp.net', '')
    ?.replace('@lid', '')
    ?.replace(/\D/g, '');

  if (!phone.startsWith('55')) {
    phone = `55${phone}`;
  }

  await db.query(`
    UPDATE leads
    SET
      status = 'atendendo',
      updated_at = NOW()
    WHERE tenant_id = $1
    AND phone = $2
    AND status = 'novo'
  `, [
    DEFAULT_TENANT_ID,
    phone
  ]);

  console.log(`👨‍💼 Lead movido para atendendo: ${phone}`);

  return res.status(200).json({
    success: true
  });
}
    // aceita apenas eventos de mensagem
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

    // padroniza todos os números com 55
    if (!phone.startsWith('55')) {
      phone = `55${phone}`;
    }

    const name =
      data.pushName ||
      phone;

    const message =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text ||
      '';

    /*
      =====================================================
      MENSAGEM ENVIADA PELA BARBEARIA
      move automaticamente para ATENDIMENTO
      =====================================================
    */
    if (data.key?.fromMe === true) {

      await db.query(`
        UPDATE leads
        SET
          status = 'atendimento',
          last_contact_at = NOW(),
          updated_at = NOW()
        WHERE tenant_id = $1
        AND phone = $2
        AND status = 'novo'
      `, [
        DEFAULT_TENANT_ID,
        phone
      ]);

      console.log(`🟢 Lead movido para atendimento: ${phone}`);

      return res.status(200).json({
        moved: true
      });
    }

    /*
      =====================================================
      PROCURA LEAD EXISTENTE
      =====================================================
    */
    const existingLead = await db.query(`
      SELECT id
      FROM leads
      WHERE tenant_id = $1
      AND phone = $2
      LIMIT 1
    `, [
      DEFAULT_TENANT_ID,
      phone
    ]);

    /*
      =====================================================
      NOVO LEAD
      =====================================================
    */
    if (existingLead.rows.length === 0) {

      await db.query(`
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
      `, [
        DEFAULT_TENANT_ID,
        name,
        phone,
        message
      ]);

      console.log(`✅ Novo lead criado automaticamente: ${name} | ${phone}`);

    } else {

      /*
        ==========================================
        LEAD JÁ EXISTE
        ==========================================
      */
      await db.query(`
        UPDATE leads
        SET
          last_contact_at = NOW(),
          updated_at = NOW()
        WHERE tenant_id = $1
        AND phone = $2
      `, [
        DEFAULT_TENANT_ID,
        phone
      ]);

      console.log(`🔄 Lead atualizado automaticamente: ${phone}`);
    }

    return res.status(200).json({
      success: true
    });

  } catch (error) {

    console.error('Erro webhook Evolution:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });

  }
});

module.exports = router;
