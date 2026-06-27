// src/routes/dashboard.js
const express = require('express');
const { query } = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();
router.use(auth);

// GET /dashboard/summary
router.get('/summary', async (req, res) => {
  try {
    const tid = req.user.tenant_id;

    // Counts by status
    const { rows: counts } = await query(
      `SELECT status, COUNT(*) AS count FROM leads WHERE tenant_id=$1 GROUP BY status`, [tid]
    );

    // Recent activities (last 10)
    const { rows: activities } = await query(
      `SELECT la.type, la.description, la.created_at, u.name AS user_name, l.name AS lead_name
       FROM lead_activities la
       LEFT JOIN users u ON u.id=la.user_id
       LEFT JOIN leads l ON l.id=la.lead_id
       WHERE la.tenant_id=$1
       ORDER BY la.created_at DESC LIMIT 10`, [tid]
    );

    // Due reminders today
    const { rows: dueReminders } = await query(
      `SELECT r.*, l.name AS lead_name FROM reminders r
       LEFT JOIN leads l ON l.id=r.lead_id
       WHERE r.tenant_id=$1 AND r.is_done=false AND r.due_date <= CURRENT_DATE
       ORDER BY r.due_date, r.due_time LIMIT 5`, [tid]
    );

    // Trial info
    const { rows: [tenant] } = await query(
      'SELECT plan, sub_status, trial_ends_at, leads_limit FROM tenants WHERE id=$1', [tid]
    );
    const now = new Date();
    let trialDaysLeft = null;
    if (tenant.sub_status === 'trial') {
      trialDaysLeft = Math.max(0, Math.ceil((new Date(tenant.trial_ends_at) - now) / 86400000));
    }

    // Total leads
    const { rows: [total] } = await query('SELECT COUNT(*) FROM leads WHERE tenant_id=$1', [tid]);

    res.json({
      counts: Object.fromEntries(counts.map(r => [r.status, parseInt(r.count)])),
      totalLeads: parseInt(total.count),
      activities,
      dueReminders,
      plan: tenant.plan,
      subStatus: tenant.sub_status,
      trialDaysLeft,
      leadsLimit: tenant.leads_limit,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar dashboard' });
  }
});

module.exports = router;
