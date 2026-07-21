const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { publish } = require('../services/realtimeService');
const { ensureTeamSchema, isAdmin } = require('../services/teamService');

const router = express.Router();
router.use(auth);

function clean(value, max = 255) {
  return String(value || '').trim().slice(0, max);
}

function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Somente administradores podem gerenciar a equipe.' });
  }
  next();
}

router.get('/', async (req, res) => {
  try {
    await ensureTeamSchema();
    const result = await db.query(`
      SELECT id, name, email, role, avatar_color, job_title,
             signature_enabled, signature_mode, signature_text,
             is_active, last_login_at, created_at
      FROM users
      WHERE tenant_id = $1
      ORDER BY is_active DESC, name ASC
    `, [req.user.tenant_id]);
    res.json({ members: result.rows, current_user_id: req.user.id, can_manage: isAdmin(req.user) });
  } catch (error) {
    console.error('Erro ao listar equipe:', error);
    res.status(500).json({ error: error.message || 'Erro ao carregar equipe.' });
  }
});

router.post('/', adminOnly, async (req, res) => {
  try {
    await ensureTeamSchema();
    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 255).toLowerCase();
    const password = String(req.body.password || '');
    const role = ['admin', 'attendant'].includes(req.body.role) ? req.body.role : 'attendant';
    const jobTitle = clean(req.body.job_title, 120) || 'Atendente';

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const exists = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(`
      INSERT INTO users (
        tenant_id, name, email, password_hash, role, job_title,
        signature_enabled, signature_mode, signature_text, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,true,'first_message',$7,true)
      RETURNING id, name, email, role, job_title, signature_enabled,
                signature_mode, signature_text, is_active, created_at
    `, [
      req.user.tenant_id, name, email, hash, role, jobTitle,
      `Olá, aqui é o ${name}.`
    ]);

    publish(req.user.tenant_id, 'team.updated', { action: 'created', user_id: result.rows[0].id });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar usuário da equipe:', error);
    res.status(500).json({ error: error.message || 'Erro ao criar usuário.' });
  }
});

router.patch('/:userId', adminOnly, async (req, res) => {
  try {
    await ensureTeamSchema();
    const target = await db.query(
      'SELECT id, role FROM users WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [req.params.userId, req.user.tenant_id]
    );
    if (!target.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const fields = [];
    const values = [];
    let p = 1;
    const allowed = {
      name: v => clean(v, 120),
      role: v => ['admin','attendant'].includes(v) ? v : 'attendant',
      job_title: v => clean(v, 120),
      signature_enabled: v => Boolean(v),
      signature_mode: v => ['first_message','always','off'].includes(v) ? v : 'first_message',
      signature_text: v => clean(v, 255),
      is_active: v => Boolean(v)
    };

    for (const [key, parser] of Object.entries(allowed)) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${p++}`);
        values.push(parser(req.body[key]));
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nenhuma alteração informada.' });

    if (req.params.userId === req.user.id && req.body.is_active === false) {
      return res.status(400).json({ error: 'Você não pode desativar seu próprio acesso.' });
    }

    values.push(req.params.userId, req.user.tenant_id);
    const result = await db.query(`
      UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${p++} AND tenant_id = $${p}
      RETURNING id, name, email, role, job_title, signature_enabled,
                signature_mode, signature_text, is_active, updated_at
    `, values);

    publish(req.user.tenant_id, 'team.updated', { action: 'updated', user_id: req.params.userId });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    res.status(500).json({ error: error.message || 'Erro ao atualizar usuário.' });
  }
});

router.post('/:userId/reset-password', adminOnly, async (req, res) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(`
      UPDATE users SET password_hash = $1, updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
      RETURNING id
    `, [hash, req.params.userId, req.user.tenant_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao redefinir senha.' });
  }
});

module.exports = router;
