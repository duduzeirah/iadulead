const express =
  require('express');

const jwt =
  require('jsonwebtoken');

const {
  subscribe
} =
  require(
    '../services/realtimeService'
  );

const router =
  express.Router();

router.get(
  '/',
  (req, res) => {
    try {
      const token =
        String(
          req.query.token ||
          ''
        ).trim();

      if (!token) {
        return res
          .status(401)
          .json({
            error:
              'Token não informado.'
          });
      }

      const decoded =
        jwt.verify(
          token,
          process.env.JWT_SECRET
        );

      const tenantId =
        decoded.tenant_id ||
        decoded.tenantId;

      if (!tenantId) {
        return res
          .status(401)
          .json({
            error:
              'Token sem empresa vinculada.'
          });
      }

      subscribe(
        tenantId,
        res
      );
    } catch (error) {
      return res
        .status(401)
        .json({
          error:
            error.name ===
            'TokenExpiredError'
              ? 'Sessão expirada.'
              : 'Token inválido.'
        });
    }
  }
);

module.exports =
  router;
