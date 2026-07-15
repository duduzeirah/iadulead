const express = require('express');
const axios = require('axios');
const db = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

/*
=====================================================
NORMALIZA A URL DA EVOLUTION
=====================================================
*/
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

/*
=====================================================
POST /api/sendmessage
ENVIA MENSAGEM PELO CRM
=====================================================
*/
router.post('/', async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { lead_id, message } = req.body;

    /*
    =====================================================
    VALIDA OS DADOS RECEBIDOS
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
    PROCURA O LEAD NO TENANT CORRETO
    =====================================================
    */
    const leadResult = await db.query(
      `
      SELECT
        id,
        phone,
        name
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
    PADRONIZA O TELEFONE
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
    VARIÁVEIS DA EVOLUTION
    =====================================================
    */
    const evolutionUrl = normalizeBaseUrl(
      process.env.EVOLUTION_URL
    );

    const evolutionInstance = String(
      process.env.EVOLUTION_INSTANCE || 'iadulead'
    ).trim();

    const evolutionApiKey = String(
      process.env.EVOLUTION_API_KEY || ''
    ).trim();

    if (!evolutionApiKey) {
      return res.status(500).json({
        success: false,
        error:
          'EVOLUTION_API_KEY não configurada no serviço iadulead'
      });
    }

    if (!evolutionInstance) {
      return res.status(500).json({
        success: false,
        error:
          'EVOLUTION_INSTANCE não configurada no serviço iadulead'
      });
    }

    /*
    =====================================================
    ENDPOINT DA EVOLUTION
    =====================================================
    */
    const endpoint =
      `${evolutionUrl}/message/sendText/` +
      encodeURIComponent(evolutionInstance);

    console.log(
      `📤 Enviando mensagem para ${phone} pela instância ${evolutionInstance}`
    );

    /*
    =====================================================
    ENVIA PARA A EVOLUTION

    Formato esperado:
    {
      number,
      textMessage: {
        text
      }
    }
    =====================================================
    */
    const evolutionResponse = await axios.post(
      endpoint,
      {
        number: phone,

        textMessage: {
          text: cleanMessage
        }
      },
      {
        headers: {
          apikey: evolutionApiKey,
          'Content-Type': 'application/json'
        },

        timeout: 20000,

        validateStatus: status =>
          status >= 200 && status < 300
      }
    );

    /*
    =====================================================
    ATUALIZA O LEAD PARA AGUARDANDO
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

    const evolutionData =
      error.response?.data;

    const evolutionError =
      evolutionData?.response?.message?.[0] ||
      evolutionData?.message ||
      evolutionData?.error ||
      error.message ||
      'Erro ao enviar mensagem';

    console.error(
      '❌ Erro ao enviar mensagem pela Evolution:',
      {
        status,
        data: evolutionData,
        message: error.message
      }
    );

    return res.status(
      status >= 400 && status < 600
        ? status
        : 500
    ).json({
      success: false,
      error:
        typeof evolutionError === 'string'
          ? evolutionError
          : JSON.stringify(evolutionError),

      details:
        evolutionData || null
    });
  }
});

module.exports = router;
