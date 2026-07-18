const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

/*
==========================================
RESUMO DA INTELIGÊNCIA
==========================================
*/

router.get('/summary', async (req, res) => {

  try{

    const tenantId=req.user.tenant_id;

    const totalLeads=await db.query(`
      SELECT COUNT(*)::int total
      FROM leads
      WHERE tenant_id=$1
    `,[tenantId]);

    const totalLogs=await db.query(`
      SELECT COUNT(*)::int total
      FROM automation_logs
      WHERE tenant_id=$1
    `,[tenantId]);

    const successLogs=await db.query(`
      SELECT COUNT(*)::int total
      FROM automation_logs
      WHERE tenant_id=$1
      AND success=true
    `,[tenantId]);

    const waiting=await db.query(`
      SELECT COUNT(*)::int total
      FROM leads
      WHERE tenant_id=$1
      AND status='aguardando'
    `,[tenantId]);

    const hot=await db.query(`
      SELECT COUNT(*)::int total
      FROM leads
      WHERE tenant_id=$1
      AND commercial_priority='quente'
    `,[tenantId]);

    res.json({

      total_leads:
        totalLeads.rows[0].total,

      automation_executions:
        totalLogs.rows[0].total,

      automation_success:
        successLogs.rows[0].total,

      waiting:
        waiting.rows[0].total,

      hot:
        hot.rows[0].total

    });

  }catch(error){

    console.error(error);

    res.status(500).json({
      error:'Erro ao carregar inteligência'
    });

  }

});

/*
==========================================
ÚLTIMAS EXECUÇÕES
==========================================
*/

router.get('/history',async(req,res)=>{

  try{

    const tenantId=req.user.tenant_id;

    const result=await db.query(`

      SELECT

      automation_logs.*,

      leads.name,

      leads.phone,

      automation_rules.name rule_name

      FROM automation_logs

      LEFT JOIN leads

      ON leads.id=automation_logs.lead_id

      LEFT JOIN automation_rules

      ON automation_rules.id=automation_logs.automation_rule_id

      WHERE automation_logs.tenant_id=$1

      ORDER BY automation_logs.created_at DESC

      LIMIT 100

    `,[tenantId]);

    res.json(result.rows);

  }catch(error){

    console.error(error);

    res.status(500).json({
      error:'Erro'
    });

  }

});

module.exports=router;
