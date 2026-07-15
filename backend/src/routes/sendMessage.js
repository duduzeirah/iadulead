const express = require('express');
const axios = require('axios');
const db = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

function normalizeBaseUrl(value) {
  let url = String(value || '').trim();

  if (!url) {
    url = 'https://evolution-api-production-0819.up.railway.app';
  }

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  return url.replace(/\/+$/, '');
}

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

    const evolutionUrl = normalizeBaseUrl(process.env.EVOLUTION_URL);
    const evolutionInstance = String(
      process.env.EVOLUTION_INSTANCE || 'iadulead'
    ).trim();
    const evolutionApiKey = String(
      process.env.EVOLUTION_API_KEY || ''
    ).trim();

    if (!evolutionApiKey) {
      return res.status(500).json({
        error: 'EVOLUTION_API_KEY não configurada no serviço iadulead'
      });
    }

    const endpoint =
      `${evolutionUrl}/message/sendText/${encodeURIComponent(evolutionInstance)}`;

    await axios.post(
      endpoint,
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
      error.response?.data ||
      error.message;

    console.error(
      'Erro ao enviar mensagem:',
      error.response?.data || error
    );

    return res.status(500).json({
      success: false,
      error:
        typeof evolutionError === 'string'
          ? evolutionError
          : JSON.stringify(evolutionError)
    });
  }
});

module.exports = router;
