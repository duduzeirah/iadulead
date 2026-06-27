// src/routes/reminders.js
const express = require('express');
const { query } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// GET /reminders
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT r.*, l.name AS lead_name, l.phone AS lead_phone
       FROM reminders r
       LEFT JOIN leads l ON l.id = r.lead_id
       WHERE r.tenant_id=$1 AND r.is_done=false
       ORDER BY r.due_date ASC, r.due_time ASC`,
      [req.user.tenant_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar lembretes' });
  }
});

// POST /reminders
router.post('/', async (req, res) => {
  try {
    const { lead_id, title, type = 'followup', due_date, due_time } = req.body;
    if (!title || !due_date) return res.status(400).json({ error: 'Título e data são obrigatórios' });

    const { rows: [rem] } = await query(
      `INSERT INTO reminders (tenant_id, lead_id, user_id, title, type, due_date, due_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.tenant_id, lead_id || null, req.user.id, title, type, due_date, due_time || '09:00']
    );
    res.status(201).json(rem);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar lembrete' });
  }
});

// PATCH /reminders/:id/done
router.patch('/:id/done', async (req, res) => {
  try {
    const { rows: [rem] } = await query(
      `UPDATE reminders SET is_done=true, done_at=NOW()
       WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, req.user.tenant_id]
    );
    if (!rem) return res.status(404).json({ error: 'Lembrete não encontrado' });
    res.json(rem);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao concluir lembrete' });
  }
});

// DELETE /reminders/:id
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM reminders WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenant_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir lembrete' });
  }
});

module.exports = router;
