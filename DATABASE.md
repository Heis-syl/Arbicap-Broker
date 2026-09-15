# Database Setup Guide

## Recommended Stack

### Primary Database — PostgreSQL (Supabase)
**Use Supabase** — it gives you a fully managed PostgreSQL database with a generous free tier, built-in auth helpers, a visual table editor, and a dashboard to view your data.

**Why Supabase over others:**
- Free tier: 500MB storage, 2 database projects, unlimited API requests
- Visual dashboard — see every user, balance, transaction without writing SQL
- Row-level security built in
- Automatic backups
- Scales to millions of rows without touching config

**Setup (5 minutes):**
1. Go to https://supabase.com and create a free account
2. Click "New Project" — choose a name and a strong database password
3. Wait ~2 minutes for it to provision
4. Go to Settings → Database → Connection string
5. Copy the **URI** (starts with `postgresql://...`)
6. Paste it as `DATABASE_URL` in your `backend/.env` file
7. Run `node models/migrate.js` — this creates all 16 tables automatically

**Your Supabase dashboard URL:**  
`https://app.supabase.com/project/[your-project-id]/editor`  
You can view and edit all data here — users, balances, transactions, everything.

---

### Cache & Queues — Redis (Upstash)
**Use Upstash** — serverless Redis, free tier, no credit card needed.

- Free tier: 10,000 commands/day, 256MB
- Used for: price cache, session blacklist, withdrawal queue, deposit queue

**Setup:**
1. Go to https://upstash.com and sign up free
2. Create a Redis database → choose the region closest to your server
3. Copy the **Redis URL** (starts with `rediss://...`)
4. Paste as `REDIS_URL` in your `backend/.env`

---

## What Gets Stored Where

| Data | Database | Table |
|------|----------|-------|
| User accounts | PostgreSQL | `users` |
| Balances | PostgreSQL | `wallets` |
| Deposits / Withdrawals | PostgreSQL | `transactions` |
| Orders | PostgreSQL | `orders` |
| Trades | PostgreSQL | `trades` |
| KYC documents | PostgreSQL | `kyc_documents` |
| P2P ads & orders | PostgreSQL | `p2p_ads`, `p2p_orders` |
| Notifications | PostgreSQL | `notifications` |
| Session tokens | Redis | `session:*` |
| Price cache | Redis | `prices` hash |
| Withdrawal queue | Redis | `withdrawal_queue` list |
| Blacklisted tokens | Redis | `blacklist:*` |

---

## Viewing Your Data

Once Supabase is connected and `node models/migrate.js` has been run:

**See all users:**  
Supabase → Table Editor → `users`

**See all balances:**  
Supabase → Table Editor → `wallets`

**See all transactions:**  
Supabase → Table Editor → `transactions`

**Manually credit a user (admin):**  
```sql
-- In Supabase SQL Editor:
INSERT INTO wallets (user_id, symbol, total_balance, locked_balance)
VALUES ('user-uuid-here', 'USDT', 100.00, 0)
ON CONFLICT (user_id, symbol)
DO UPDATE SET total_balance = wallets.total_balance + 100.00;
```

**Make yourself admin:**  
```sql
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
```

---

## Email Verification Flow

When a user registers:
1. Backend creates account with `email_verified = false`
2. Sends verification email via SendGrid (set `SENDGRID_API_KEY` in `.env`)
3. User clicks link → `GET /api/auth/verify-email?token=xxx`
4. Backend marks `email_verified = true`
5. User can now fully use the platform

**For dev/testing without SendGrid:**  
Set `NODE_ENV=development` — emails are logged to the console instead of sent.  
You can manually verify a user in Supabase:
```sql
UPDATE users SET email_verified = true WHERE email = 'test@example.com';
```

---

## First-Time Setup Checklist

- [ ] Create Supabase project at https://supabase.com
- [ ] Copy `DATABASE_URL` from Supabase → Settings → Database → URI
- [ ] Create Upstash Redis at https://upstash.com
- [ ] Copy `REDIS_URL` from Upstash dashboard
- [ ] Paste both into `backend/.env`
- [ ] Run `cd backend && node models/migrate.js`
- [ ] Register your first account on the site
- [ ] Run `UPDATE users SET role = 'admin' WHERE email = 'your@email.com';` in Supabase SQL editor
- [ ] Visit `admin.html` — you now have full admin access
