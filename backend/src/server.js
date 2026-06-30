require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 8080;

// SECURITY
app.use(helmet({ crossOriginEmbedderPolicy: false }));

app.use(cors({
  origin: true,
  credentials: true,
}));

// PROXY FIX (resolve erro de headers do Railway/Render)
app.set('trust proxy', 1);

// LIMITERS
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// BODY
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// HEALTH
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Iadu Lead API',
    ts: new Date().toISOString()
  });
});

// ROUTES
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/dashboard', require('./routes/dashboard'));

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ERROR
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// START
app.listen(PORT, () => {
  console.log('API rodando na porta', PORT);
});
