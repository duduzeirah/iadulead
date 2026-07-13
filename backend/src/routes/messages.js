const express = require('express');
const db = require('../db');

const router = express.Router();

const DEFAULT_TENANT_ID =
  '31bc576d-0b27-4ea9-8a81-769429dde7ed';

/*
=====================================================
LISTAR MENSAGENS DE UM LEAD
=====================================================
*/

router.get('/:leadId', async (req, res) => {

  try {

    const { leadId } = req.params;

    const messages = await db.query(`
      SELECT
        id,
        direction,
        message,
        message_type,
        created_at
      FROM messages
      WHERE tenant_id = $1
      AND lead_id = $2
      ORDER BY created_at ASC
    `, [
      DEFAULT_TENANT_ID,
      leadId
    ]);

    return res.json(
      messages.rows
    );

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: error.message
    });

  }

});

module.exports = router;
