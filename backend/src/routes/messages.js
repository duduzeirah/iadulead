const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { ensureContactIdentitySchema, bindIdentifiers, normalizePhone, repairMessagesForLead } = require('../services/contactIdentityService');

const router = express.Router();
router.use(auth);

router.get('/:leadId', async (req, res) => {
  try {
    await ensureContactIdentitySchema();
    const { leadId } = req.params;
    const tenantId = req.user.tenant_id;

    const leadResult = await db.query(`
      SELECT id, phone FROM leads
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1
    `, [leadId, tenantId]);

    const lead = leadResult.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const phone = normalizePhone(lead.phone);
    if (phone) {
      await bindIdentifiers({
        tenantId,
        leadId,
        identifiers: [
          { type: 'phone', value: phone },
          { type: 'jid', value: `${phone}@s.whatsapp.net` }
        ]
      });
    }

    await repairMessagesForLead({ tenantId, leadId });

    const result = await db.query(`
      SELECT
        id, direction, message, message_type, created_at,
        external_message_id, media_type, media_mime_type,
        media_file_name, media_duration_seconds,
        sent_by_user_id, sent_by_name
      FROM messages
      WHERE lead_id = $1 AND tenant_id = $2
      ORDER BY created_at ASC
    `, [leadId, tenantId]);

    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar mensagens:', error);
    return res.status(500).json({ error: error.message || 'Erro ao buscar mensagens' });
  }
});

module.exports = router;
