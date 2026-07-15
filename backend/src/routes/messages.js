const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

router.get('/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const tenantId = req.user.tenant_id;

    const leadResult = await db.query(
      `SELECT id
       FROM leads
       WHERE id = $1
       AND tenant_id = $2
       LIMIT 1`,
      [leadId, tenantId]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Lead não encontrado'
      });
    }

    const result = await db.query(
      `SELECT
         id,
         direction,
         message,
         message_type,
         created_at
       FROM messages
       WHERE lead_id = $1
       AND tenant_id = $2
       ORDER BY created_at ASC`,
      [leadId, tenantId]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar mensagens:', error);

    return res.status(500).json({
      error: 'Erro ao buscar mensagens'
    });
  }
});

module.exports = router;
