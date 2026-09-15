/**
 * PostgreSQL connection pool + full schema migration
 * Run: node models/migrate.js
 * Recommended host: Supabase (free tier) or AWS RDS
 */

'use strict';
const { Pool } = require('pg');
const { logger } = require('../services/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => logger.error('Unexpected DB pool error', err));

// ── QUERY HELPER ──────────────────────────────
async function query(text, params) {
  const start = Date.now();
  const res   = await pool.query(text, params);
  const dur   = Date.now() - start;
  if (dur > 500) logger.warn(`Slow query (${dur}ms): ${text.slice(0, 80)}`);
  return res;
}

async function getClient() { return pool.connect(); }

async function initDB() {
  const client = await pool.connect();
  try { await client.query('SELECT 1'); }
  finally { client.release(); }
}

async function checkDB() {
  try { await pool.query('SELECT 1'); return true; }
  catch { return false; }
}

// ── FULL SCHEMA ───────────────────────────────
const SCHEMA = `

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  first_name      VARCHAR(100),
  last_name       VARCHAR(100),
  phone           VARCHAR(30),
  country         VARCHAR(10),
  kyc_level       SMALLINT DEFAULT 0,          -- 0=unverified, 1=email, 2=ID, 3=address
  kyc_status      VARCHAR(20) DEFAULT 'none',  -- none|pending|approved|rejected
  account_type    VARCHAR(20) DEFAULT 'individual', -- individual|business
  status          VARCHAR(20) DEFAULT 'active',     -- active|suspended|banned
  email_verified  BOOLEAN DEFAULT FALSE,
  phone_verified  BOOLEAN DEFAULT FALSE,
  two_fa_secret   VARCHAR(100),
  google_id       VARCHAR(100) UNIQUE,
  avatar_url      TEXT,
  two_fa_enabled  BOOLEAN DEFAULT FALSE,
  anti_phish_code VARCHAR(50),
  referral_code   VARCHAR(20) UNIQUE,
  referred_by     UUID REFERENCES users(id),
  language        VARCHAR(10) DEFAULT 'en',
  vip_level       SMALLINT DEFAULT 0,
  last_login_at   TIMESTAMPTZ,
  last_login_ip   VARCHAR(50),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral   ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users(kyc_status);

-- ── SESSIONS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(255) NOT NULL,
  device_info   TEXT,
  ip_address    VARCHAR(50),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── EMAIL VERIFICATIONS ───────────────────────
CREATE TABLE IF NOT EXISTS email_verifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       VARCHAR(100) UNIQUE NOT NULL,
  type        VARCHAR(30) NOT NULL, -- email_verify|password_reset|withdraw_confirm
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── KYC DOCUMENTS ─────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level           SMALLINT NOT NULL,
  doc_type        VARCHAR(30),  -- passport|national_id|drivers_license|utility_bill
  doc_front_url   TEXT,         -- S3 URL (encrypted)
  doc_back_url    TEXT,
  selfie_url      TEXT,
  provider        VARCHAR(30),  -- sumsub|smile_identity|manual
  provider_ref    VARCHAR(100), -- external KYC provider reference ID
  status          VARCHAR(20) DEFAULT 'pending', -- pending|in_review|approved|rejected
  rejection_reason TEXT,
  reviewed_by     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kyc_user   ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_documents(status);

-- ── WALLETS (per user, per asset) ─────────────
CREATE TABLE IF NOT EXISTS wallets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol        VARCHAR(20) NOT NULL,
  total_balance NUMERIC(30, 10) DEFAULT 0,
  locked_balance NUMERIC(30, 10) DEFAULT 0,  -- in open orders or escrow
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);

-- ── DEPOSIT ADDRESSES (one per user per network) ──
CREATE TABLE IF NOT EXISTS deposit_addresses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  symbol        VARCHAR(20) NOT NULL,
  network       VARCHAR(30) NOT NULL,  -- bitcoin|ethereum|tron|bsc|solana
  address       VARCHAR(200) UNIQUE NOT NULL,
  hd_index      INTEGER,               -- derivation path index (for HD wallets)
  provider_ref  TEXT,                  -- Fireblocks vault address ID
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, symbol, network)
);
CREATE INDEX IF NOT EXISTS idx_dep_addr_address ON deposit_addresses(address);
CREATE INDEX IF NOT EXISTS idx_dep_addr_user    ON deposit_addresses(user_id);

-- ── WITHDRAWAL ADDRESS WHITELIST ──────────────
CREATE TABLE IF NOT EXISTS withdrawal_addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       VARCHAR(100),
  symbol      VARCHAR(20) NOT NULL,
  network     VARCHAR(30) NOT NULL,
  address     VARCHAR(200) NOT NULL,
  whitelisted BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_with_addr_user ON withdrawal_addresses(user_id);

-- ── TRANSACTIONS ──────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  type            VARCHAR(20) NOT NULL, -- deposit|withdrawal|trade_fee|p2p|referral_bonus|transfer
  symbol          VARCHAR(20) NOT NULL,
  network         VARCHAR(30),
  amount          NUMERIC(30, 10) NOT NULL,
  fee             NUMERIC(30, 10) DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'pending', -- pending|processing|completed|failed|cancelled
  tx_hash         VARCHAR(200),
  from_address    VARCHAR(200),
  to_address      VARCHAR(200),
  confirmations   INTEGER DEFAULT 0,
  required_confs  INTEGER DEFAULT 2,
  block_height    BIGINT,
  note            TEXT,
  admin_note      TEXT,
  reviewed_by     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_user    ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_status  ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_hash    ON transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_tx_type    ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);

-- ── MARKET PAIRS ──────────────────────────────
CREATE TABLE IF NOT EXISTS market_pairs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          VARCHAR(20) UNIQUE NOT NULL,  -- BTCUSDT
  base_asset      VARCHAR(10) NOT NULL,         -- BTC
  quote_asset     VARCHAR(10) NOT NULL,         -- USDT
  status          VARCHAR(10) DEFAULT 'active', -- active|suspended|delisted
  min_price       NUMERIC(30,10) DEFAULT 0,
  max_price       NUMERIC(30,10),
  tick_size       NUMERIC(30,10) DEFAULT 0.01,  -- price precision
  min_qty         NUMERIC(30,10) DEFAULT 0.0001,
  max_qty         NUMERIC(30,10),
  step_size       NUMERIC(30,10) DEFAULT 0.0001,-- qty precision
  min_notional    NUMERIC(30,10) DEFAULT 1,     -- min order value in USDT
  maker_fee       NUMERIC(10,6) DEFAULT 0.001,
  taker_fee       NUMERIC(10,6) DEFAULT 0.001,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── ORDERS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_order_id VARCHAR(100),
  user_id         UUID NOT NULL REFERENCES users(id),
  symbol          VARCHAR(20) NOT NULL,
  side            VARCHAR(5) NOT NULL,     -- buy|sell
  type            VARCHAR(20) NOT NULL,    -- limit|market|stop_limit|oco
  status          VARCHAR(20) DEFAULT 'open', -- open|partially_filled|filled|cancelled|rejected|expired
  price           NUMERIC(30,10),          -- null for market orders
  stop_price      NUMERIC(30,10),          -- for stop-limit
  quantity        NUMERIC(30,10) NOT NULL,
  filled_qty      NUMERIC(30,10) DEFAULT 0,
  remaining_qty   NUMERIC(30,10),
  avg_fill_price  NUMERIC(30,10),
  cumulative_quote NUMERIC(30,10) DEFAULT 0, -- total USDT spent/received
  fee             NUMERIC(30,10) DEFAULT 0,
  fee_asset       VARCHAR(10),
  time_in_force   VARCHAR(10) DEFAULT 'GTC', -- GTC|IOC|FOK
  iceberg_qty     NUMERIC(30,10),
  ip_address      VARCHAR(50),
  source          VARCHAR(20) DEFAULT 'web', -- web|api|mobile
  cancelled_at    TIMESTAMPTZ,
  filled_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_symbol  ON orders(symbol);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- ── TRADES (fills) ────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          VARCHAR(20) NOT NULL,
  buy_order_id    UUID REFERENCES orders(id),
  sell_order_id   UUID REFERENCES orders(id),
  buy_user_id     UUID REFERENCES users(id),
  sell_user_id    UUID REFERENCES users(id),
  price           NUMERIC(30,10) NOT NULL,
  quantity        NUMERIC(30,10) NOT NULL,
  quote_quantity  NUMERIC(30,10) NOT NULL,  -- price * quantity
  buyer_fee       NUMERIC(30,10) DEFAULT 0,
  seller_fee      NUMERIC(30,10) DEFAULT 0,
  fee_asset       VARCHAR(10),
  is_buyer_maker  BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol  ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_buy_usr ON trades(buy_user_id);
CREATE INDEX IF NOT EXISTS idx_trades_sell_usr ON trades(sell_user_id);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC);

-- ── OHLCV CANDLES (time-series) ───────────────
-- Use TimescaleDB for this table if available
CREATE TABLE IF NOT EXISTS ohlcv (
  symbol    VARCHAR(20) NOT NULL,
  interval  VARCHAR(5) NOT NULL,   -- 1m|5m|15m|1h|4h|1d|1w
  open_time TIMESTAMPTZ NOT NULL,
  open      NUMERIC(30,10),
  high      NUMERIC(30,10),
  low       NUMERIC(30,10),
  close     NUMERIC(30,10),
  volume    NUMERIC(30,10),
  trades    INTEGER DEFAULT 0,
  PRIMARY KEY (symbol, interval, open_time)
);
CREATE INDEX IF NOT EXISTS idx_ohlcv ON ohlcv(symbol, interval, open_time DESC);

-- ── P2P ADS ───────────────────────────────────
CREATE TABLE IF NOT EXISTS p2p_ads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  type            VARCHAR(4) NOT NULL,      -- buy|sell (from advertiser's perspective)
  symbol          VARCHAR(10) NOT NULL,     -- BTC|ETH|USDT
  fiat_currency   VARCHAR(5) NOT NULL,      -- USD|NGN|GBP
  price           NUMERIC(20,6) NOT NULL,   -- price per 1 unit of symbol in fiat
  price_type      VARCHAR(10) DEFAULT 'fixed', -- fixed|floating
  price_margin    NUMERIC(6,4),             -- for floating (e.g. 1.02 = 2% above market)
  min_limit       NUMERIC(20,6) NOT NULL,
  max_limit       NUMERIC(20,6) NOT NULL,
  total_amount    NUMERIC(30,10) NOT NULL,  -- total crypto available
  remaining_amount NUMERIC(30,10) NOT NULL,
  payment_methods TEXT[],                   -- ['bank_transfer','mobile_money']
  payment_details JSONB,                    -- bank name, account number etc. (encrypted)
  trade_terms     TEXT,
  auto_reply      TEXT,
  window_minutes  INTEGER DEFAULT 15,       -- payment window
  status          VARCHAR(20) DEFAULT 'active', -- active|paused|completed|cancelled
  trade_count     INTEGER DEFAULT 0,
  completion_rate NUMERIC(5,2) DEFAULT 100,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_p2p_ads_user   ON p2p_ads(user_id);
CREATE INDEX IF NOT EXISTS idx_p2p_ads_sym    ON p2p_ads(symbol, type, status);
CREATE INDEX IF NOT EXISTS idx_p2p_ads_fiat   ON p2p_ads(fiat_currency);

-- ── P2P ORDERS ────────────────────────────────
CREATE TABLE IF NOT EXISTS p2p_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id           UUID NOT NULL REFERENCES p2p_ads(id),
  buyer_id        UUID NOT NULL REFERENCES users(id),
  seller_id       UUID NOT NULL REFERENCES users(id),
  symbol          VARCHAR(10) NOT NULL,
  fiat_currency   VARCHAR(5) NOT NULL,
  crypto_amount   NUMERIC(30,10) NOT NULL,
  fiat_amount     NUMERIC(20,6) NOT NULL,
  price           NUMERIC(20,6) NOT NULL,
  payment_method  VARCHAR(50),
  status          VARCHAR(20) DEFAULT 'pending', -- pending|paid|released|cancelled|disputed|completed
  escrow_amount   NUMERIC(30,10) NOT NULL,       -- locked crypto amount
  payment_proof_url TEXT,
  expires_at      TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  released_at     TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_p2p_ord_buyer  ON p2p_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_p2p_ord_seller ON p2p_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_p2p_ord_status ON p2p_orders(status);

-- ── P2P CHAT ──────────────────────────────────
CREATE TABLE IF NOT EXISTS p2p_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES p2p_orders(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES users(id),
  message     TEXT,
  image_url   TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_p2p_msg_order ON p2p_messages(order_id, created_at);

-- ── P2P DISPUTES ──────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES p2p_orders(id),
  opened_by       UUID NOT NULL REFERENCES users(id),
  reason          VARCHAR(100),
  description     TEXT,
  evidence_urls   TEXT[],
  status          VARCHAR(20) DEFAULT 'open', -- open|in_review|resolved_buyer|resolved_seller|closed
  assigned_to     UUID REFERENCES users(id), -- admin
  resolution_note TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disputes_order  ON disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

-- ── NOTIFICATIONS ─────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(50) NOT NULL, -- order_filled|deposit|withdrawal|p2p|kyc|security|promo
  title       VARCHAR(200) NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user   ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id) WHERE read_at IS NULL;

-- ── API KEYS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           VARCHAR(100),
  key_hash        VARCHAR(255) UNIQUE NOT NULL,  -- hash of the actual key
  key_prefix      VARCHAR(20),                   -- first 8 chars shown in UI
  permissions     TEXT[] DEFAULT '{"read"}',     -- read|trade|withdraw
  ip_whitelist    TEXT[],
  status          VARCHAR(10) DEFAULT 'active',  -- active|revoked
  last_used_at    TIMESTAMPTZ,
  last_used_ip    VARCHAR(50),
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ── REFERRALS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_earnings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID NOT NULL REFERENCES users(id),
  referee_id      UUID NOT NULL REFERENCES users(id),
  trade_id        UUID REFERENCES trades(id),
  symbol          VARCHAR(10),
  commission_pct  NUMERIC(6,4) DEFAULT 0.20,  -- 20% of fee
  commission_amt  NUMERIC(30,10),
  fee_asset       VARCHAR(10),
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ref_earn_referrer ON referral_earnings(referrer_id);

-- ── AUDIT LOGS ────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  admin_id    UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   UUID,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  VARCHAR(50),
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- ── FEE SCHEDULES ─────────────────────────────
CREATE TABLE IF NOT EXISTS fee_schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vip_level       SMALLINT UNIQUE NOT NULL,
  min_volume_30d  NUMERIC(20,2) DEFAULT 0,
  maker_fee       NUMERIC(8,6) NOT NULL,
  taker_fee       NUMERIC(8,6) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO fee_schedules (vip_level, min_volume_30d, maker_fee, taker_fee) VALUES
  (0, 0,         0.001,  0.001),
  (1, 50000,     0.0009, 0.001),
  (2, 200000,    0.0008, 0.0009),
  (3, 1000000,   0.0006, 0.0008),
  (4, 5000000,   0.0004, 0.0006),
  (5, 20000000,  0.0002, 0.0004)
ON CONFLICT (vip_level) DO NOTHING;

-- ── PLATFORM SETTINGS ─────────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO platform_settings (key, value, description) VALUES
  ('trading_enabled',       'true',  'Enable/disable all trading'),
  ('deposits_enabled',      'true',  'Enable/disable deposits'),
  ('withdrawals_enabled',   'true',  'Enable/disable withdrawals'),
  ('registrations_enabled', 'true',  'Allow new user registrations'),
  ('p2p_enabled',           'true',  'Enable P2P marketplace'),
  ('maintenance_mode',      'false', 'Put platform in maintenance mode'),
  ('withdrawal_review_threshold', '5000', 'USD value above which manual review is required'),
  ('max_login_attempts',    '5',     'Max failed logins before lockout'),
  ('lockout_duration_mins', '30',    'Account lockout duration in minutes')
ON CONFLICT (key) DO NOTHING;

-- ── UPDATE TIMESTAMP TRIGGER ──────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','wallets','orders','p2p_ads','p2p_orders']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END;
$$;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    logger.info('Running database migration...');
    await client.query(SCHEMA);
    logger.info('✅ Database schema created/verified');
  } catch (err) {
    logger.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, getClient, initDB, checkDB, migrate, pool };
