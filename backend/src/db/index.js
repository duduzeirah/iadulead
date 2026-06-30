const { Pool } = require('pg');

const pool = new Pool({
  host: 'db.ridincbkambyxjyjgvzz.supabase.co',
  port: 5432,
  user: 'postgres',
  password: 'Glut040618$$',
  database: 'postgres',
  family: 4, // 🔥 FORÇA IPv4 (ESSA É A CHAVE)
  ssl: {
    rejectUnauthorized: false
  }
});

const query = (text, params) => pool.query(text, params);

module.exports = { query, pool };
