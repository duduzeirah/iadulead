const express = require('express');
const axios = require('axios');
const db = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

router.post('/', async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { lead_id, message } = req.body;

    if (!lead_id || !message || !String(message).trim()) {
      return res.status(400).json({
        error: 'Lead e mensagem são obrigatórios'
      });
    }

    const leadResult = await db.query(
      `SELECT id, phone
       FROM leads
       WHERE id = $1
       AND tenant_id = $2
       LIMIT 1`,
      [lead_id, tenantId]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Lead não encontrado'
      });
    }

    const lead = leadResult.rows[0];
    const phone = String(lead.phone || '').replace(/\D/g, '');

    if (!phone) {
      return res.status(400).json({
        error: 'Lead sem telefone válido'
      });
    }

    const evolutionUrl = String(process.env.EVOLUTION_URL || '').replace(/\/$/, '');
    const evolutionInstance = process.env.EVOLUTION_INSTANCE;
    const evolutionApiKey = process.env.EVOLUTION_API_KEY;

    if (!evolutionUrl || !evolutionInstance || !evolutionApiKey) {
      return res.status(500).json({
        error: 'Variáveis da Evolution não configuradas'
      });
    }

    await axios.post(
      `${evolutionUrl}/message/sendText/${evolutionInstance}`,
      {
        number: phone,
        text: String(message).trim()
      },
      {
        headers: {
          apikey: evolutionApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    // O webhook da Evolution grava a mensagem no histórico.
    // Não inserimos aqui para evitar mensagem duplicada.
    await db.query(
      `UPDATE leads
       SET
         status = 'aguardando',
         last_contact_at = NOW(),
         updated_at = NOW()
       WHERE id = $1
       AND tenant_id = $2`,
      [lead_id, tenantId]
    );

    return res.json({
      success: true
    });
  } catch (error) {
    const evolutionError =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message;

    console.error('Erro ao enviar mensagem:', error.response?.data || error);

    return res.status(500).json({
      success: false,
      error: evolutionError || 'Erro ao enviar mensagem'
    });
  }
});

module.exports = router;
