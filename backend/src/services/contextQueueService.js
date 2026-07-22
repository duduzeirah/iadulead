const { refreshLeadContext } = require('./leadContextService');
const { publish } = require('./realtimeService');

const pending = new Map();

function keyOf(tenantId, leadId) {
  return `${String(tenantId)}:${String(leadId)}`;
}

function scheduleLeadContextRefresh({
  tenantId,
  leadId,
  delayMs = 3500,
  force = false
}) {
  if (!tenantId || !leadId) return;

  const key = keyOf(tenantId, leadId);
  const previous = pending.get(key);

  if (previous) clearTimeout(previous.timer);

  const timer = setTimeout(async () => {
    pending.delete(key);

    try {
      const context = await refreshLeadContext({
        tenantId,
        leadId,
        force
      });

      if (context) {
        publish(tenantId, 'context.updated', {
          lead_id: leadId,
          purchase_intent: context.purchase_intent,
          urgency: context.urgency,
          recommended_status: context.recommended_status
        });

        publish(tenantId, 'lead.updated', {
          lead_id: leadId,
          context_updated: true
        });
      }
    } catch (error) {
      console.warn(
        'Contexto comercial automático não atualizado:',
        error.message
      );
    }
  }, Math.max(500, Number(delayMs) || 3500));

  pending.set(key, { timer });
}

function cancelLeadContextRefresh({ tenantId, leadId }) {
  const key = keyOf(tenantId, leadId);
  const current = pending.get(key);

  if (current) {
    clearTimeout(current.timer);
    pending.delete(key);
  }
}

module.exports = {
  scheduleLeadContextRefresh,
  cancelLeadContextRefresh
};
