/**
 * Wallet Routes
 *
 * Deposit rules:
 *   - No KYC required
 *   - No minimum amount
 *   - No daily limit
 *   - Submitted as pending_review; admin verifies the tx hash on a block
 *     explorer and approves before the balance is credited (see
 *     services/depositMonitor.js: approveDeposit/rejectDeposit)
 *
 * Withdrawal rules:
 *   - KYC Level 2 required (anti-bot identity check)
 *   - Admin manually approves every withdrawal
 *   - System is on hold until WITHDRAWALS_LIVE=true
 *   - UI shows maintenance notice but looks fully functional
 */
'use strict';
const router = require('express').Router();
const { query } = require('../models/db');
const { redis }  = require('../services/redis');
const { authenticate, requireKYC } = require('../middleware/auth');
const { auditLog }   = require('../services/audit');
const { notifyUser } = require('../services/notifications');
const { getOrCreateDepositAddress } = require('../services/custody');
const { submitDeposit } = require('../services/depositMonitor');
const { logger } = require('../services/logger');

const SUPPORTED_ASSETS = ['BTC','ETH','USDT','USDC','BNB','SOL','XRP','ADA','DOGE','MATIC','AVAX','LTC'];
const NETWORKS = {
  BTC:  ['bitcoin'],
  ETH:  ['ethereum'],
  USDT: ['ethereum','tron','bsc'],
  USDC: ['ethereum'],
  BNB:  ['bsc'],
  SOL:  ['solana'],
  XRP:  ['xrp'],
  ADA:  ['cardano'],
  DOGE: ['dogecoin'],
  MATIC:['polygon'],
  AVAX: ['avalanche'],
  LTC:  ['litecoin'],
};

router.use(authenticate);

// ── BALANCES ──────────────────────────────────
router.get('/balances', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT symbol, total_balance, locked_balance FROM wallets WHERE user_id=$1 ORDER BY total_balance DESC',
      [req.user.id]
    );
    res.json({ balances: result.rows });
  } catch (err) { next(err); }
});

// ── DEPOSIT ADDRESS ───────────────────────────
router.get('/deposit-address', async (req, res, next) => {
  try {
    const { symbol, network } = req.query;
    if (!symbol || !SUPPORTED_ASSETS.includes(symbol.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid or unsupported asset.' });
    }
    const sym = symbol.toUpperCase();
    const net = (network || NETWORKS[sym]?.[0])?.toLowerCase();
    if (!NETWORKS[sym]?.includes(net)) {
      return res.status(400).json({ error: `Network "${net}" not supported for ${sym}.` });
    }
    const result = await getOrCreateDepositAddress(req.user.id, sym, net);
    res.json({ symbol: sym, network: net, ...result });
  } catch (err) { next(err); }
});

// ── SUBMIT DEPOSIT (goes to pending_review — admin approval required) ──
// No KYC required, no minimum, no daily limit to submit; balance is only
// credited once an admin verifies the tx hash and approves it.
router.post('/deposit/submit', async (req, res, next) => {
  try {
    const { symbol, network, txHash, amount } = req.body;
    if (!symbol || !network || !txHash || !amount) {
      return res.status(400).json({ error: 'symbol, network, txHash, and amount are required.' });
    }
    const result = await submitDeposit({
      userId:  req.user.id,
      symbol:  symbol.toUpperCase(),
      network: network.toLowerCase(),
      txHash:  txHash.trim(),
      amount:  parseFloat(amount),
    });
    res.status(201).json({
      message: 'Deposit submitted. We\'ll credit your balance once it\'s verified — usually within a few hours.',
      ...result,
    });
  } catch (err) {
    if (err.message.includes('already') || err.message.includes('required') || err.message.includes('zero')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// ── WITHDRAW — KYC required, on hold until launch ──
router.post('/withdraw', requireKYC(2), async (req, res, next) => {
  try {
    const live = process.env.WITHDRAWALS_LIVE === 'true';
    if (!live) {
      logger.info(`Withdrawal attempt by ${req.user.id} — system not live`);
      return res.status(503).json({
        error: 'Withdrawals are temporarily under maintenance.',
        message: 'Our withdrawal system is being upgraded. Your funds are safe and your balance is unchanged. We will notify you when withdrawals are available.',
        status: 'maintenance',
      });
    }

    const { symbol, network, address, amount, twoFACode } = req.body;
    const sym = symbol?.toUpperCase();
    if (!sym || !address || !amount) {
      return res.status(400).json({ error: 'symbol, network, address, amount are required.' });
    }

    // Verify 2FA if enabled
    const userResult = await query('SELECT two_fa_secret, two_fa_enabled FROM users WHERE id=$1', [req.user.id]);
    const user = userResult.rows[0];
    if (user.two_fa_enabled) {
      if (!twoFACode) return res.status(400).json({ error: '2FA code required.' });
      const speakeasy = require('speakeasy');
      const valid = speakeasy.totp.verify({ secret: user.two_fa_secret, encoding: 'base32', token: twoFACode, window: 1 });
      if (!valid) return res.status(401).json({ error: 'Invalid 2FA code.' });
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount.' });

    // Check balance
    const walletResult = await query(
      'SELECT total_balance, locked_balance FROM wallets WHERE user_id=$1 AND symbol=$2',
      [req.user.id, sym]
    );
    const wallet = walletResult.rows[0];
    const available = wallet ? (parseFloat(wallet.total_balance) - parseFloat(wallet.locked_balance)) : 0;
    if (available < amt) {
      return res.status(400).json({ error: `Insufficient balance. Available: ${available.toFixed(8)} ${sym}.` });
    }

    // Lock balance and create pending_review record
    await query('UPDATE wallets SET locked_balance = locked_balance + $1 WHERE user_id=$2 AND symbol=$3',
      [amt, req.user.id, sym]);
    const txResult = await query(`
      INSERT INTO transactions (user_id, type, symbol, network, amount, fee, status, to_address, note)
      VALUES ($1,'withdrawal',$2,$3,$4,0,'pending_review',$5,'Awaiting admin approval')
      RETURNING id
    `, [req.user.id, sym, network || NETWORKS[sym]?.[0], amt, address]);

    await redis.rpush('withdrawal_queue', JSON.stringify({
      txId: txResult.rows[0].id, userId: req.user.id,
      symbol: sym, network, amount: amt, fee: 0, address,
    }));

    await notifyUser(req.user.id, 'withdrawal', `Withdrawal of ${amt} ${sym} is pending review`);
    await auditLog({ userId: req.user.id, action: 'withdrawal_submitted', entityId: txResult.rows[0].id, ip: req.ip });

    res.json({
      message: 'Withdrawal request received. You will be notified once processed.',
      txId: txResult.rows[0].id,
      status: 'pending_review',
    });
  } catch (err) { next(err); }
});

// ── TRANSACTION HISTORY ───────────────────────
router.get('/transactions', async (req, res, next) => {
  try {
    const { type, symbol, status, limit = 20, offset = 0, startDate, endDate } = req.query;
    const conditions = ['user_id=$1'];
    const params     = [req.user.id];
    let i = 2;
    if (type)      { conditions.push(`type=$${i++}`);                 params.push(type); }
    if (symbol)    { conditions.push(`symbol=$${i++}`);               params.push(symbol.toUpperCase()); }
    if (status)    { conditions.push(`status=$${i++}`);               params.push(status); }
    if (startDate) { conditions.push(`created_at>=$${i++}`);          params.push(startDate); }
    if (endDate)   { conditions.push(`created_at<=$${i++}`);          params.push(endDate); }
    const totalRes = await query(`SELECT COUNT(*) FROM transactions WHERE ${conditions.join(' AND ')}`, params);
    params.push(Math.min(parseInt(limit), 100), parseInt(offset));
    const result = await query(
      `SELECT id,type,symbol,network,amount,fee,status,tx_hash,to_address,note,created_at,completed_at
       FROM transactions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      params
    );
    res.json({ transactions: result.rows, total: parseInt(totalRes.rows[0].count) });
  } catch (err) { next(err); }
});

// ── SINGLE TRANSACTION ────────────────────────
router.get('/transaction/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM transactions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction not found.' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── WITHDRAWAL ADDRESS BOOK ───────────────────
router.get('/withdrawal-addresses', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id,label,symbol,network,address,whitelisted,created_at FROM withdrawal_addresses WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ addresses: result.rows });
  } catch (err) { next(err); }
});

router.post('/withdrawal-addresses', async (req, res, next) => {
  try {
    const { label, symbol, network, address } = req.body;
    if (!symbol || !address) return res.status(400).json({ error: 'symbol and address are required.' });
    const result = await query(
      'INSERT INTO withdrawal_addresses (user_id,label,symbol,network,address,whitelisted) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING *',
      [req.user.id, label || 'My Wallet', symbol.toUpperCase(), network || '', address]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/withdrawal-addresses/:id', async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM withdrawal_addresses WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Address not found.' });
    res.json({ message: 'Address removed.' });
  } catch (err) { next(err); }
});

module.exports = router;
