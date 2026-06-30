const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on('error', (err) => {
  console.error('ERRO DB:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
