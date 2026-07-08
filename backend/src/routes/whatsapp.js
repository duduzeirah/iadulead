const express = require('express');

const router = express.Router();

// Endpoint que receberá os eventos da Evolution
router.post('/webhook', async (req, res) => {
  try {
    console.log('=================================');
    console.log('EVENTO RECEBIDO DA EVOLUTION');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('=================================');

    return res.status(200).json({
      success: true,
      message: 'Evento recebido com sucesso'
    });

  } catch (error) {
    console.error('Erro webhook Evolution:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
