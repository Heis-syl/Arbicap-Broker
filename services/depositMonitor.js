/**
 * Deposit Monitor — Company Wallet / Auto-Credit Model
 *
 * Flow:
 *   1. User deposits to the company wallet address
 *   2. User submits their tx hash + amount via the platform
 *   3. Balance is credited to their dashboard IMMEDIATELY
 *   4. A record appears in admin for your financial team's reference
 *   5. Your team invests the actual funds — user balances are internal ledger entries
 *
 * Rules:
 *   - No deposit minimum
 *   - No KYC required to deposit
 *   - No daily deposit limit
 *   - Auto-credited on submission (no admin approval needed for deposits)
 *   - Withdrawals require KYC and admin approval (on hold until launch)
 */
'use strict';
const cron   = require('node-cron');
const { query, getClient } = require('../models/db');
const { redis }     = require('./redis');
const { sendEmail } = require('./email');
const { notifyUser }= require('./notifications');
const { auditLog }  = require('./audit');
const { logger }    = require('./logger');

function startDepositMonitor() {
  // Daily cleanup
  cron.schedule('0 2 * * *', async () => {
    try {
      await query('DELETE FROM sessions WHERE expires_at < NOW()');
      await query("DELETE FROM email_verifications WHERE expires_at < NOW() AND used_at IS NULL");
      logger.info('Daily cleanup completed');
    } catch (err) { logger.error('Cleanup error:', err.message); }
  });

  // Process withdrawal queue every 5 minutes (disabled until WITHDRAWALS_LIVE=true)
  cron.schedule('*/5 * * * *', async () => {
    try { await processWithdrawalQueue(); }
    catch (err) { logger.error('Withdrawal queue error:', err.message); }
  });

  logger.info('Deposit monitor started (auto-credit mode — no approval required)');
}

// ── AUTO-CREDIT DEPOSIT ───────────────────────
// Called immediately when user submits their tx hash.
// No minimum, no KYC, no approval needed.
async function submitDeposit({ userId, symbol, network, txHash, amount }) {
  if (!txHash || !txHash.trim()) throw new Error('Transaction hash is required.');
  if (!amount || parseFloat(amount) <= 0) throw new Error('Amount must be greater than zero.');

  const amt = parseFloat(amount);

  // Prevent duplicate tx hash submissions
  const existing = await query(
    'SELECT id, status FROM transactions WHERE tx_hash = $1',
    [txHash.trim()]
  );
  if (existing.rows.length) {
    if (existing.rows[0].status === 'completed') throw new Error('This transaction has already been credited.');
    throw new Error('This transaction hash has already been submitted. Contact support if you have an issue.');
  }

  // Create a pending_review record. Balance is NOT credited yet — an admin
  // must verify the tx on a block explorer and approve it (see approveDeposit below).
  const txResult = await query(`
    INSERT INTO transactions
      (user_id, type, symbol, network, amount, fee, status, tx_hash, note)
    VALUES ($1, 'deposit', $2, $3, $4, 0, 'pending_review', $5,
            'Awaiting admin verification against block explorer')
    RETURNING id
  `, [userId, symbol, network, amt, txHash.trim()]);

  const txId = txResult.rows[0].id;

  await notifyUser(userId, 'deposit',
    `${amt} ${symbol} deposit received — pending review`,
    { body: 'We\'ll notify you once it\'s verified and credited to your balance.', link: '/wallet.html' }
  );
  await auditLog({ userId, action: 'deposit_submitted', entityType: 'transaction', entityId: txId,
    newValue: { symbol, amount: amt, txHash: txHash.trim() } });
  logger.info(`Deposit submitted, awaiting admin review: ${txId} — ${amt} ${symbol} for user ${userId}`);
  return { txId, amount: amt, symbol, status: 'pending_review' };
}

// ── APPROVE DEPOSIT (admin action) ────────────
// Called from adminRouter POST /deposits/:id/approve, only after a human
// has verified the tx hash on a block explorer. This is where the balance
// actually gets credited.
async function approveDeposit({ txId, adminId }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      "SELECT * FROM transactions WHERE id=$1 AND type='deposit' AND status='pending_review' FOR UPDATE",
      [txId]
    );
    if (!txResult.rows.length) throw new Error('Deposit not found or already processed.');
    const tx = txResult.rows[0];

    await client.query(`
      INSERT INTO wallets (user_id, symbol, total_balance, locked_balance)
      VALUES ($1, $2, $3, 0)
      ON CONFLICT (user_id, symbol)
      DO UPDATE SET total_balance = wallets.total_balance + $3, updated_at = NOW()
    `, [tx.user_id, tx.symbol, parseFloat(tx.amount)]);

    await client.query(`
      UPDATE transactions
      SET status='completed', completed_at=NOW(), reviewed_by=$1
      WHERE id=$2
    `, [adminId, txId]);

    await client.query('COMMIT');

    const userRes = await query('SELECT email, first_name FROM users WHERE id = $1', [tx.user_id]);
    if (userRes.rows.length) {
      const u = userRes.rows[0];
      await sendEmail({
        to: u.email,
        subject: `Deposit approved — ${tx.amount} ${tx.symbol}`,
        template: 'deposit-confirmed',
        data: { name: u.first_name, amount: tx.amount, symbol: tx.symbol, confirmations: 1 },
      });
    }

    await notifyUser(tx.user_id, 'deposit',
      `${tx.amount} ${tx.symbol} deposit approved`,
      { body: 'Your balance has been updated.', link: '/dashboard.html' }
    );
    await auditLog({ adminId, action: 'deposit_approved', entityType: 'transaction', entityId: txId,
      newValue: { userId: tx.user_id, symbol: tx.symbol, amount: tx.amount } });
    logger.info(`Deposit approved by admin ${adminId}: ${txId} — ${tx.amount} ${tx.symbol} for user ${tx.user_id}`);

    return { txId, amount: tx.amount, symbol: tx.symbol, status: 'completed' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── REJECT DEPOSIT (admin action) ─────────────
async function rejectDeposit({ txId, adminId, reason }) {
  const txResult = await query(
    "SELECT * FROM transactions WHERE id=$1 AND type='deposit' AND status='pending_review'",
    [txId]
  );
  if (!txResult.rows.length) throw new Error('Deposit not found or already processed.');
  const tx = txResult.rows[0];

  await query(`
    UPDATE transactions
    SET status='rejected', reviewed_by=$1, admin_note=$2
    WHERE id=$3
  `, [adminId, reason || 'Rejected by admin — could not verify transaction.', txId]);

  await notifyUser(tx.user_id, 'deposit',
    `Deposit of ${tx.amount} ${tx.symbol} was rejected`,
    { body: reason || 'Please contact support for details.', link: '/wallet.html' }
  );
  await auditLog({ adminId, action: 'deposit_rejected', entityType: 'transaction', entityId: txId,
    newValue: { reason } });
  logger.info(`Deposit rejected by admin ${adminId}: ${txId} — ${reason || 'no reason given'}`);

  return { txId, status: 'rejected' };
}

// ── WITHDRAWAL PROCESSOR ──────────────────────
// Disabled until WITHDRAWALS_LIVE=true in .env
async function processWithdrawalQueue() {
  const live = process.env.WITHDRAWALS_LIVE === 'true';
  if (!live) return;

  const { broadcastWithdrawal } = require('./custody');

  for (let i = 0; i < 10; i++) {
    const raw = await redis.lpop('withdrawal_queue');
    if (!raw) break;

    let job;
    try { job = JSON.parse(raw); } catch { continue; }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE transactions SET status='processing' WHERE id=$1", [job.txId]);

      const result = await broadcastWithdrawal({
        txId: job.txId, symbol: job.symbol,
        network: job.network, toAddress: job.address, amount: job.amount,
      });

      await client.query(`
        UPDATE transactions SET status='completed', tx_hash=$1, completed_at=NOW() WHERE id=$2
      `, [result.txHash, job.txId]);

      await client.query(`
        UPDATE wallets
        SET total_balance  = total_balance  - $1,
            locked_balance = GREATEST(0, locked_balance - $1)
        WHERE user_id=$2 AND symbol=$3
      `, [job.amount + (job.fee || 0), job.userId, job.symbol]);

      await client.query('COMMIT');
      await notifyUser(job.userId, 'withdrawal', `${job.amount} ${job.symbol} withdrawal sent`);
      logger.info(`Withdrawal processed: ${job.txId}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      await redis.rpush('withdrawal_queue_failed', raw);
      await query("UPDATE transactions SET status='pending_review', admin_note=$1 WHERE id=$2",
        [err.message, job.txId]);
      logger.error(`Withdrawal failed: ${job.txId} — ${err.message}`);
    } finally {
      client.release();
    }
  }
}

module.exports = { startDepositMonitor, submitDeposit, approveDeposit, rejectDeposit };
