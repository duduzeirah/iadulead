const express = require('express');
const axios = require('axios');
const db = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

/*
=====================================================
CONFIGURAÇÃO DA EVOLUTION
=====================================================
*/

const EVOLUTION_URL =
  'https://evolution-api-production-0819.up.railway.app';

const EVOLUTION_INSTANCE =
  process.env.EVOLUTION_INSTANCE || 'iadulead';

const EVOLUTION_API_KEY =
  process.env.EVOLUTION_API_KEY;

/*
=====================================================
POST /api/sendmessage
=====================================================
*/

router.post('/', async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { lead_id, message } = req.body;

    /*
    =====================================================
    VALIDAÇÃO
    =====================================================
    */

    if (!lead_id) {
      return res.status(400).json({
        success: false,
        error: 'Lead não informado'
      });
    }

    const cleanMessage = String(message || '').trim();

    if (!cleanMessage) {
      return res.status(400).json({
        success: false,
        error: 'Mensagem não pode ser vazia'
      });
    }

    /*
    =====================================================
    BUSCA O LEAD
    =====================================================
    */

    const leadResult = await db.query(
      `
      SELECT
        id,
        name,
        phone
      FROM leads
      WHERE id = $1
      AND tenant_id = $2
      LIMIT 1
      `,
      [
        lead_id,
        tenantId
      ]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Lead não encontrado'
      });
    }

    const lead = leadResult.rows[0];

    /*
    =====================================================
    NORMALIZA O TELEFONE
    =====================================================
    */

    let phone = String(lead.phone || '')
      .replace(/\D/g, '');

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Lead sem telefone válido'
      });
    }

    if (!phone.startsWith('55')) {
      phone = `55${phone}`;
    }

    /*
    =====================================================
    CONFERE A CHAVE
    =====================================================
    */

    if (!EVOLUTION_API_KEY) {
      return res.status(500).json({
        success: false,
        error:
          'EVOLUTION_API_KEY não configurada no serviço iadulead'
      });
    }

    /*
    =====================================================
    MONTA O ENDPOINT
    =====================================================
    */

    const endpoint =
      `${EVOLUTION_URL}/message/sendText/` +
      encodeURIComponent(EVOLUTION_INSTANCE);

    console.log('📤 Endpoint Evolution:', endpoint);
    console.log('📱 Telefone:', phone);
    console.log('🔌 Instância:', EVOLUTION_INSTANCE);

    /*
    =====================================================
    ENVIA A MENSAGEM
    =====================================================
    */

    const evolutionResponse = await axios({
      method: 'post',
      url: endpoint,

      headers: {
        apikey: EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      },

      data: {
        number: phone,
        text: cleanMessage
      },

      timeout: 20000
    });

    /*
    =====================================================
    ATUALIZA O LEAD
    =====================================================
    */

    await db.query(
      `
      UPDATE leads
      SET
        status = 'aguardando',
        last_contact_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      AND tenant_id = $2
      `,
      [
        lead_id,
        tenantId
      ]
    );

    console.log(
      `✅ Mensagem enviada para ${lead.name || phone}`
    );

    return res.status(200).json({
      success: true,
      lead_id,
      phone,
      evolution: evolutionResponse.data
    });

  } catch (error) {
    const status =
      error.response?.status || 500;

    const details =
      error.response?.data || null;

    const errorMessage =
      details?.response?.message?.[0] ||
      details?.message ||
      details?.error ||
      error.message ||
      'Erro ao enviar mensagem';

    console.error(
      '❌ Erro no envio:',
      {
        message: error.message,
        status,
        details
      }
    );

    return res.status(
      status >= 400 && status < 600
        ? status
        : 500
    ).json({
      success: false,

      error:
        typeof errorMessage === 'string'
          ? errorMessage
          : JSON.stringify(errorMessage),

      details
    });
  }
});

module.exports = router;
