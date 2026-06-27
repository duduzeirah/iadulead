// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ── SECURITY ───────────────────────────────────────────
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    /\.netlify\.app$/,
    /\.render\.com$/,
    /localhost/,
  ],
  credentials: true,
}));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 15*60*1000, max: 300, message: { error: 'Muitas requisições, tente novamente em 15 minutos' } });
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Muitas tentativas de login, aguarde 15 minutos' } });

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ── BODY PARSER ────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── HEALTH CHECK ───────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Iadu Lead API', version: '1.0.0', ts: new Date().toISOString() });
});

// ── API ROUTES ─────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/leads',       require('./routes/leads'));
app.use('/api/reminders',   require('./routes/reminders'));
app.use('/api/templates',   require('./routes/templates'));
app.use('/api/dashboard',   require('./routes/dashboard'));

// ── SERVE FRONTEND (when frontend is in /public) ───────
// Uncomment if you want a single-server deploy
// app.use(express.static(path.join(__dirname, '../../frontend/public')));
// app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../../frontend/public/index.html')));

// ── 404 ────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// ── ERROR HANDLER ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// ── START ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  💬  IADU LEAD API  — v1.0.0         ║
║  Porta: ${PORT}                          ║
║  Ambiente: ${process.env.NODE_ENV || 'development'}                 ║
╚══════════════════════════════════════╝
  `);
});

module.exports = app;
