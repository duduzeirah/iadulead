const { Pool } = require('pg');

const pool = new Pool({
  host: 'db.ridincbkambyxjyjgvzz.supabase.co',
  port: 5432,
  user: 'postgres',
  password: 'Glut040618$$',
  database: 'postgres',
  ssl: {
    rejectUnauthorized: false
  }
});

const query = (text, params) => pool.query(text, params);

module.exports = { query, pool };
