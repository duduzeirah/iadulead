const clientsByTenant = new Map();

function tenantKey(tenantId) {
  return String(tenantId || '').trim();
}

function subscribe(tenantId, res) {
  const key = tenantKey(tenantId);

  if (!key) {
    throw new Error('Tenant não informado para tempo real.');
  }

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  res.write(`event: connected\ndata: ${JSON.stringify({ connected: true })}\n\n`);

  if (!clientsByTenant.has(key)) {
    clientsByTenant.set(key, new Set());
  }

  const clients = clientsByTenant.get(key);
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);

    if (clients.size === 0) {
      clientsByTenant.delete(key);
    }
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
}

function publish(tenantId, eventName, payload = {}) {
  const key = tenantKey(tenantId);
  const clients = clientsByTenant.get(key);

  if (!clients || clients.size === 0) {
    return 0;
  }

  const event = String(eventName || 'message');
  const data = JSON.stringify({
    ...payload,
    realtime_event: event,
    emitted_at: new Date().toISOString()
  });

  let delivered = 0;

  for (const res of [...clients]) {
    try {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
      delivered += 1;
    } catch {
      clients.delete(res);
    }
  }

  if (clients.size === 0) {
    clientsByTenant.delete(key);
  }

  return delivered;
}

function connectedClients(tenantId) {
  return clientsByTenant.get(tenantKey(tenantId))?.size || 0;
}

module.exports = {
  subscribe,
  publish,
  connectedClients
};
