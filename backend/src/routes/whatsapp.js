const express = require('express');
const db = require('../db');

const router = express.Router();

router.post('/webhook', async (req, res) => {
  try {
    const event = req.body.event;
    const data = req.body.data;

    // Apenas mensagens recebidas
    if (
      event !== 'messages.upsert' ||
      !data ||
      data.key?.fromMe === true
    ) {
      return res.status(200).json({ ignored: true });
    }

    const phone = data.key.remoteJid
      ?.replace('@s.whatsapp.net', '')
      ?.replace('@lid', '');

    const name =
      data.pushName ||
      phone;

    // verifica se já existe
    const existingLead = await db.query(
      'SELECT id FROM leads WHERE phone = $1 LIMIT 1',
      [phone]
    );

    if (existingLead.rows.length === 0) {

      await db.query(`
        INSERT INTO leads (
          tenant_id,
          name,
          phone,
          status,
          origin,
          created_at,
          updated_at
        )
        VALUES (
          (
            SELECT id
            FROM tenants
            LIMIT 1
          ),
          $1,
          $2,
          'novo',
          'WhatsApp',
          NOW(),
          NOW()
        )
      `, [
        name,
        phone
      ]);

      console.log(`✅ Novo lead criado: ${name}`);
    } else {

      await db.query(`
        UPDATE leads
        SET
          last_contact_at = NOW(),
          updated_at = NOW()
        WHERE phone = $1
      `, [phone]);

      console.log(`🔄 Lead atualizado: ${phone}`);
    }

    return res.status(200).json({
      success: true
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: error.message
    });
  }
});

module.exports = router;
