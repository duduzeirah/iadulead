// src/db/seed-templates.js
const { query } = require('./index');

const DEFAULT_TEMPLATES = [
  // Follow-up
  { title:'Follow-up Suave (24h)', category:'followup', body:'Oi {nome}! 😊 Só passando para saber se surgiu alguma dúvida sobre {produto}. Qualquer coisa me chama!' },
  { title:'Follow-up Direto (48h)', category:'followup', body:'Oi {nome}! Vi que ainda não conseguimos avançar. Ainda tem interesse em {produto}? Consigo uma condição especial hoje. 🎯' },
  { title:'Último Follow-up', category:'followup', body:'Oi {nome}! Última tentativa de contato 😊 Se quiser retomar a conversa sobre {produto}, é só me chamar. Abraços!' },
  // Boas-vindas
  { title:'Boas-vindas Simples', category:'boasvindas', body:'Olá {nome}! 👋 Seja muito bem-vindo(a)! Sou {atendente}. Como posso te ajudar hoje?' },
  { title:'Boas-vindas com Menu', category:'boasvindas', body:'Oi {nome}! 😊 Obrigado por entrar em contato!\n\n1️⃣ Conhecer produtos\n2️⃣ Preços e planos\n3️⃣ Suporte\n\nResponda com o número da opção!' },
  // Reativação
  { title:'Reativação Suave', category:'reativacao', body:'Oi {nome}, quanto tempo! 😊 Passando para ver como você está e se posso te ajudar com algo.' },
  { title:'Oferta de Reativação', category:'reativacao', body:'Oi {nome}! Lembrei de você hoje 🎁 Tenho uma condição especial exclusiva para você. Posso te contar mais?' },
  { title:'Novidade', category:'reativacao', body:'Oi {nome}! Temos uma novidade que acho que vai te interessar muito 🚀 Tem um minutinho?' },
  // Venda
  { title:'Apresentação de Proposta', category:'venda', body:'Oi {nome}! Segue a proposta para {produto}:\n\n💰 Investimento: R$ {valor}\n✅ Inclui todos os benefícios combinados\n\nComo podemos prosseguir?' },
  { title:'Fechamento', category:'venda', body:'Oi {nome}! Consigo garantir {produto} com condição especial ainda hoje. Podemos fechar agora? 🤝' },
  { title:'Pós-venda', category:'venda', body:'Oi {nome}! 🎉 Muito obrigado pela confiança! Qualquer dúvida ou necessidade, pode me chamar a qualquer momento.' },
];

async function seedTemplatesForTenant(tenantId) {
  for (const tpl of DEFAULT_TEMPLATES) {
    await query(
      `INSERT INTO message_templates (tenant_id, title, category, body, is_default)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT DO NOTHING`,
      [tenantId, tpl.title, tpl.category, tpl.body]
    );
  }
}

module.exports = { seedTemplatesForTenant, DEFAULT_TEMPLATES };
