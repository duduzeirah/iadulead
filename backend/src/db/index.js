const { Pool } = require('pg');

console.log('DATABASE_URL existe?', !!process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.connect()
  .then(client => {
    console.log('✅ BANCO CONECTOU!');
    client.release();
  })
  .catch(err => {
    console.error('❌ ERRO AO CONECTAR NO BANCO:');
    console.error(err);
  });

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
