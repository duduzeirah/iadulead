// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { query } = require('../db');
const { auth } = require('../middleware/auth');
const { seedTemplatesForTenant } = require('../db/seed-templates');

const router = express.Router();

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7');

function makeToken(userId, tenantId) {
  return jwt.sign(
    { userId, tenantId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ── POST /auth/register ─────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, empresa, segmento, phone } = req.body;

    if (!name || !email || !password || !empresa) {
      return res.status(400).json({ error: 'Campos obrigatórios: name, email, password, empresa' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Senha deve ter ao menos 8 caracteres' });
    }
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email)) {
      return res.status(400).json({ error: 'E-mail inválido' });
    }

    // Check email unique
    const exists = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado' });
    }

    const hash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86400 * 1000);
    const slug = empresa.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50) + '-' + uuid().slice(0,6);

    // Create tenant
    const { rows: [tenant] } = await query(
      `INSERT INTO tenants (name, slug, segment, phone, plan, sub_status, trial_ends_at)
       VALUES ($1, $2, $3, $4, 'trial', 'trial', $5)
       RETURNING id`,
      [empresa, slug, segmento || null, phone || null, trialEndsAt]
    );

    // Create owner user
    const { rows: [user] } = await query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'owner')
       RETURNING id, name, email, role`,
      [tenant.id, name, email.toLowerCase(), hash]
    );

    // Seed default templates
    await seedTemplatesForTenant(tenant.id);

    const token = makeToken(user.id, tenant.id);

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: { id: tenant.id, name: empresa, slug, plan: 'trial', trialEndsAt },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Erro interno ao criar conta' });
  }
});

// ── POST /auth/login ────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
    }

    const { rows } = await query(
      `SELECT u.id, u.tenant_id, u.name, u.email, u.password_hash, u.role, u.is_active,
              t.name AS empresa, t.plan, t.sub_status, t.trial_ends_at, t.sub_ends_at,
              t.is_active AS tenant_active, t.leads_limit
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );

    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    if (!user.is_active) return res.status(401).json({ error: 'Conta desativada' });
    if (!user.tenant_active) return res.status(403).json({ error: 'Organização desativada' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'E-mail ou senha incorretos' });

    // Update last login
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const now = new Date();
    let subscriptionWarning = null;
    if (user.sub_status === 'trial') {
      const daysLeft = Math.max(0, Math.ceil((new Date(user.trial_ends_at) - now) / 86400000));
      if (daysLeft <= 2) subscriptionWarning = { type: 'trial_ending', daysLeft };
    }

    const token = makeToken(user.id, user.tenant_id);

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: {
        id: user.tenant_id, name: user.empresa, plan: user.plan,
        subStatus: user.sub_status, trialEndsAt: user.trial_ends_at,
        subEndsAt: user.sub_ends_at, leadsLimit: user.leads_limit,
      },
      subscriptionWarning,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── GET /auth/me ────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role, u.avatar_color, u.last_login_at,
              t.id AS tenant_id, t.name AS empresa, t.segment, t.phone AS wpp,
              t.plan, t.sub_status, t.trial_ends_at, t.sub_ends_at, t.leads_limit, t.settings
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── PATCH /auth/profile ─────────────────────────────────
router.patch('/profile', auth, async (req, res) => {
  try {
    const { name, empresa, phone } = req.body;
    if (name) await query('UPDATE users SET name=$1 WHERE id=$2', [name, req.user.id]);
    if (empresa || phone) {
      await query(
        'UPDATE tenants SET name=COALESCE($1,name), phone=COALESCE($2,phone) WHERE id=$3',
        [empresa || null, phone || null, req.user.tenant_id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

// ── POST /auth/change-password ──────────────────────────
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Campos obrigatórios' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Senha muito curta' });

    const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });

    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao alterar senha' });
  }
});

module.exports = router;
