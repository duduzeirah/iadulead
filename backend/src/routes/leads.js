// src/routes/leads.js
const express = require('express');
const { query } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// ── GET /leads ──────────────────────────────────────────
// Query params: status, search, origin, tag, page, limit, sort
router.get('/', async (req, res) => {
  try {
    const tid = req.user.tenant_id;
    const { status, search, origin, tag, page = 1, limit = 100, sort = 'last_contact' } = req.query;
    const conditions = ['l.tenant_id = $1'];
    const params = [tid];
    let p = 2;

    if (status) { conditions.push(`l.status = $${p++}`); params.push(status); }
    if (origin) { conditions.push(`l.origin = $${p++}`); params.push(origin); }
    if (tag)    { conditions.push(`l.tag = $${p++}`); params.push(tag); }
    if (search) {
      conditions.push(`(l.name ILIKE $${p} OR l.phone ILIKE $${p} OR l.product ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }

    const where = 'WHERE ' + conditions.join(' AND ');
   const orderMap = {
  created_at_desc: 'l.created_at DESC',
  created_at_asc: 'l.created_at ASC',
  name_asc: 'l.name ASC',
  value_desc: 'l.estimated_value DESC',

  // padrão operacional do WhatsApp
  last_contact: `
    l.last_contact_at DESC NULLS LAST
  `,
};

const order =
  orderMap[sort] ||
  orderMap.last_contact;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countRes = await query(
      `SELECT COUNT(*) FROM leads l ${where}`, params
    );

    const { rows } = await query(
      `SELECT l.id, l.name, l.phone, l.email, l.status, l.origin, l.product,
              l.estimated_value, l.tag, l.notes, l.last_contact_at, l.created_at,
              l.closed_at, l.bought_at,
              u.name AS assigned_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       ${where}
       ORDER BY ${order}
       LIMIT $${p} OFFSET $${p+1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      leads: rows,
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countRes.rows[0].count / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar leads' });
  }
});

// ── GET /leads/stats ────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const tid = req.user.tenant_id;

    const { rows: byStatus } = await query(
      `SELECT status, COUNT(*) AS count,
              COALESCE(SUM(estimated_value),0) AS total_value
       FROM leads WHERE tenant_id=$1
       GROUP BY status`,
      [tid]
    );

    const { rows: byOrigin } = await query(
      `SELECT origin, COUNT(*) AS count
       FROM leads WHERE tenant_id=$1
       GROUP BY origin ORDER BY count DESC LIMIT 6`,
      [tid]
    );

    const { rows: recent } = await query(
      `SELECT COUNT(*) AS count FROM leads
       WHERE tenant_id=$1 AND created_at > NOW() - INTERVAL '7 days'`,
      [tid]
    );

    const { rows: pipeline } = await query(
      `SELECT COALESCE(SUM(estimated_value),0) AS total
       FROM leads WHERE tenant_id=$1 AND status NOT IN ('inativo','sumido')`,
      [tid]
    );

    res.json({ byStatus, byOrigin, recentWeek: recent[0].count, pipelineValue: pipeline[0].total });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao calcular estatísticas' });
  }
});

// ── POST /leads ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const tid = req.user.tenant_id;
    const { name, phone, email, status = 'novo', origin = 'WhatsApp',
            product, estimated_value, tag, notes } = req.body;

    if (!name || !phone) return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });

    // Check leads limit
    const { rows: [cnt] } = await query('SELECT COUNT(*) FROM leads WHERE tenant_id=$1', [tid]);
    if (parseInt(cnt.count) >= req.user.leads_limit) {
      return res.status(403).json({ error: 'Limite de leads atingido para seu plano', code: 'LEADS_LIMIT' });
    }

    const { rows: [lead] } = await query(
      `INSERT INTO leads (tenant_id, assigned_to, name, phone, email, status, origin, product, estimated_value, tag, notes, last_contact_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       RETURNING *`,
      [tid, req.user.id, name, phone, email || null, status, origin,
       product || null, estimated_value || 0, tag || null, notes || null]
    );

    // Log activity
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, description)
       VALUES ($1, $2, $3, 'created', $4)`,
      [tid, lead.id, req.user.id, `Lead criado por ${req.user.name} via ${origin}`]
    );

    res.status(201).json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar lead' });
  }
});

// ── GET /leads/:id ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT l.*, u.name AS assigned_name
       FROM leads l LEFT JOIN users u ON u.id=l.assigned_to
       WHERE l.id=$1 AND l.tenant_id=$2`,
      [req.params.id, req.user.tenant_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Lead não encontrado' });

    const { rows: activities } = await query(
      `SELECT la.*, u.name AS user_name
       FROM lead_activities la
       LEFT JOIN users u ON u.id = la.user_id
       WHERE la.lead_id=$1 ORDER BY la.created_at DESC LIMIT 20`,
      [req.params.id]
    );

    res.json({ ...rows[0], activities });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar lead' });
  }
});

// ── PATCH /leads/:id ────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const tid = req.user.tenant_id;
    const { id } = req.params;
    const { name, phone, email, status, origin, product, estimated_value, tag, notes, assigned_to } = req.body;

    // Fetch current
    const { rows: [current] } = await query(
      'SELECT * FROM leads WHERE id=$1 AND tenant_id=$2', [id, tid]
    );
    if (!current) return res.status(404).json({ error: 'Lead não encontrado' });

    // Build update
    const updates = [];
    const vals = [];
    let p = 1;
    const set = (col, val) => { updates.push(`${col}=$${p++}`); vals.push(val); };

    if (name !== undefined) set('name', name);
    if (phone !== undefined) set('phone', phone);
    if (email !== undefined) set('email', email);
    if (origin !== undefined) set('origin', origin);
    if (product !== undefined) set('product', product);
    if (estimated_value !== undefined) set('estimated_value', estimated_value);
    if (tag !== undefined) set('tag', tag);
    if (notes !== undefined) set('notes', notes);
    if (assigned_to !== undefined) set('assigned_to', assigned_to);

    // Status change → log + timestamps
    if (status !== undefined && status !== current.status) {
      set('status', status);
      set('last_contact_at', new Date());
      if (status === 'fechado') set('closed_at', new Date());
      if (status === 'comprou') set('bought_at', new Date());

      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, description, metadata)
         VALUES ($1,$2,$3,'status_change',$4,$5)`,
        [tid, id, req.user.id,
         `Status alterado de "${current.status}" para "${status}"`,
         JSON.stringify({ from: current.status, to: status })]
      );
    }

    if (!updates.length) return res.json(current);

    vals.push(id, tid);
    const { rows: [updated] } = await query(
      `UPDATE leads SET ${updates.join(',')} WHERE id=$${p} AND tenant_id=$${p+1} RETURNING *`,
      vals
    );
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar lead' });
  }
});

// ── DELETE /leads/:id ───────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM leads WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenant_id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir lead' });
  }
});

// ── POST /leads/:id/note ────────────────────────────────
router.post('/:id/note', async (req, res) => {
  try {
    const tid = req.user.tenant_id;
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: 'Nota não pode ser vazia' });

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, description)
       VALUES ($1,$2,$3,'note',$4)`,
      [tid, req.params.id, req.user.id, note]
    );
    // Update last_contact
    await query('UPDATE leads SET last_contact_at=NOW() WHERE id=$1 AND tenant_id=$2',
      [req.params.id, tid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar nota' });
  }
});

// ── GET /leads/:id/activities ───────────────────────────
router.get('/:id/activities', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT la.*, u.name AS user_name
       FROM lead_activities la
       LEFT JOIN users u ON u.id=la.user_id
       WHERE la.lead_id=$1 AND la.tenant_id=$2
       ORDER BY la.created_at DESC`,
      [req.params.id, req.user.tenant_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar atividades' });
  }
});

module.exports = router;
