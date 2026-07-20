const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { subscribe } = require('../services/realtimeService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(401).json({ error: 'Token não informado.' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    let tenantId = decoded.tenant_id || decoded.tenantId || decoded.user?.tenant_id || null;

    if (!tenantId) {
      const userId = decoded.id || decoded.user_id || decoded.userId || decoded.sub || decoded.user?.id;
      if (userId) {
        const result = await db.query('SELECT tenant_id FROM users WHERE id = $1 LIMIT 1', [userId]);
        tenantId = result.rows[0]?.tenant_id || null;
      }
    }

    if (!tenantId) return res.status(401).json({ error: 'Token sem empresa vinculada.' });
    subscribe(tenantId, res);
  } catch (error) {
    return res.status(401).json({
      error: error.name === 'TokenExpiredError' ? 'Sessão expirada.' : 'Token inválido.'
    });
  }
});

module.exports = router;
