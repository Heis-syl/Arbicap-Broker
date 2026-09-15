/**
 * models/migrate.js
 *
 * Creates the full Arbicap schema (16 tables) against the Postgres
 * database referenced by DATABASE_URL (Supabase connection string).
 *
 * Usage:  node models/migrate.js
 */

require('dotenv').config();
const { Client } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set in .env');
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Supabase pooled/direct connections
});

// Order matters: tables with foreign keys come after the tables they reference.
const statements = [
  // 1. users
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    full_name TEXT,
    country TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'support')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
    kyc_status TEXT NOT NULL DEFAULT 'unverified' CHECK (kyc_status IN ('unverified', 'pending', 'verified', 'rejected')),
    two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 2. oauth_accounts
  `CREATE TABLE IF NOT EXISTS oauth_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
  );`,

  // 3. sessions (refresh tokens)
  `CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 4. kyc_verifications
  `CREATE TABLE IF NOT EXISTS kyc_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type TEXT,
    document_number TEXT,
    document_front_url TEXT,
    document_back_url TEXT,
    selfie_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 5. assets (supported coins)
  `CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    symbol TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    decimals INT NOT NULL DEFAULT 8,
    is_active BOOLEAN NOT NULL DEFAULT true
  );`,

  // 6. markets (trading pairs)
  `CREATE TABLE IF NOT EXISTS markets (
    id SERIAL PRIMARY KEY,
    symbol TEXT UNIQUE NOT NULL,        -- e.g. BTCUSDT
    base_asset TEXT NOT NULL REFERENCES assets(symbol),
    quote_asset TEXT NOT NULL REFERENCES assets(symbol),
    is_active BOOLEAN NOT NULL DEFAULT true,
    min_order_size NUMERIC(30, 10) NOT NULL DEFAULT 0
  );`,

  // 7. company_wallets (custodial deposit addresses)
  `CREATE TABLE IF NOT EXISTS company_wallets (
    id SERIAL PRIMARY KEY,
    asset TEXT NOT NULL REFERENCES assets(symbol),
    network TEXT NOT NULL,
    address TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 8. user_balances (internal ledger balance per user per asset)
  `CREATE TABLE IF NOT EXISTS user_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset TEXT NOT NULL REFERENCES assets(symbol),
    available NUMERIC(30, 10) NOT NULL DEFAULT 0,
    locked NUMERIC(30, 10) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, asset)
  );`,

  // 9. ledger_entries (immutable audit trail for every balance change)
  `CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset TEXT NOT NULL REFERENCES assets(symbol),
    amount NUMERIC(30, 10) NOT NULL,        -- signed: positive = credit, negative = debit
    type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'trade', 'fee', 'adjustment', 'p2p')),
    reference_id UUID,                       -- points to deposits/withdrawals/trades row
    balance_after NUMERIC(30, 10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 10. deposits
  `CREATE TABLE IF NOT EXISTS deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset TEXT NOT NULL REFERENCES assets(symbol),
    amount NUMERIC(30, 10) NOT NULL,
    tx_hash TEXT,
    network TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'credited', 'failed')),
    confirmations INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    credited_at TIMESTAMPTZ
  );`,

  // 11. withdrawals
  `CREATE TABLE IF NOT EXISTS withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset TEXT NOT NULL REFERENCES assets(symbol),
    amount NUMERIC(30, 10) NOT NULL,
    destination_address TEXT NOT NULL,
    network TEXT,
    status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'rejected', 'processing', 'completed', 'failed')),
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 12. orders (spot trading)
  `CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    market_symbol TEXT NOT NULL REFERENCES markets(symbol),
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    type TEXT NOT NULL CHECK (type IN ('limit', 'market')),
    price NUMERIC(30, 10),
    quantity NUMERIC(30, 10) NOT NULL,
    filled_quantity NUMERIC(30, 10) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_filled', 'filled', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 13. trades (executions/fills)
  `CREATE TABLE IF NOT EXISTS trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_symbol TEXT NOT NULL REFERENCES markets(symbol),
    buy_order_id UUID NOT NULL REFERENCES orders(id),
    sell_order_id UUID NOT NULL REFERENCES orders(id),
    price NUMERIC(30, 10) NOT NULL,
    quantity NUMERIC(30, 10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 14. p2p_orders
  `CREATE TABLE IF NOT EXISTS p2p_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset TEXT NOT NULL REFERENCES assets(symbol),
    fiat_currency TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    price NUMERIC(30, 10) NOT NULL,
    min_amount NUMERIC(30, 10) NOT NULL,
    max_amount NUMERIC(30, 10) NOT NULL,
    payment_methods TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,

  // 15. p2p_trades (escrowed counterparty trades)
  `CREATE TABLE IF NOT EXISTS p2p_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    p2p_order_id UUID NOT NULL REFERENCES p2p_orders(id),
    buyer_id UUID NOT NULL REFERENCES users(id),
    seller_id UUID NOT NULL REFERENCES users(id),
    asset TEXT NOT NULL REFERENCES assets(symbol),
    amount NUMERIC(30, 10) NOT NULL,
    fiat_amount NUMERIC(30, 10) NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'paid', 'released', 'disputed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  );`,

  // 16. admin_audit_log
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_table TEXT,
    target_id TEXT,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`,
];

async function migrate() {
  await client.connect();
  console.log('Connected to database. Running migration...\n');

  try {
    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;'); // for gen_random_uuid()

    for (const [i, sql] of statements.entries()) {
      const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1];
      process.stdout.write(`[${i + 1}/${statements.length}] Creating "${tableName}"... `);
      await client.query(sql);
      console.log('done.');
    }

    await client.query('COMMIT');
    console.log('\nMigration complete. All tables created successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nMigration failed, rolled back:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
