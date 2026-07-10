const express = require('express');
const db = require('../db');

const router = express.Router();

/*
  COLOQUE AQUI O TENANT DA BARBEARIA
  Exemplo:
  const DEFAULT_TENANT_ID = '2c4e58b4-f70a-4f0e-b0a1-6f12d43a9e77';
*/
const DEFAULT_TENANT_ID = '31bc576d-0b27-4ea9-8a81-769429dde7ed';

router.post('/webhook', async (req, res) => {
  try {

    const event = req.body.event;
    const data = req.body.data;

    // aceita somente mensagens recebidas
    if (
      event !== 'messages.upsert' ||
      !data ||
      data.key?.fromMe === true
    ) {
      return res.status(200).json({
        ignored: true
      });
    }

    const phone = data.key?.remoteJid
      ?.replace('@s.whatsapp.net', '')
      ?.replace('@lid', '');

    if (!phone) {
      return res.status(200).json({
        ignored: true
      });
    }

    const name =
      data.pushName ||
      phone;

    const message =
      data.message?.conversation ||
      '';

    // procura lead existente dentro do tenant correto
    const existingLead = await db.query(
      `
      SELECT id
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

    // cria novo lead
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

      // atualiza último contato
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
