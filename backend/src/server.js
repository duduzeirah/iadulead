// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// ── SECURITY ───────────────────────────────────────────
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    /\.netlify\.app$/,
    /\.render\.com$/,
    /\.railway\.app$/,
    /localhost/,
  ],
  credentials: true,
}));

const apiLimiter = rateLimit({ windowMs: 15*60*1000, max: 300, message: { error: 'Muitas requisições, tente novamente em 15 minutos' } });
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Muitas tentativas de login, aguarde 15 minutos' } });

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Iadu Lead API', version: '1.0.0', ts: new Date().toISOString() });
});

// Rota temporária só para checar se a DATABASE_URL está chegando (sem mostrar a senha)
app.get('/debug-env', (req, res) => {
  const url = process.env.DATABASE_URL || '';
  const masked = url.replace(/:([^:@]+)@/, ':****@');
  res.json({
    hasDbUrl: !!process.env.DATABASE_URL,
    dbUrlMasked: masked,
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
  });
});

app.use('/api/auth',        require('./routes/auth'));
app.use('/api/leads',       require('./routes/leads'));
app.use('/api/reminders',   require('./routes/reminders'));
app.use('/api/templates',   require('./routes/templates'));
app.use('/api/dashboard',   require('./routes/dashboard'));

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// ── RODA A MIGRAÇÃO AUTOMATICAMENTE ANTES DE SUBIR O SERVIDOR ──
async function startServer() {
  try {
    console.log('🔧 Verificando/criando tabelas do banco de dados...');
    const { runMigration } = require('./db/migrate');
    await runMigration();
    console.log('✅ Banco de dados pronto!');
  } catch (err) {
    console.error('⚠️ Aviso na migração automática (pode ser que as tabelas já existam):', err.message);
  }

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║  💬  IADU LEAD API  — v1.0.0         ║
║  Porta: ${PORT}                          ║
║  Ambiente: ${process.env.NODE_ENV || 'development'}                 ║
╚══════════════════════════════════════╝
    `);
  });
}

startServer();

module.exports = app;
