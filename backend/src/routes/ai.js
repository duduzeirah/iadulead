const express = require('express');
const { auth } = require('../middleware/auth');
const { suggestReply } = require('../services/aiService');

const router = express.Router();

router.use(auth);

router.post('/suggest-reply', async (req, res) => {
  try {
    const { lead, messages = [], mode = 'quick' } = req.body || {};

    if (!lead || !lead.id) {
      return res.status(400).json({ error: 'Lead não informado.' });
    }

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        error: 'Histórico de mensagens inválido.'
      });
    }

    const result = await suggestReply({
      lead,
      messages,
      mode: mode === 'complete' ? 'complete' : 'quick'
    });

    return res.json(result);
  } catch (error) {
    console.error('Erro ao sugerir resposta com IA:', error);

    return res.status(error.status || 500).json({
      error: error.message || 'Erro ao gerar sugestão.'
    });
  }
});

module.exports = router;
