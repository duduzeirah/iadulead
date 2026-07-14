const express = require('express');
const axios = require('axios');
const db = require('../db');

const router = express.Router();

router.post('/', async (req, res) => {
  try {

    const {
      tenant_id,
      lead_id,
      phone,
      message
    } = req.body;

    // envia pela evolution
    await axios.post(
      `${process.env.EVOLUTION_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
      {
        number: phone,
        text: message
      },
      {
        headers: {
          apikey: process.env.EVOLUTION_API_KEY
        }
      }
    );

    // salva no histórico
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
      tenant_id,
      lead_id,
      message
    ]);

    // move para aguardando
    await db.query(`
      UPDATE leads
      SET
        status = 'aguardando',
        last_contact_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [lead_id]);

    return res.json({
      success: true
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });

  }
});

module.exports = router;
