const axios = require('axios');

function evolutionConfig() {
  const baseURL = String(
    process.env.EVOLUTION_URL || ''
  ).replace(/\/$/, '');

  const apiKey =
    process.env.EVOLUTION_API_KEY;

  if (!baseURL) {
    throw new Error(
      'EVOLUTION_URL não configurada'
    );
  }

  if (!apiKey) {
    throw new Error(
      'EVOLUTION_API_KEY não configurada'
    );
  }

  return {
    baseURL,
    apiKey
  };
}

async function evolutionRequest(
  method,
  path,
  data
) {
  const {
    baseURL,
    apiKey
  } = evolutionConfig();

  return axios({
    method,

    url:
      `${baseURL}${path}`,

    headers: {
      apikey:
        apiKey,

      'Content-Type':
        'application/json'
    },

    data,

    timeout:
      25000
  });
}

function publicBackendUrl() {
  if (
    process.env.PUBLIC_BACKEND_URL
  ) {
    return String(
      process.env.PUBLIC_BACKEND_URL
    ).replace(/\/$/, '');
  }

  if (
    process.env.RAILWAY_PUBLIC_DOMAIN
  ) {
    return (
      `https://${String(
        process.env.RAILWAY_PUBLIC_DOMAIN
      )
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '')}`
    );
  }

  throw new Error(
    'PUBLIC_BACKEND_URL não configurada'
  );
}

function safeInstanceName(
  tenantId
) {
  return (
    `iadu_${String(tenantId)
      .replace(
        /[^a-zA-Z0-9]/g,
        ''
      )
      .slice(0, 18)
      .toLowerCase()}`
  );
}

function extractQr(data) {
  return (
    data?.base64 ||
    data?.qrcode?.base64 ||
    data?.qr?.base64 ||
    data?.code ||
    data?.qrcode?.code ||
    null
  );
}

function extractState(data) {
  return (
    data?.instance?.state ||
    data?.state ||
    data?.connectionStatus ||
    data?.status ||
    'unknown'
  );
}

module.exports = {
  evolutionRequest,
  publicBackendUrl,
  safeInstanceName,
  extractQr,
  extractState
};
