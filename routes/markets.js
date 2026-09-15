/**
 * Markets Routes — public market data endpoints
 * GET /api/markets                  — All pairs
 * GET /api/markets/:symbol          — Single pair info
 * GET /api/markets/:symbol/ticker   — 24hr ticker
 * GET /api/markets/:symbol/orderbook — Order book snapshot
 * GET /api/markets/:symbol/trades   — Recent trades
 * GET /api/markets/:symbol/klines   — OHLCV candles
 */
'use strict';
const marketsRouter = require('express').Router();
const { query }  = require('../models/db');
const { redis }  = require('../services/redis');
const { logger } = require('../services/logger');

marketsRouter.get('/', async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM market_pairs WHERE status = 'active' ORDER BY symbol");
    // Enrich with live prices from Redis cache
    const pairs = await Promise.all(result.rows.map(async (pair) => {
      const priceData = await redis.hget('prices', pair.symbol);
      const live = priceData ? JSON.parse(priceData) : {};
      return { ...pair, price: live.price || null, ch24: live.ch24 || null, vol: live.vol || null };
    }));
    res.json({ pairs });
  } catch (err) { next(err); }
});

marketsRouter.get('/:symbol/klines', async (req, res, next) => {
  try {
    const { symbol }   = req.params;
    const { interval = '1h', limit = 500, startTime, endTime } = req.query;
    const conditions = ['symbol=$1', 'interval=$2'];
    const params     = [symbol.toUpperCase(), interval];
    let i = 3;
    if (startTime) { conditions.push(`open_time >= to_timestamp($${i++})`); params.push(parseInt(startTime)/1000); }
    if (endTime)   { conditions.push(`open_time <= to_timestamp($${i++})`); params.push(parseInt(endTime)/1000); }
    params.push(Math.min(parseInt(limit), 1000));

    const result = await query(`
      SELECT EXTRACT(EPOCH FROM open_time)::bigint * 1000 as time,
             open, high, low, close, volume, trades
      FROM ohlcv WHERE ${conditions.join(' AND ')}
      ORDER BY open_time DESC LIMIT $${i}
    `, params);

    // If no data in DB yet, return empty (frontend falls back to Binance direct)
    res.json({ candles: result.rows.reverse() });
  } catch (err) { next(err); }
});

marketsRouter.get('/:symbol/ticker', async (req, res, next) => {
  try {
    const priceData = await redis.hget('prices', req.params.symbol.toUpperCase());
    if (!priceData) return res.status(404).json({ error: 'Symbol not found or no price data.' });
    res.json(JSON.parse(priceData));
  } catch (err) { next(err); }
});

module.exports = marketsRouter;

// ─────────────────────────────────────────────────────────────

/**
 * Trades Routes
 * GET /api/trades              — User's trade history
 * GET /api/trades/:symbol      — Trades for a specific pair
 */
const tradesRouter = require('express').Router();
const { authenticate } = require('../middleware/auth');
tradesRouter.use(authenticate);

tradesRouter.get('/', async (req, res, next) => {
  try {
    const { symbol, limit = 50, offset = 0 } = req.query;
    const conditions = ['(t.buy_user_id=$1 OR t.sell_user_id=$1)'];
    const params     = [req.user.id];
    if (symbol) { conditions.push('t.symbol=$2'); params.push(symbol.toUpperCase()); }
    params.push(parseInt(limit), parseInt(offset));
    const result = await query(`
      SELECT t.id, t.symbol, t.price, t.quantity, t.quote_quantity,
             CASE WHEN t.buy_user_id=$1 THEN 'buy' ELSE 'sell' END as side,
             CASE WHEN t.buy_user_id=$1 THEN t.buyer_fee ELSE t.seller_fee END as fee,
             t.created_at
      FROM trades t WHERE ${conditions.join(' AND ')}
      ORDER BY t.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);
    res.json({ trades: result.rows });
  } catch (err) { next(err); }
});

module.exports.tradesRouter = tradesRouter;

// ─────────────────────────────────────────────────────────────

/**
 * Users Routes — authenticated user profile
 * GET   /api/users/me              — Get own profile
 * PATCH /api/users/me              — Update profile
 * GET   /api/users/me/notifications — Notifications
 * PATCH /api/users/me/notifications/:id/read
 * GET   /api/users/me/api-keys
 * POST  /api/users/me/api-keys
 * DELETE /api/users/me/api-keys/:id
 * GET   /api/users/me/referrals
 */
const usersRouter = require('express').Router();
const bcrypt      = require('bcryptjs');
const crypto      = require('crypto');
usersRouter.use(authenticate);

usersRouter.get('/me', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, email, first_name, last_name, phone, country, kyc_level, kyc_status,
             account_type, status, email_verified, two_fa_enabled, anti_phish_code,
             referral_code, language, vip_level, last_login_at, created_at
      FROM users WHERE id=$1
    `, [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        country: user.country,
        kycLevel: user.kyc_level,
        kycStatus: user.kyc_status,
        accountType: user.account_type,
        status: user.status,
        emailVerified: user.email_verified,
        twoFaEnabled: user.two_fa_enabled,
        antiPhishCode: user.anti_phish_code,
        referralCode: user.referral_code,
        language: user.language,
        vipLevel: user.vip_level,
        lastLoginAt: user.last_login_at,
        createdAt: user.created_at,
      }
    });
  } catch (err) { next(err); }
});

usersRouter.patch('/me', async (req, res, next) => {
  try {
    const { firstName, lastName, phone, country, language, antiPhishCode } = req.body;
    const updates = [];
    const params  = [];
    let i = 1;
    if (firstName)    { updates.push(`first_name=$${i++}`);      params.push(firstName); }
    if (lastName)     { updates.push(`last_name=$${i++}`);       params.push(lastName); }
    if (phone)        { updates.push(`phone=$${i++}`);           params.push(phone); }
    if (country)      { updates.push(`country=$${i++}`);         params.push(country); }
    if (language)     { updates.push(`language=$${i++}`);        params.push(language); }
    if (antiPhishCode){ updates.push(`anti_phish_code=$${i++}`); params.push(antiPhishCode); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });
    params.push(req.user.id);
    await query(`UPDATE users SET ${updates.join(',')} WHERE id=$${i}`, params);
    res.json({ message: 'Profile updated.' });
  } catch (err) { next(err); }
});

usersRouter.get('/me/notifications', async (req, res, next) => {
  try {
    const { limit = 30, offset = 0, unreadOnly } = req.query;
    const cond = unreadOnly === 'true' ? 'AND read_at IS NULL' : '';
    const result = await query(
      `SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE user_id=$1 ${cond} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, parseInt(limit), parseInt(offset)]
    );
    const unread = await query('SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
    res.json({ notifications: result.rows, unreadCount: parseInt(unread.rows[0].count) });
  } catch (err) { next(err); }
});

usersRouter.patch('/me/notifications/:id/read', async (req, res, next) => {
  try {
    await query('UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ message: 'Marked as read.' });
  } catch (err) { next(err); }
});

usersRouter.get('/me/api-keys', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, label, key_prefix, permissions, ip_whitelist, status, last_used_at, expires_at, created_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ apiKeys: result.rows });
  } catch (err) { next(err); }
});

usersRouter.post('/me/api-keys', async (req, res, next) => {
  try {
    const { label, permissions, ipWhitelist, twoFACode } = req.body;

    // Verify 2FA
    const userRes = await query('SELECT two_fa_secret, two_fa_enabled FROM users WHERE id=$1', [req.user.id]);
    const user = userRes.rows[0];
    if (user.two_fa_enabled) {
      const speakeasy = require('speakeasy');
      const valid = speakeasy.totp.verify({ secret: user.two_fa_secret, encoding: 'base32', token: twoFACode, window: 1 });
      if (!valid) return res.status(401).json({ error: 'Invalid 2FA code.' });
    }

    const rawKey = `exch_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash   = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12) + '...';

    await query(`
      INSERT INTO api_keys (user_id, label, key_hash, key_prefix, permissions, ip_whitelist)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [req.user.id, label || 'API Key', keyHash, keyPrefix, permissions || ['read'], ipWhitelist || []]);

    // Return the raw key ONCE — it cannot be retrieved again
    res.status(201).json({ apiKey: rawKey, label, message: 'Save this key now — it will not be shown again.' });
  } catch (err) { next(err); }
});

usersRouter.delete('/me/api-keys/:id', async (req, res, next) => {
  try {
    await query("UPDATE api_keys SET status='revoked' WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    res.json({ message: 'API key revoked.' });
  } catch (err) { next(err); }
});

usersRouter.get('/me/referrals', async (req, res, next) => {
  try {
    const refs = await query(`
      SELECT u.first_name as firstName, u.created_at as joined_at, u.kyc_level,
             COALESCE(SUM(re.commission_amt), 0) as earned
      FROM users u
      LEFT JOIN referral_earnings re ON re.referee_id = u.id AND re.referrer_id = $1
      WHERE u.referred_by = $1
      GROUP BY u.id ORDER BY u.created_at DESC
    `, [req.user.id]);
    const total = await query('SELECT COALESCE(SUM(commission_amt),0) as total FROM referral_earnings WHERE referrer_id=$1', [req.user.id]);
    res.json({ referrals: refs.rows, totalEarned: parseFloat(total.rows[0].total) });
  } catch (err) { next(err); }
});

module.exports.usersRouter = usersRouter;

// ─────────────────────────────────────────────────────────────

/**
 * Admin Routes — require admin role
 */
const adminRouter = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/users', async (req, res, next) => {
  try {
    const { search, kycStatus, status, limit = 20, offset = 0 } = req.query;
    const conditions = ['TRUE'];
    const params     = [];
    let i = 1;
    if (search)    { conditions.push(`(email ILIKE $${i} OR first_name ILIKE $${i} OR id::text = $${i})`); params.push(`%${search}%`); i++; }
    if (kycStatus) { conditions.push(`kyc_status=$${i++}`); params.push(kycStatus); }
    if (status)    { conditions.push(`status=$${i++}`);     params.push(status); }
    params.push(parseInt(limit), parseInt(offset));
    const result = await query(`SELECT id,email,first_name,last_name,kyc_level,kyc_status,status,created_at,last_login_at FROM users WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i+1}`, params);
    const total  = await query(`SELECT COUNT(*) FROM users WHERE ${conditions.join(' AND ')}`, params.slice(0,-2));
    res.json({ users: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) { next(err); }
});

adminRouter.patch('/users/:id/status', async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    if (!['active','suspended','banned'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const before = await query('SELECT status FROM users WHERE id=$1', [req.params.id]);
    await query('UPDATE users SET status=$1 WHERE id=$2', [status, req.params.id]);
    await require('../services/audit').auditLog({ adminId: req.user.id, action: `user_${status}`, entityId: req.params.id, oldValue: before.rows[0], newValue: { status, reason } });
    res.json({ message: `User ${status}.` });
  } catch (err) { next(err); }
});

adminRouter.get('/pending-withdrawals', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT t.*, u.email, u.first_name, u.kyc_level
      FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE t.type='withdrawal' AND t.status='pending_review'
      ORDER BY t.created_at ASC
    `);
    res.json({ withdrawals: result.rows });
  } catch (err) { next(err); }
});

adminRouter.post('/withdrawals/:id/approve', async (req, res, next) => {
  try {
    const tx = await query("SELECT * FROM transactions WHERE id=$1 AND status='pending_review'", [req.params.id]);
    if (!tx.rows.length) return res.status(404).json({ error: 'Withdrawal not found or already processed.' });
    const t = tx.rows[0];
    await query("UPDATE transactions SET status='pending' WHERE id=$1", [t.id]);
    const { redis: r } = require('../services/redis');
    await r.rpush('withdrawal_queue', JSON.stringify({ txId: t.id, userId: t.user_id, symbol: t.symbol, network: t.network, amount: parseFloat(t.amount), fee: parseFloat(t.fee), address: t.to_address }));
    await require('../services/audit').auditLog({ adminId: req.user.id, action: 'withdrawal_approved', entityId: t.id });
    res.json({ message: 'Withdrawal approved and queued for processing.' });
  } catch (err) { next(err); }
});

adminRouter.post('/withdrawals/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body;
    const tx = await query("SELECT * FROM transactions WHERE id=$1 AND status='pending_review'", [req.params.id]);
    if (!tx.rows.length) return res.status(404).json({ error: 'Withdrawal not found.' });
    const t = tx.rows[0];
    await query("UPDATE transactions SET status='failed', admin_note=$1 WHERE id=$2", [reason || 'Rejected by admin', t.id]);
    // Unlock the balance
    await query('UPDATE wallets SET locked_balance = GREATEST(0, locked_balance - $1) WHERE user_id=$2 AND symbol=$3', [parseFloat(t.amount)+parseFloat(t.fee), t.user_id, t.symbol]);
    await require('../services/notifications').notifyUser(t.user_id, 'withdrawal', `Withdrawal rejected: ${reason || 'See support for details.'}`);
    await require('../services/audit').auditLog({ adminId: req.user.id, action: 'withdrawal_rejected', entityId: t.id, newValue: { reason } });
    res.json({ message: 'Withdrawal rejected and balance unlocked.' });
  } catch (err) { next(err); }
});

adminRouter.get('/disputes', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT d.*, po.crypto_amount, po.symbol, po.fiat_amount, po.fiat_currency,
             ub.email as buyer_email, us.email as seller_email
      FROM disputes d
      JOIN p2p_orders po ON po.id = d.order_id
      JOIN users ub ON ub.id = po.buyer_id
      JOIN users us ON us.id = po.seller_id
      WHERE d.status IN ('open','in_review')
      ORDER BY d.created_at ASC
    `);
    res.json({ disputes: result.rows });
  } catch (err) { next(err); }
});

adminRouter.post('/disputes/:id/resolve', async (req, res, next) => {
  try {
    const { resolution, note } = req.body; // resolution: 'buyer' | 'seller'
    if (!['buyer','seller'].includes(resolution)) return res.status(400).json({ error: 'resolution must be "buyer" or "seller".' });

    const disp = await query("SELECT * FROM disputes WHERE id=$1 AND status IN ('open','in_review')", [req.params.id]);
    if (!disp.rows.length) return res.status(404).json({ error: 'Dispute not found.' });
    const d = disp.rows[0];
    const order = (await query('SELECT * FROM p2p_orders WHERE id=$1', [d.order_id])).rows[0];

    const client = await getClient();
    try {
      await client.query('BEGIN');
      if (resolution === 'buyer') {
        // Release crypto to buyer
        await client.query('INSERT INTO wallets (user_id,symbol,total_balance,locked_balance) VALUES ($1,$2,$3,0) ON CONFLICT(user_id,symbol) DO UPDATE SET total_balance=wallets.total_balance+$3', [order.buyer_id, order.symbol, order.escrow_amount]);
        await client.query('UPDATE wallets SET total_balance=total_balance-$1, locked_balance=GREATEST(0,locked_balance-$1) WHERE user_id=$2 AND symbol=$3', [order.escrow_amount, order.seller_id, order.symbol]);
      } else {
        // Return crypto to seller
        await client.query('UPDATE wallets SET locked_balance=GREATEST(0,locked_balance-$1) WHERE user_id=$2 AND symbol=$3', [order.escrow_amount, order.seller_id, order.symbol]);
      }
      await client.query("UPDATE p2p_orders SET status='completed' WHERE id=$1", [order.id]);
      await client.query("UPDATE disputes SET status=$1, resolution_note=$2, resolved_at=NOW(), assigned_to=$3 WHERE id=$4", [`resolved_${resolution}`, note, req.user.id, d.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(()=>{});
      throw err;
    } finally { client.release(); }

    await require('../services/notifications').notifyUser(order.buyer_id, 'p2p', `P2P dispute resolved in favour of the ${resolution}.`);
    await require('../services/notifications').notifyUser(order.seller_id, 'p2p', `P2P dispute resolved in favour of the ${resolution}.`);
    await require('../services/audit').auditLog({ adminId: req.user.id, action: 'dispute_resolved', entityId: d.id, newValue: { resolution, note } });
    res.json({ message: `Dispute resolved in favour of ${resolution}.` });
  } catch (err) { next(err); }
});

adminRouter.get('/stats', async (req, res, next) => {
  try {
    const [users, vol24h, fees24h, pendingActions] = await Promise.all([
      query('SELECT COUNT(*) FROM users'),
      query("SELECT COALESCE(SUM(quote_quantity),0) as vol FROM trades WHERE created_at > NOW() - INTERVAL '24 hours'"),
      query("SELECT COALESCE(SUM(buyer_fee+seller_fee),0) as fees FROM trades WHERE created_at > NOW() - INTERVAL '24 hours'"),
      query("SELECT (SELECT COUNT(*) FROM transactions WHERE status='pending_review') + (SELECT COUNT(*) FROM kyc_documents WHERE status='pending') + (SELECT COUNT(*) FROM disputes WHERE status IN ('open','in_review')) as total"),
    ]);
    res.json({
      totalUsers:     parseInt(users.rows[0].count),
      volume24h:      parseFloat(vol24h.rows[0].vol),
      fees24h:        parseFloat(fees24h.rows[0].fees),
      pendingActions: parseInt(pendingActions.rows[0].total),
    });
  } catch (err) { next(err); }
});

module.exports.adminRouter = adminRouter;

// ─────────────────────────────────────────────────────────────

/**
 * KYC Routes
 * POST /api/kyc/initiate    — Start KYC (create Sumsub applicant)
 * GET  /api/kyc/status      — Get KYC status
 * POST /api/kyc/documents   — Upload docs (fallback if not using Sumsub SDK)
 */
const kycRouter = require('express').Router();
const axios = require('axios');
kycRouter.use(authenticate);

kycRouter.get('/status', async (req, res, next) => {
  try {
    const result = await query('SELECT kyc_level, kyc_status FROM users WHERE id=$1', [req.user.id]);
    const docs   = await query("SELECT id, level, doc_type, status, submitted_at FROM kyc_documents WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 5", [req.user.id]);
    res.json({ ...result.rows[0], documents: docs.rows });
  } catch (err) { next(err); }
});

kycRouter.post('/initiate', async (req, res, next) => {
  try {
    const sumsubAppToken   = process.env.SUMSUB_APP_TOKEN;
    const sumsubSecretKey  = process.env.SUMSUB_SECRET_KEY;

    if (!sumsubAppToken || !sumsubSecretKey) {
      return res.status(501).json({ error: 'KYC provider not configured. Please set SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY.' });
    }

    // Create Sumsub applicant
    // Sumsub API: https://developers.sumsub.com/api-reference/#creating-an-applicant
    const ts   = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ externalUserId: req.user.id, email: req.user.email });
    const sig  = crypto.createHmac('sha256', sumsubSecretKey).update(`${ts}POSTV1/resources/applicants?levelName=basic-kyc-level${body}`).digest('hex');

    const applicantRes = await axios.post(
      'https://api.sumsub.com/resources/applicants?levelName=basic-kyc-level',
      JSON.parse(body),
      { headers: { 'X-App-Token': sumsubAppToken, 'X-App-Access-Sig': sig, 'X-App-Access-Ts': ts, 'Content-Type': 'application/json' } }
    );

    const applicantId = applicantRes.data.id;

    // Generate an SDK access token for the frontend
    const ts2 = Math.floor(Date.now() / 1000);
    const sig2 = crypto.createHmac('sha256', sumsubSecretKey).update(`${ts2}POSTV1/resources/accessTokens?userId=${req.user.id}&levelName=basic-kyc-level`).digest('hex');
    const tokenRes = await axios.post(
      `https://api.sumsub.com/resources/accessTokens?userId=${req.user.id}&levelName=basic-kyc-level`,
      {},
      { headers: { 'X-App-Token': sumsubAppToken, 'X-App-Access-Sig': sig2, 'X-App-Access-Ts': ts2 } }
    );

    // Save KYC submission record
    await query(`
      INSERT INTO kyc_documents (user_id, level, provider, provider_ref, status)
      VALUES ($1, 2, 'sumsub', $2, 'pending')
      ON CONFLICT DO NOTHING
    `, [req.user.id, applicantId]);

    await query("UPDATE users SET kyc_status='pending' WHERE id=$1", [req.user.id]);

    res.json({
      applicantId,
      sdkToken: tokenRes.data.token, // Use this in the Sumsub Web SDK on the frontend
      message: 'KYC session created. Use the sdkToken with the Sumsub Web SDK.',
    });
  } catch (err) {
    logger.error('KYC initiate error:', err.message);
    next(err);
  }
});

module.exports.kycRouter = kycRouter;
module.exports.marketsRouter = marketsRouter;

// ── DEPOSIT APPROVAL ROUTES (add to adminRouter) ──
const { approveDeposit, rejectDeposit } = require('../services/depositMonitor');

// List pending deposits awaiting approval
adminRouter.get('/pending-deposits', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT t.id, t.user_id, t.symbol, t.network, t.amount, t.tx_hash,
             t.note, t.created_at,
             u.email, u.first_name, u.last_name, u.kyc_level, u.kyc_status
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.type = 'deposit' AND t.status = 'pending_review'
      ORDER BY t.created_at ASC
    `);
    res.json({ deposits: result.rows, count: result.rows.length });
  } catch (err) { next(err); }
});

// Approve a deposit — credits user balance
adminRouter.post('/deposits/:id/approve', async (req, res, next) => {
  try {
    const tx = await approveDeposit({ txId: req.params.id, adminId: req.user.id });
    res.json({ message: `Deposit of ${tx.amount} ${tx.symbol} approved and credited to user.`, tx });
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    next(err);
  }
});

// Reject a deposit
adminRouter.post('/deposits/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body;
    await rejectDeposit({ txId: req.params.id, adminId: req.user.id, reason });
    res.json({ message: 'Deposit rejected. User has been notified.' });
  } catch (err) { next(err); }
});

// Get all transactions (admin view)
adminRouter.get('/transactions', async (req, res, next) => {
  try {
    const { type, status, symbol, limit = 50, offset = 0 } = req.query;
    const conditions = ['TRUE'];
    const params     = [];
    let i = 1;
    if (type)   { conditions.push(`t.type=$${i++}`);   params.push(type); }
    if (status) { conditions.push(`t.status=$${i++}`); params.push(status); }
    if (symbol) { conditions.push(`t.symbol=$${i++}`); params.push(symbol.toUpperCase()); }
    params.push(parseInt(limit), parseInt(offset));
    const result = await query(`
      SELECT t.*, u.email, u.first_name, u.last_name
      FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.created_at DESC LIMIT $${i} OFFSET $${i+1}
    `, params);
    const total = await query(`SELECT COUNT(*) FROM transactions t WHERE ${conditions.join(' AND ')}`, params.slice(0,-2));
    res.json({ transactions: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) { next(err); }
});

// Manual balance adjustment (admin credit/debit)
adminRouter.post('/users/:id/balance-adjust', async (req, res, next) => {
  try {
    const { symbol, amount, type, note } = req.body; // type: 'credit'|'debit'
    if (!symbol || !amount || !type) return res.status(400).json({ error: 'symbol, amount, type required.' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount.' });

    if (type === 'credit') {
      await query(`
        INSERT INTO wallets (user_id, symbol, total_balance, locked_balance)
        VALUES ($1,$2,$3,0)
        ON CONFLICT (user_id, symbol) DO UPDATE SET total_balance = wallets.total_balance + $3
      `, [req.params.id, symbol.toUpperCase(), amt]);
      await query(`
        INSERT INTO transactions (user_id, type, symbol, amount, status, note, reviewed_by)
        VALUES ($1,'deposit',$2,$3,'completed',$4,$5)
      `, [req.params.id, symbol.toUpperCase(), amt, note || 'Admin credit', req.user.id]);
    } else {
      await query(`
        UPDATE wallets SET total_balance = GREATEST(0, total_balance - $1)
        WHERE user_id=$2 AND symbol=$3
      `, [amt, req.params.id, symbol.toUpperCase()]);
      await query(`
        INSERT INTO transactions (user_id, type, symbol, amount, status, note, reviewed_by)
        VALUES ($1,'withdrawal',$2,$3,'completed',$4,$5)
      `, [req.params.id, symbol.toUpperCase(), amt, note || 'Admin debit', req.user.id]);
    }

    const { notifyUser: nu } = require('../services/notifications');
    await nu(req.params.id, type === 'credit' ? 'deposit' : 'withdrawal',
      `Account ${type === 'credit' ? 'credited' : 'debited'}: ${amt} ${symbol}`,
      { body: note || `Balance adjusted by admin.` }
    );
    await require('../services/audit').auditLog({ adminId: req.user.id, action: `admin_balance_${type}`, entityId: req.params.id, newValue: { symbol, amount: amt, note } });
    res.json({ message: `User balance ${type}ed: ${amt} ${symbol}` });
  } catch (err) { next(err); }
});
