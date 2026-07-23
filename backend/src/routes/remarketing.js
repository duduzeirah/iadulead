const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { ensureRemarketingSchema, createCampaign } = require('../services/remarketingService');

const router = express.Router();
router.use(auth);

router.get('/campaigns', async (req,res) => {
  try {
    await ensureRemarketingSchema();
    const result = await db.query(`
      SELECT * FROM remarketing_campaigns
      WHERE tenant_id=$1
      ORDER BY created_at DESC
      LIMIT 100
    `,[req.user.tenant_id]);
    res.json(result.rows);
  } catch(error){ res.status(500).json({error:error.message}); }
});

router.post('/campaigns', async (req,res) => {
  try {
    const campaign = await createCampaign({
      tenantId:req.user.tenant_id,
      userId:req.user.id,
      name:req.body.name,
      message:req.body.message,
      audience:req.body.audience
    });
    res.status(201).json(campaign);
  } catch(error){ res.status(400).json({error:error.message}); }
});

router.get('/settings', async (req,res) => {
  try {
    await ensureRemarketingSchema();
    const result = await db.query(`SELECT * FROM remarketing_settings WHERE tenant_id=$1`,[req.user.tenant_id]);
    res.json(result.rows[0] || {automatic_enabled:false,inactive_days:30,automatic_message:'Olá {nome}! Sentimos sua falta. Posso te ajudar com alguma coisa?'});
  } catch(error){ res.status(500).json({error:error.message}); }
});

router.put('/settings', async (req,res) => {
  try {
    await ensureRemarketingSchema();
    const result = await db.query(`
      INSERT INTO remarketing_settings (tenant_id,automatic_enabled,inactive_days,automatic_message,updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (tenant_id) DO UPDATE SET
        automatic_enabled=EXCLUDED.automatic_enabled,
        inactive_days=EXCLUDED.inactive_days,
        automatic_message=EXCLUDED.automatic_message,
        updated_at=NOW()
      RETURNING *
    `,[req.user.tenant_id,Boolean(req.body.automatic_enabled),Number(req.body.inactive_days)||30,String(req.body.automatic_message||'').trim() || 'Olá {nome}! Sentimos sua falta. Posso te ajudar com alguma coisa?']);
    res.json(result.rows[0]);
  } catch(error){ res.status(500).json({error:error.message}); }
});

module.exports = router;
