const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { publish } = require('../services/realtimeService');
const { getLeadContext, refreshLeadContext, ensureLeadContextSchema } = require('../services/leadContextService');

const router = express.Router();
router.use(auth);

router.get('/team', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, email, role, avatar_color
      FROM users
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY name ASC
    `, [req.user.tenant_id]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao carregar equipe' });
  }
});

router.get('/:leadId', async (req, res) => {
  try {
    const context = await getLeadContext({ tenantId: req.user.tenant_id, leadId: req.params.leadId });
    if (!context) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json(context);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao carregar contexto comercial' });
  }
});

router.post('/:leadId/refresh', async (req, res) => {
  try {
    const context = await refreshLeadContext({ tenantId: req.user.tenant_id, leadId: req.params.leadId, force: true });
    if (!context) return res.status(404).json({ error: 'Lead não encontrado' });
    publish(req.user.tenant_id, 'context.updated', { lead_id: req.params.leadId });
    res.json(context);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao atualizar contexto comercial' });
  }
});

router.patch('/:leadId/assignment', async (req, res) => {
  try {
    const assignedTo = req.body.assigned_to === 'me' ? req.user.id : (req.body.assigned_to || null);
    if (assignedTo) {
      const user = await db.query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND is_active = true`, [assignedTo, req.user.tenant_id]);
      if (!user.rows.length) return res.status(400).json({ error: 'Atendente inválido' });
    }
    const result = await db.query(`
      UPDATE leads SET assigned_to = $1, updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
      RETURNING id, assigned_to
    `, [assignedTo, req.params.leadId, req.user.tenant_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Lead não encontrado' });
    await db.query(`
      INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, description, metadata)
      VALUES ($1,$2,$3,'assignment',$4,$5::jsonb)
    `,[req.user.tenant_id, req.params.leadId, req.user.id, assignedTo ? 'Atendimento atribuído' : 'Atendimento ficou sem responsável', JSON.stringify({assigned_to:assignedTo})]);
    publish(req.user.tenant_id, 'context.updated', { lead_id: req.params.leadId });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao atribuir atendimento' });
  }
});

module.exports = router;
