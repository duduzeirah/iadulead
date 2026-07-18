const OPENAI_URL = 'https://api.openai.com/v1/responses';

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function statusLabel(status) {
  const labels = {
    novo: 'Novo lead',
    atendendo: 'Em atendimento',
    aguardando: 'Aguardando',
    fechado: 'Horário marcado',
    comprou: 'Serviço realizado',
    assinante: 'Cliente recorrente',
    inativo: 'Atendimento encerrado',
    sumido: 'Não respondeu'
  };
  return labels[status] || status || 'Não informado';
}

function localFallback({ lead, messages, mode }) {
  const name = clean(lead?.name, 80).split(' ')[0] || 'Olá';
  const product = clean(lead?.product, 150);
  const lastInbound = [...(messages || [])]
    .reverse()
    .find(message => message.direction !== 'outbound');

  const customerText = clean(lastInbound?.message, 500).toLowerCase();

  if (/pre[cç]o|valor|quanto|parcela/.test(customerText)) {
    return `${name}, posso te explicar certinho os valores${product ? ` de ${product}` : ''} e as formas de pagamento. Para eu te orientar melhor, você prefere pagamento à vista ou parcelado?`;
  }

  if (/hor[aá]rio|agenda|marcar|agendar|dispon[ií]vel/.test(customerText)) {
    return `${name}, vamos verificar o melhor horário para você. Qual dia e período ficam mais fáceis: manhã, tarde ou noite?`;
  }

  if (/vou pensar|pensar|depois|ainda n[aã]o sei/.test(customerText)) {
    return `${name}, sem problema. Posso esclarecer qualquer dúvida antes de você decidir. O que mais pesa para você neste momento: valor, resultado ou manutenção?`;
  }

  if (mode === 'complete') {
    return `${name}, analisei seu atendimento. Pelo seu interesse${product ? ` em ${product}` : ''}, o melhor próximo passo é entender sua principal dúvida e conduzir para uma decisão. O que você gostaria de confirmar antes de avançarmos?`;
  }

  return `${name}, obrigado por entrar em contato${product ? ` sobre ${product}` : ''}. Me conte qual é sua principal dúvida para eu te orientar da melhor forma.`;
}

function buildInput({ lead, messages, mode }) {
  const history = (messages || []).slice(-20).map(message => {
    const author = message.direction === 'outbound' ? 'ATENDENTE' : 'CLIENTE';
    return `${author}: ${clean(message.message, 1500)}`;
  }).join('\n');

  return `
Você é o assistente comercial do CRM Iadu Lead.
Crie somente UMA mensagem pronta para ser enviada ao cliente, em português do Brasil.

REGRAS:
- Seja natural, profissional, humano e objetivo.
- Não invente preços, horários, promoções ou garantias.
- Não diga que é uma IA.
- Não use títulos, análises, aspas ou explicações.
- Termine com uma pergunta que ajude o atendimento a avançar.
- Use no máximo ${mode === 'complete' ? '90' : '55'} palavras.
- Considere a última mensagem do cliente como prioridade.

DADOS DO LEAD:
Nome: ${clean(lead?.name, 100)}
Etapa: ${statusLabel(lead?.status)}
Produto/serviço: ${clean(lead?.product, 200) || 'Não informado'}
Valor estimado: ${clean(lead?.estimated_value, 50) || 'Não informado'}
Assunto: ${clean(lead?.conversation_topic, 100) || 'Não informado'}
Prioridade: ${clean(lead?.commercial_priority, 100) || 'Não informada'}
Relacionamento: ${clean(lead?.customer_relationship, 100) || 'Não informado'}
Observações: ${clean(lead?.notes, 800) || 'Sem observações'}

CONVERSA:
${history || 'Nenhuma mensagem registrada.'}
`.trim();
}

async function suggestReply(payload) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      suggestion: localFallback(payload),
      provider: 'fallback'
    };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: buildInput(payload),
      max_output_tokens: 220
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data?.error?.message || 'Erro ao consultar a inteligência artificial.'
    );
    error.status = response.status;
    throw error;
  }

  const suggestion = clean(data.output_text, 2000);

  if (!suggestion) {
    throw new Error('A inteligência artificial não retornou uma resposta.');
  }

  return {
    suggestion,
    provider: 'openai',
    model
  };
}

module.exports = { suggestReply };
