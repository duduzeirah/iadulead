// src/routes/leads.js
const express = require('express');
const { query } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// ── GET /leads ──────────────────────────────────────────
// Query params:
// status, search, origin, tag, topic, priority,
// relationship, page, limit, sort
router.get('/', async (req, res) => {
  try {
    const tid = req.user.tenant_id;

    const {
      status,
      search,
      origin,
      tag,
      topic,
      priority,
      relationship,
      page = 1,
      limit = 100,
      sort = 'last_contact'
    } = req.query;

    const conditions = [
      'l.tenant_id = $1'
    ];

    const params = [
      tid
    ];

    let p = 2;

    if (status) {
      conditions.push(
        `l.status = $${p++}`
      );

      params.push(status);
    }

    if (origin) {
      conditions.push(
        `l.origin = $${p++}`
      );

      params.push(origin);
    }

    if (tag) {
      conditions.push(
        `l.tag = $${p++}`
      );

      params.push(tag);
    }

    if (topic) {
      conditions.push(
        `l.conversation_topic = $${p++}`
      );

      params.push(topic);
    }

    if (priority) {
      conditions.push(
        `l.commercial_priority = $${p++}`
      );

      params.push(priority);
    }

    if (relationship) {
      conditions.push(
        `l.customer_relationship = $${p++}`
      );

      params.push(relationship);
    }

    if (search) {
      conditions.push(`
        (
          l.name ILIKE $${p}
          OR l.phone ILIKE $${p}
          OR COALESCE(l.product, '') ILIKE $${p}
          OR COALESCE(l.conversation_topic, '') ILIKE $${p}
          OR COALESCE(l.customer_relationship, '') ILIKE $${p}
        )
      `);

      params.push(
        `%${search}%`
      );

      p++;
    }

    const where =
      `WHERE ${conditions.join(' AND ')}`;

    const orderMap = {
      last_contact:
        'l.last_contact_at DESC NULLS LAST, l.created_at DESC',

      last_contact_desc:
        'l.last_contact_at DESC NULLS LAST, l.created_at DESC',

      last_contact_asc:
        'l.last_contact_at ASC NULLS LAST, l.created_at ASC',

      created_at_desc:
        'l.created_at DESC',

      created_at_asc:
        'l.created_at ASC',

      name_asc:
        'l.name ASC NULLS LAST',

      name_desc:
        'l.name DESC NULLS LAST',

      value_desc:
        'l.estimated_value DESC NULLS LAST',

      value_asc:
        'l.estimated_value ASC NULLS LAST'
    };

    const order =
      orderMap[sort] ||
      orderMap.last_contact;

    const parsedPage = Math.max(
      1,
      Number.parseInt(page, 10) || 1
    );

    const parsedLimit = Math.min(
      500,
      Math.max(
        1,
        Number.parseInt(limit, 10) || 100
      )
    );

    const offset =
      (parsedPage - 1) *
      parsedLimit;

    const countRes = await query(
      `
      SELECT COUNT(*)
      FROM leads l
      ${where}
      `,
      params
    );

    const {
      rows
    } = await query(
      `
      SELECT
        l.id,
        l.name,
        l.phone,
        l.email,
        l.status,
        l.origin,
        l.product,
        l.estimated_value,
        l.tag,
        l.notes,
        l.last_contact_at,
        l.created_at,
        l.closed_at,
        l.bought_at,

        l.conversation_topic,
        l.commercial_priority,
        l.customer_relationship,
        l.classification_source,
        l.classification_confidence,

        u.name AS assigned_name

      FROM leads l

      LEFT JOIN users u
        ON u.id = l.assigned_to

      ${where}

      ORDER BY ${order}

      LIMIT $${p}
      OFFSET $${p + 1}
      `,
      [
        ...params,
        parsedLimit,
        offset
      ]
    );

    const total =
      Number.parseInt(
        countRes.rows[0].count,
        10
      ) || 0;

    return res.json({
      leads: rows,
      total,
      page: parsedPage,
      pages: Math.ceil(
        total / parsedLimit
      )
    });

  } catch (err) {
    console.error(
      'Erro ao buscar leads:',
      err
    );

    return res.status(500).json({
      error:
        'Erro ao buscar leads'
    });
  }
});

// ── GET /leads/stats ────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const tid =
      req.user.tenant_id;

    const {
      rows: byStatus
    } = await query(
      `
      SELECT
        status,
        COUNT(*) AS count,
        COALESCE(
          SUM(estimated_value),
          0
        ) AS total_value
      FROM leads
      WHERE tenant_id = $1
      GROUP BY status
      `,
      [
        tid
      ]
    );

    const {
      rows: byOrigin
    } = await query(
      `
      SELECT
        origin,
        COUNT(*) AS count
      FROM leads
      WHERE tenant_id = $1
      GROUP BY origin
      ORDER BY count DESC
      LIMIT 6
      `,
      [
        tid
      ]
    );

    const {
      rows: recent
    } = await query(
      `
      SELECT
        COUNT(*) AS count
      FROM leads
      WHERE tenant_id = $1
      AND created_at >
        NOW() - INTERVAL '7 days'
      `,
      [
        tid
      ]
    );

    const {
      rows: pipeline
    } = await query(
      `
      SELECT
        COALESCE(
          SUM(estimated_value),
          0
        ) AS total
      FROM leads
      WHERE tenant_id = $1
      AND status NOT IN (
        'inativo',
        'sumido'
      )
      `,
      [
        tid
      ]
    );

    return res.json({
      byStatus,
      byOrigin,
      recentWeek:
        recent[0].count,
      pipelineValue:
        pipeline[0].total
    });

  } catch (err) {
    console.error(
      'Erro ao calcular estatísticas:',
      err
    );

    return res.status(500).json({
      error:
        'Erro ao calcular estatísticas'
    });
  }
});

// ── POST /leads ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const tid =
      req.user.tenant_id;

    const {
      name,
      phone,
      email,
      status = 'novo',
      origin = 'WhatsApp',
      product,
      estimated_value,
      tag,
      notes,

      conversation_topic =
        'nao_identificado',

      commercial_priority =
        'comum',

      customer_relationship =
        'nao_identificado'

    } = req.body;

    if (!name || !phone) {
      return res.status(400).json({
        error:
          'Nome e telefone são obrigatórios'
      });
    }

    const {
      rows: [
        cnt
      ]
    } = await query(
      `
      SELECT COUNT(*)
      FROM leads
      WHERE tenant_id = $1
      `,
      [
        tid
      ]
    );

    if (
      Number.parseInt(
        cnt.count,
        10
      ) >= req.user.leads_limit
    ) {
      return res.status(403).json({
        error:
          'Limite de leads atingido para seu plano',

        code:
          'LEADS_LIMIT'
      });
    }

    const {
      rows: [
        lead
      ]
    } = await query(
      `
      INSERT INTO leads (
        tenant_id,
        assigned_to,
        name,
        phone,
        email,
        status,
        origin,
        product,
        estimated_value,
        tag,
        notes,
        last_contact_at,

        conversation_topic,
        commercial_priority,
        customer_relationship,
        classification_source
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        NOW(),

        $12,
        $13,
        $14,
        'manual'
      )
      RETURNING *
      `,
      [
        tid,
        req.user.id,
        name,
        phone,
        email || null,
        status,
        origin,
        product || null,
        estimated_value || 0,
        tag || null,
        notes || null,

        conversation_topic,
        commercial_priority,
        customer_relationship
      ]
    );

    await query(
      `
      INSERT INTO lead_activities (
        tenant_id,
        lead_id,
        user_id,
        type,
        description
      )
      VALUES (
        $1,
        $2,
        $3,
        'created',
        $4
      )
      `,
      [
        tid,
        lead.id,
        req.user.id,
        `Lead criado por ${req.user.name} via ${origin}`
      ]
    );

    return res
      .status(201)
      .json(lead);

  } catch (err) {
    console.error(
      'Erro ao criar lead:',
      err
    );

    return res.status(500).json({
      error:
        'Erro ao criar lead'
    });
  }
});

// ── GET /leads/:id ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const tid =
      req.user.tenant_id;

    const {
      rows
    } = await query(
      `
      SELECT
        l.*,
        u.name AS assigned_name
      FROM leads l
      LEFT JOIN users u
        ON u.id = l.assigned_to
      WHERE l.id = $1
      AND l.tenant_id = $2
      `,
      [
        req.params.id,
        tid
      ]
    );

    if (!rows[0]) {
      return res.status(404).json({
        error:
          'Lead não encontrado'
      });
    }

    const {
      rows: activities
    } = await query(
      `
      SELECT
        la.*,
        u.name AS user_name
      FROM lead_activities la
      LEFT JOIN users u
        ON u.id = la.user_id
      WHERE la.lead_id = $1
      AND la.tenant_id = $2
      ORDER BY
        la.created_at DESC
      LIMIT 20
      `,
      [
        req.params.id,
        tid
      ]
    );

    return res.json({
      ...rows[0],
      activities
    });

  } catch (err) {
    console.error(
      'Erro ao buscar lead:',
      err
    );

    return res.status(500).json({
      error:
        'Erro ao buscar lead'
    });
  }
});

// ── PATCH /leads/:id ────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const tid =
      req.user.tenant_id;

    const {
      id
    } = req.params;

    const {
      name,
      phone,
      email,
      status,
      origin,
      product,
      estimated_value,
      tag,
      notes,
      assigned_to,

      conversation_topic,
      commercial_priority,
      customer_relationship,
      classification_source,
      classification_confidence

    } = req.body;

    const {
      rows: [
        current
      ]
    } = await query(
      `
      SELECT *
      FROM leads
      WHERE id = $1
      AND tenant_id = $2
      `,
      [
        id,
        tid
      ]
    );

    if (!current) {
      return res.status(404).json({
        error:
          'Lead não encontrado'
      });
    }

    const updates = [];
    const vals = [];

    let p = 1;

    const set = (
      column,
      value
    ) => {
      updates.push(
        `${column} = $${p++}`
      );

      vals.push(value);
    };

    if (name !== undefined) {
      set(
        'name',
        name
      );
    }

    if (phone !== undefined) {
      set(
        'phone',
        phone
      );
    }

    if (email !== undefined) {
      set(
        'email',
        email
      );
    }

    if (origin !== undefined) {
      set(
        'origin',
        origin
      );
    }

    if (product !== undefined) {
      set(
        'product',
        product
      );
    }

    if (
      estimated_value !== undefined
    ) {
      set(
        'estimated_value',
        estimated_value
      );
    }

    if (tag !== undefined) {
      set(
        'tag',
        tag
      );
    }

    if (notes !== undefined) {
      set(
        'notes',
        notes
      );
    }

    if (assigned_to !== undefined) {
      set(
        'assigned_to',
        assigned_to
      );
    }

    if (
      conversation_topic !== undefined
    ) {
      set(
        'conversation_topic',
        conversation_topic
      );

      set(
        'classification_source',
        'manual'
      );

      set(
        'classification_confidence',
        null
      );
    }

    if (
      commercial_priority !== undefined
    ) {
      set(
        'commercial_priority',
        commercial_priority
      );

      set(
        'classification_source',
        'manual'
      );

      set(
        'classification_confidence',
        null
      );
    }

    if (
      customer_relationship !== undefined
    ) {
      set(
        'customer_relationship',
        customer_relationship
      );

      set(
        'classification_source',
        'manual'
      );

      set(
        'classification_confidence',
        null
      );
    }

    if (
      classification_source !== undefined
    ) {
      set(
        'classification_source',
        classification_source
      );
    }

    if (
      classification_confidence !== undefined
    ) {
      set(
        'classification_confidence',
        classification_confidence
      );
    }

    if (
      status !== undefined &&
      status !== current.status
    ) {
      set(
        'status',
        status
      );

      set(
        'last_contact_at',
        new Date()
      );

      if (
        status === 'fechado'
      ) {
        set(
          'closed_at',
          new Date()
        );
      }

      if (
        status === 'comprou'
      ) {
        set(
          'bought_at',
          new Date()
        );
      }

      await query(
        `
        INSERT INTO lead_activities (
          tenant_id,
          lead_id,
          user_id,
          type,
          description,
          metadata
        )
        VALUES (
          $1,
          $2,
          $3,
          'status_change',
          $4,
          $5
        )
        `,
        [
          tid,
          id,
          req.user.id,

          `Status alterado de "${current.status}" para "${status}"`,

          JSON.stringify({
            from:
              current.status,

            to:
              status
          })
        ]
      );
    }

    if (!updates.length) {
      return res.json(current);
    }

    vals.push(
      id,
      tid
    );

    const {
      rows: [
        updated
      ]
    } = await query(
      `
      UPDATE leads
      SET
        ${updates.join(', ')},
        updated_at = NOW()
      WHERE id = $${p}
      AND tenant_id = $${p + 1}
      RETURNING *
      `,
      vals
    );

    return res.json(updated);

  } catch (err) {
    console.error(
      'Erro ao atualizar lead:',
      err
    );

    return res.status(500).json({
      error:
        'Erro ao atualizar lead'
    });
  }
});

// ── DELETE /leads/:id ───────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const {
      rowCount
    } = await query(
      `
      DELETE FROM leads
      WHERE id = $1
      AND tenant_id = $2
      `,
      [
        req.params.id,
        req.user.tenant_id
      ]
    );

    if (!rowCount) {
      return res.status(404).json({
        error:
          'Lead não encontrado'
      });
    }

    return res.json({
      ok: true
    });

  } catch (err) {
    console.error(
      'Erro ao excluir lead:',
      err
    );

    return res.status(500).json({
      error:
        'Erro ao excluir lead'
    });
  }
});

// ── POST /leads/:id/note ────────────────────────────────
router.post('/:id/note', async (req, res) => {
  try {
    const tid =
      req.user.tenant_id;

    const {
      note
    } = req.body;

    if (
      !note ||
      !String(note).trim()
    ) {
      return res.status(400).json({
        error:
          'Nota não pode ser vazia'
      });
    }

    await query(
      `
      INSERT INTO lead_activities (
        tenant_id,
        lead_id,
        user_id,
        type,
        description
      )
      VALUES (
        $1,
        $2,
        $3,
        'note',
        $4
      )
      `,
      [
        tid,
        req.params.id,
        req.user.id,
        String(note).trim()
      ]
    );

    await query(
      `
      UPDATE leads
      SET
        last_contact_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      AND tenant_id = $2
      `,
      [
        req.params.id,
        tid
      ]
    );

    return res.json({
      ok: true
    });

  } catch (err) {
    console.error(
      'Erro ao salvar nota:',
      err
    );

    return res.status(500).json({
      error:
        'Erro ao salvar nota'
    });
  }
});

// ── GET /leads/:id/activities ───────────────────────────
router.get(
  '/:id/activities',
  async (req, res) => {
    try {
      const {
        rows
      } = await query(
        `
        SELECT
          la.*,
          u.name AS user_name
        FROM lead_activities la
        LEFT JOIN users u
          ON u.id = la.user_id
        WHERE la.lead_id = $1
        AND la.tenant_id = $2
        ORDER BY
          la.created_at DESC
        `,
        [
          req.params.id,
          req.user.tenant_id
        ]
      );

      return res.json(rows);

    } catch (err) {
      console.error(
        'Erro ao buscar atividades:',
        err
      );

      return res.status(500).json({
        error:
          'Erro ao buscar atividades'
      });
    }
  }
);

module.exports = router;
