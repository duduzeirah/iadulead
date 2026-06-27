// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { query } = require('../db');

const auth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Load fresh user from DB
    const { rows } = await query(
      `SELECT u.id, u.tenant_id, u.name, u.email, u.role, u.is_active,
              t.plan, t.sub_status, t.trial_ends_at, t.sub_ends_at,
              t.is_active AS tenant_active, t.leads_limit, t.users_limit
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (!rows[0]) return res.status(401).json({ error: 'Usuário não encontrado' });
    const u = rows[0];
    if (!u.is_active) return res.status(401).json({ error: 'Conta desativada' });
    if (!u.tenant_active) return res.status(403).json({ error: 'Organização desativada' });

    // Check subscription
    const now = new Date();
    if (u.sub_status === 'trial' && new Date(u.trial_ends_at) < now) {
      return res.status(402).json({
        error: 'Período de trial encerrado',
        code: 'TRIAL_EXPIRED',
        trialEnded: true,
      });
    }
    if (['cancelled','expired'].includes(u.sub_status) && new Date(u.sub_ends_at) < now) {
      return res.status(402).json({
        error: 'Assinatura expirada',
        code: 'SUBSCRIPTION_EXPIRED',
      });
    }

    req.user = u;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// Only admins/owners
const requireAdmin = (req, res, next) => {
  if (!['admin','owner'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Sem permissão para esta ação' });
  }
  next();
};

module.exports = { auth, requireAdmin };
