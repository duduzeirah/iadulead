// src/db/migrate.js
// Pode rodar direto: node src/db/migrate.js
// Ou ser chamado pelo server.js: require('./migrate').runMigration()
const { query } = require('./index');

async function runMigration() {
  console.log('🚀 Iniciando migração do banco de dados Iadu Lead...');

  // ── EXTENSÕES ──────────────────────────────────────────────
  await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  // ── ENUM TIPOS ─────────────────────────────────────────────
  await query(`
    DO $$ BEGIN
      CREATE TYPE lead_status AS ENUM (
        'novo', 'atendendo', 'aguardando', 'fechado',
        'comprou', 'assinante', 'inativo', 'sumido'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE reminder_type AS ENUM (
        'followup', 'proposta', 'ligar', 'mensagem', 'reuniao', 'outro'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE template_category AS ENUM (
        'followup', 'boasvindas', 'reativacao', 'venda', 'outro'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE subscription_status AS ENUM (
        'trial', 'active', 'cancelled', 'expired', 'past_due'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE plan_type AS ENUM (
        'trial', 'basic', 'pro', 'enterprise'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  // ── TABELA: TENANTS ──────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name          VARCHAR(255) NOT NULL,
      slug          VARCHAR(100) UNIQUE,
      segment       VARCHAR(100),
      phone         VARCHAR(50),
      plan          plan_type NOT NULL DEFAULT 'trial',
      sub_status    subscription_status NOT NULL DEFAULT 'trial',
      trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      sub_ends_at   TIMESTAMPTZ,
      stripe_customer_id  VARCHAR(100),
      stripe_sub_id       VARCHAR(100),
      leads_limit   INTEGER NOT NULL DEFAULT 100,
      users_limit   INTEGER NOT NULL DEFAULT 1,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      settings      JSONB NOT NULL DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── TABELA: USERS ─────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name          VARCHAR(255) NOT NULL,
      email         VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(50) NOT NULL DEFAULT 'attendant',
      avatar_color  VARCHAR(20) DEFAULT '#00C566',
      is_active     BOOLEAN NOT NULL DEFAULT true,
      last_login_at TIMESTAMPTZ,
      email_verified BOOLEAN DEFAULT false,
      reset_token   VARCHAR(255),
      reset_expires TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── TABELA: LEADS ─────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS leads (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
      name            VARCHAR(255) NOT NULL,
      phone           VARCHAR(50) NOT NULL,
      email           VARCHAR(255),
      status          lead_status NOT NULL DEFAULT 'novo',
      origin          VARCHAR(100) DEFAULT 'WhatsApp',
      product         VARCHAR(255),
      estimated_value NUMERIC(12,2) DEFAULT 0,
      tag             VARCHAR(50),
      notes           TEXT,
      last_contact_at TIMESTAMPTZ DEFAULT NOW(),
      closed_at       TIMESTAMPTZ,
      bought_at       TIMESTAMPTZ,
      position        INTEGER DEFAULT 0,
      custom_fields   JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── TABELA: LEAD_ACTIVITIES ───────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id     UUID REFERENCES leads(id) ON DELETE CASCADE,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      type        VARCHAR(100) NOT NULL,
      description TEXT NOT NULL,
      metadata    JSONB DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── TABELA: REMINDERS ─────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id     UUID REFERENCES leads(id) ON DELETE CASCADE,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       VARCHAR(500) NOT NULL,
      type        reminder_type NOT NULL DEFAULT 'followup',
      due_date    DATE NOT NULL,
      due_time    TIME DEFAULT '09:00',
      is_done     BOOLEAN NOT NULL DEFAULT false,
      done_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── TABELA: TEMPLATES ─────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS message_templates (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      title       VARCHAR(255) NOT NULL,
      category    template_category NOT NULL DEFAULT 'followup',
      body        TEXT NOT NULL,
      is_default  BOOLEAN DEFAULT false,
      usage_count INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── TABELA: REMARKETING_CAMPAIGNS ─────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS remarketing_campaigns (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      name        VARCHAR(255) NOT NULL,
      target      VARCHAR(100) NOT NULL,
      message     TEXT NOT NULL,
      status      VARCHAR(50) DEFAULT 'draft',
      sent_count  INTEGER DEFAULT 0,
      scheduled_at TIMESTAMPTZ,
      sent_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── TABELA: REFRESH_TOKENS ────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       VARCHAR(500) NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── TABELA: WHATSAPP_CONNECTIONS ──────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_connections (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id       UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
      provider        VARCHAR(30) NOT NULL DEFAULT 'evolution',
      instance_name   VARCHAR(150) UNIQUE,
      status          VARCHAR(30) NOT NULL DEFAULT 'disconnected',
      phone_number    VARCHAR(50),
      connected_at    TIMESTAMPTZ,
      access_token    TEXT,
      phone_number_id VARCHAR(150),
      waba_id         VARCHAR(150),
      last_error      TEXT,
      metadata        JSONB NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── ÍNDICES ───────────────────────────────────────────────
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_tenant    ON leads(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_status    ON leads(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_phone     ON leads(phone)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_created   ON leads(created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_assigned  ON leads(assigned_to)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_activities_lead ON lead_activities(lead_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_activities_tenant ON lead_activities(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_reminders_tenant ON reminders(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_reminders_due   ON reminders(due_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_email     ON users(email)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_tenant    ON users(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_instance ON whatsapp_connections(instance_name)`);

  // ── FUNÇÃO: updated_at automático ─────────────────────────
  await query(`
    CREATE OR REPLACE FUNCTION update_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `);
  for (const t of ['tenants','users','leads','message_templates','whatsapp_connections']) {
    await query(`
      DROP TRIGGER IF EXISTS trg_${t}_updated ON ${t};
      CREATE TRIGGER trg_${t}_updated
        BEFORE UPDATE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `);
  }

  console.log('✅ Migração concluída com sucesso!');
  console.log('📌 Tabelas: tenants, users, leads, lead_activities, reminders, message_templates, remarketing_campaigns, refresh_tokens');
}

// Se rodado diretamente via "node src/db/migrate.js"
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
  runMigration()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Erro na migração:', err);
      process.exit(1);
    });
}

module.exports = { runMigration };
