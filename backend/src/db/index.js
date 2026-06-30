const { Pool } = require("pg");

console.log("DB URL:", process.env.DATABASE_URL ? "OK" : "NÃO EXISTE");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("connect", () => {
  console.log("✅ PostgreSQL conectado");
});

pool.on("error", (err) => {
  console.error("ERRO DO POOL:", err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
