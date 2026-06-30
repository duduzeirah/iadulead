const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Erro no pool do banco:', err);
});

const query = (text, params) => pool.query(text, params);

module.exports = { query, pool };
