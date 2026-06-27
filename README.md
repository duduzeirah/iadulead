# 💬 Iadu Lead — CRM SaaS para WhatsApp

> Sistema completo de gestão de leads via WhatsApp.
> Multi-tenant, com trial de 7 dias, banco de dados real e pronto para escalar.

---

## 🏗️ Arquitetura

```
iadulead-saas/
├── backend/              ← API Node.js + Express
│   ├── src/
│   │   ├── server.js     ← Servidor principal
│   │   ├── db/
│   │   │   ├── index.js         ← Conexão PostgreSQL
│   │   │   ├── migrate.js       ← Cria todas as tabelas
│   │   │   └── seed-templates.js← Templates padrão
│   │   ├── middleware/
│   │   │   └── auth.js          ← JWT + validação de trial
│   │   └── routes/
│   │       ├── auth.js          ← Register, Login, Perfil
│   │       ├── leads.js         ← CRUD completo de leads
│   │       ├── reminders.js     ← Lembretes
│   │       ├── templates.js     ← Mensagens prontas
│   │       └── dashboard.js     ← Estatísticas
│   ├── .env.example      ← Variáveis de ambiente
│   └── package.json
├── frontend/
│   └── public/
│       └── index.html    ← App completo (HTML + CSS + JS)
├── render.yaml           ← Config deploy Render.com (backend)
└── netlify.toml          ← Config deploy Netlify (frontend)
```

---

## 🚀 DEPLOY GRATUITO — Passo a Passo Completo

### O que você vai usar (tudo grátis):
| Serviço      | Para quê              | Limite grátis        |
|--------------|-----------------------|----------------------|
| **Neon.tech**  | Banco PostgreSQL    | 0.5 GB, ilimitado    |
| **Render.com** | Backend Node.js     | 750h/mês             |
| **Netlify**    | Frontend estático   | 100 GB banda/mês     |
| **GitHub**     | Repositório         | Ilimitado            |

---

### PASSO 1 — Criar o banco de dados no Neon.tech

1. Acesse **https://neon.tech** e crie uma conta grátis
2. Clique em **"New Project"**
3. Escolha um nome: `iadulead`
4. Região: `US East` (mais próximo do Render)
5. Após criar, clique em **"Connection Details"**
6. Copie a **Connection String** (formato: `postgresql://user:pass@host/dbname?sslmode=require`)
7. **Guarde essa string** — você vai precisar no Passo 3

---

### PASSO 2 — Subir o código no GitHub

```bash
# No seu computador, na pasta iadulead-saas:
git init
git add .
git commit -m "🚀 Iadu Lead v1.0 - SaaS CRM para WhatsApp"

# Crie um repositório no GitHub (github.com/new)
# Depois conecte:
git remote add origin https://github.com/SEU_USUARIO/iadulead.git
git push -u origin main
```

---

### PASSO 3 — Deploy do Backend no Render.com

1. Acesse **https://render.com** e crie uma conta grátis
2. Clique em **"New +"** → **"Web Service"**
3. Conecte seu GitHub e selecione o repositório `iadulead`
4. Configure:
   - **Name:** `iadulead-api`
   - **Root Directory:** `backend`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** `Free`
5. Em **"Environment Variables"**, adicione:

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | (cole a string do Neon do Passo 1) |
   | `JWT_SECRET` | (gere uma senha aleatória longa — ex: `iadu_lead_secret_2026_xYzAbC123456789`) |
   | `NODE_ENV` | `production` |
   | `FRONTEND_URL` | (deixe em branco por enquanto, preenche depois do Passo 4) |
   | `TRIAL_DAYS` | `7` |

6. Clique em **"Create Web Service"**
7. Aguarde o deploy (3-5 minutos)
8. Ao final, copie a URL gerada: `https://iadulead-api.onrender.com`

---

### PASSO 4 — Rodar a migração do banco (criar as tabelas)

Após o backend estar online no Render, rode a migração de uma das formas:

**Opção A — Pelo Render Shell** (mais fácil):
1. No painel do Render, clique no seu serviço
2. Clique em **"Shell"** no menu lateral
3. Digite: `node src/db/migrate.js`
4. Deve aparecer: `✅ Migração concluída com sucesso!`

**Opção B — Localmente** (precisa do Node instalado):
```bash
cd backend
cp .env.example .env
# Edite o .env e coloque sua DATABASE_URL do Neon
npm install
node src/db/migrate.js
```

---

### PASSO 5 — Deploy do Frontend no Netlify

1. Acesse **https://netlify.com** e crie uma conta grátis
2. Clique em **"Add new site"** → **"Import from Git"**
3. Conecte seu GitHub e selecione o repositório `iadulead`
4. Configure:
   - **Base directory:** `frontend`
   - **Publish directory:** `public`
   - Build command: (deixe vazio)
5. Clique em **"Deploy site"**
6. Ao final, copie a URL gerada: `https://iadulead-xyz.netlify.app`

---

### PASSO 6 — Conectar frontend ↔ backend

**No frontend** (`frontend/public/index.html`), localize a linha:
```javascript
const API = ...
  : 'https://SEU-PROJETO.onrender.com/api'; // ← TROQUE AQUI
```
Substitua `https://SEU-PROJETO.onrender.com/api` pela URL real do seu Render.

**No Render**, atualize a variável `FRONTEND_URL` com a URL do Netlify:
- Ex: `https://iadulead-xyz.netlify.app`

Faça um novo commit para o GitHub — o Netlify atualiza automaticamente.

---

### PASSO 7 — Testar o sistema

1. Abra a URL do Netlify
2. Clique em **"Criar conta grátis"**
3. Preencha seus dados e clique em **"Criar Conta"**
4. Você terá **7 dias de trial** automático
5. Cadastre seus primeiros leads e teste tudo!

---

## 🔐 Como funciona o sistema multi-tenant

Cada pessoa que se cadastrar recebe:
- Um **tenant** (organização) isolado no banco
- Um **usuário** vinculado ao tenant
- **Trial de 7 dias** automaticamente
- Templates de mensagem padrão já carregados
- Dados **100% isolados** de outros usuários

---

## 💰 Estrutura para cobrar assinaturas (Stripe)

O sistema já está preparado. Para ativar os pagamentos:

1. Crie uma conta no **https://stripe.com**
2. Crie um produto e copie o `Price ID`
3. Adicione ao Render:
   - `STRIPE_SECRET_KEY` = sua chave secreta do Stripe
   - `STRIPE_PRICE_ID` = ID do plano mensal
4. Implemente o checkout no frontend (rota `/subscribe`)

---

## 📊 Tabelas do banco de dados

| Tabela | Descrição |
|--------|-----------|
| `tenants` | Cada empresa/cliente do SaaS |
| `users` | Usuários (cada tenant pode ter vários) |
| `leads` | Leads/clientes de cada tenant |
| `lead_activities` | Histórico de ações em cada lead |
| `reminders` | Lembretes de follow-up |
| `message_templates` | Mensagens prontas por tenant |
| `remarketing_campaigns` | Campanhas de reativação |
| `refresh_tokens` | Tokens de autenticação |

---

## 🛠️ Rodar localmente (desenvolvimento)

```bash
# 1. Clone o repositório
git clone https://github.com/SEU_USUARIO/iadulead.git
cd iadulead

# 2. Configurar o backend
cd backend
cp .env.example .env
# Edite .env com sua DATABASE_URL do Neon
npm install
node src/db/migrate.js   # Cria as tabelas
npm run dev              # Inicia na porta 3001

# 3. Frontend (em outro terminal)
# Abra o arquivo frontend/public/index.html direto no navegador
# OU use Live Server no VS Code
```

---

## 📈 Planos para crescimento

| Fase | O que fazer |
|------|-------------|
| **Agora** | Usar e testar, grátis |
| **Fase 2** | Ativar Stripe + página de preços |
| **Fase 3** | Adicionar múltiplos usuários por tenant |
| **Fase 4** | Integração real WhatsApp (Z-API / Evolution API) |
| **Fase 5** | App mobile (React Native / PWA) |
| **Fase 6** | Relatórios avançados + IA para sugestões |

---

## 🆘 Problemas comuns

**"Cannot connect to database"**
→ Verifique se a `DATABASE_URL` está correta no Render e se o banco Neon está ativo.

**"CORS error" no frontend**
→ Verifique se `FRONTEND_URL` no Render bate exatamente com a URL do Netlify (sem barra no final).

**Backend "sleeping" no Render**
→ No plano gratuito, o Render dorme após 15min sem requisições. A primeira requisição demora ~30s para "acordar". Isso é normal no plano free.

**Token expirado**
→ O token JWT dura 7 dias. Faça login novamente.

---

## 📞 Suporte

Sistema desenvolvido para **Iadu Lead** — CRM SaaS para WhatsApp.
Versão 1.0.0 — Junho 2026
