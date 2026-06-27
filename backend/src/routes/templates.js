// src/routes/templates.js
const express = require('express');
const { query } = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();
router.use(auth);

// GET /templates
router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    const conditions = ['tenant_id=$1'];
    const params = [req.user.tenant_id];
    if (category) { conditions.push('category=$2'); params.push(category); }
    const { rows } = await query(
      `SELECT * FROM message_templates WHERE ${conditions.join(' AND ')} ORDER BY category, title`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar templates' });
  }
});

// POST /templates
router.post('/', async (req, res) => {
  try {
    const { title, category = 'followup', body } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Título e mensagem obrigatórios' });
    const { rows: [tpl] } = await query(
      `INSERT INTO message_templates (tenant_id, title, category, body)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.tenant_id, title, category, body]
    );
    res.status(201).json(tpl);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// PATCH /templates/:id
router.patch('/:id', async (req, res) => {
  try {
    const { title, body } = req.body;
    const { rows: [tpl] } = await query(
      `UPDATE message_templates SET title=COALESCE($1,title), body=COALESCE($2,body)
       WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [title || null, body || null, req.params.id, req.user.tenant_id]
    );
    if (!tpl) return res.status(404).json({ error: 'Template não encontrado' });
    res.json(tpl);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar template' });
  }
});

// POST /templates/:id/use  (increment usage count)
router.post('/:id/use', async (req, res) => {
  try {
    await query(
      'UPDATE message_templates SET usage_count=usage_count+1 WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenant_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// DELETE /templates/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows: [tpl] } = await query(
      'SELECT is_default FROM message_templates WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenant_id]
    );
    if (!tpl) return res.status(404).json({ error: 'Não encontrado' });
    if (tpl.is_default) return res.status(403).json({ error: 'Não é possível excluir templates padrão' });
    await query('DELETE FROM message_templates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir template' });
  }
});

module.exports = router;
