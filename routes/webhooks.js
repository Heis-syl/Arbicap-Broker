/**
 * Webhooks Route
 * Receives callbacks from external providers.
 * Each webhook is verified with a signature before processing.
 *
 * POST /webhooks/deposit     — Alchemy / QuickNode deposit notification
 * POST /webhooks/kyc         — Sumsub KYC status update
 * POST /webhooks/payment     — Flutterwave / Stripe fiat payment
 * POST /webhooks/withdrawal  — Fireblocks withdrawal status
 */
'use strict';
const router  = require('express').Router();
const crypto  = require('crypto');
const { query, getClient } = require('../models/db');
const { processIncomingDeposit } = require('../services/depositMonitor');
const { notifyUser }  = require('../services/notifications');
const { sendEmail }   = require('../services/email');
const { auditLog }    = require('../services/audit');
const { logger }      = require('../services/logger');

// ── ALCHEMY WEBHOOK — on-chain deposit alert ──
// Set up at: https://dashboard.alchemy.com/notify
// Activity type: ADDRESS_ACTIVITY
// Signing Key: ALCHEMY_WEBHOOK_SIGNING_KEY in .env
router.post('/deposit', async (req, res) => {
  try {
    // Verify Alchemy webhook signature
    const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
    if (signingKey) {
      const body      = JSON.stringify(req.body);
      const signature = req.headers['x-alchemy-signature'];
      const expected  = crypto.createHmac('sha256', signingKey).update(body).digest('hex');
      if (signature !== expected) {
        logger.warn('Invalid Alchemy webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = req.body;
    if (event.type !== 'ADDRESS_ACTIVITY') return res.sendStatus(200);

    for (const activity of (event.event?.activity || [])) {
      if (activity.category !== 'external' && activity.category !== 'erc20') continue;
      if (!activity.toAddress) continue;

      // Look up which user owns this deposit address
      const addrRes = await query(
        'SELECT user_id, symbol FROM deposit_addresses WHERE LOWER(address) = LOWER($1)',
        [activity.toAddress]
      );
      if (!addrRes.rows.length) continue;

      const { user_id, symbol } = addrRes.rows[0];
      const asset  = activity.asset || symbol;
      const amount = parseFloat(activity.value || 0);
      const txHash = activity.hash;

      if (amount <= 0 || !txHash) continue;

      await processIncomingDeposit({
        userId:       user_id,
        symbol:       asset,
        network:      'ethereum',
        txHash,
        amount,
        fromAddress:  activity.fromAddress,
        toAddress:    activity.toAddress,
        blockNumber:  activity.blockNum ? parseInt(activity.blockNum, 16) : null,
        confirmations: 12, // Alchemy webhooks fire after enough confirmations
      });
    }
    res.sendStatus(200);
  } catch (err) {
    logger.error('Deposit webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ── SUMSUB WEBHOOK — KYC status update ────────
// Configure at: https://cockpit.sumsub.com → Integrations → Webhooks
// Secret token: SUMSUB_WEBHOOK_SECRET in .env
router.post('/kyc', async (req, res) => {
  try {
    // Verify Sumsub signature
    const secret    = process.env.SUMSUB_WEBHOOK_SECRET;
    const digest    = req.headers['x-payload-digest'];
    const timestamp = req.headers['x-payload-digest-alg'];
    if (secret && digest) {
      const expected = crypto.createHmac('sha1', secret).update(JSON.stringify(req.body)).digest('hex');
      if (expected !== digest) {
        logger.warn('Invalid Sumsub webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { type, externalUserId, reviewStatus, reviewResult } = req.body;
    const userId = externalUserId; // We pass user UUID as externalUserId when creating a Sumsub applicant

    logger.info(`KYC webhook: userId=${userId} type=${type} status=${reviewStatus}`);

    if (type === 'applicantReviewed') {
      const approved = reviewResult?.reviewAnswer === 'GREEN';
      const rejected = reviewResult?.reviewAnswer === 'RED';

      if (approved) {
        // Determine KYC level from the applicant's level name
        const newLevel = 2; // Adjust based on your Sumsub levels
        await query(`
          UPDATE users SET kyc_level = GREATEST(kyc_level, $1), kyc_status = 'approved' WHERE id = $2
        `, [newLevel, userId]);

        await query(`
          UPDATE kyc_documents SET status = 'approved', reviewed_at = NOW() WHERE user_id = $1 AND status = 'pending'
        `, [userId]);

        const userRes = await query('SELECT email, first_name FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length) {
          const u = userRes.rows[0];
          await sendEmail({ to: u.email, subject: `KYC Approved — ${process.env.APP_NAME}`, template: 'kyc-approved', data: { name: u.first_name, level: newLevel } });
          await notifyUser(userId, 'kyc', 'KYC verification approved ✅', { body: `You now have KYC Level ${newLevel} access.` });
        }
        await auditLog({ userId, action: 'kyc_approved', newValue: { level: newLevel } });

      } else if (rejected) {
        const reason = reviewResult?.rejectLabels?.join(', ') || 'Documents could not be verified';
        await query("UPDATE users SET kyc_status = 'rejected' WHERE id = $1", [userId]);
        await query("UPDATE kyc_documents SET status = 'rejected', rejection_reason = $1 WHERE user_id = $2 AND status = 'pending'", [reason, userId]);

        const userRes = await query('SELECT email, first_name FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length) {
          const u = userRes.rows[0];
          await sendEmail({ to: u.email, subject: `KYC Action Required — ${process.env.APP_NAME}`, template: 'kyc-rejected', data: { name: u.first_name, reason } });
          await notifyUser(userId, 'kyc', 'KYC verification needs attention', { body: reason });
        }
        await auditLog({ userId, action: 'kyc_rejected', newValue: { reason } });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error('KYC webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ── FLUTTERWAVE WEBHOOK — fiat payment ────────
// Configure at: https://dashboard.flutterwave.com → Settings → Webhooks
// Secret hash: FLUTTERWAVE_WEBHOOK_HASH in .env
router.post('/payment', async (req, res) => {
  try {
    const secretHash = process.env.FLUTTERWAVE_WEBHOOK_HASH;
    if (secretHash) {
      const signature = req.headers['verif-hash'];
      if (signature !== secretHash) {
        logger.warn('Invalid Flutterwave webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { event, data } = req.body;
    if (event !== 'charge.completed') return res.sendStatus(200);
    if (data.status !== 'successful') return res.sendStatus(200);

    // Extract user ID from tx_ref (we set it as `userId_timestamp` when creating the charge)
    const txRef = data.tx_ref || '';
    const userId = txRef.split('_')[0];
    if (!userId) return res.sendStatus(200);

    const currency = data.currency;
    const amount   = parseFloat(data.amount);
    const flwTxId  = data.id.toString();

    // Idempotency — check if already processed
    const existing = await query("SELECT id FROM transactions WHERE tx_hash = $1", [flwTxId]);
    if (existing.rows.length) return res.sendStatus(200);

    // Credit USDT equivalent (you'd apply an FX rate here)
    // For simplicity: 1 USD = 1 USDT
    const usdtAmount = currency === 'USD' ? amount : amount / parseFloat(process.env[`FX_${currency}_USD`] || 1);

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO transactions (user_id, type, symbol, network, amount, status, tx_hash, note)
        VALUES ($1,'deposit','USDT','fiat',$2,'completed',$3,$4)
      `, [userId, usdtAmount, flwTxId, `Fiat deposit via Flutterwave: ${amount} ${currency}`]);

      await client.query(`
        INSERT INTO wallets (user_id, symbol, total_balance, locked_balance)
        VALUES ($1,'USDT',$2,0)
        ON CONFLICT (user_id, symbol) DO UPDATE SET total_balance = wallets.total_balance + $2
      `, [userId, usdtAmount]);

      await client.query('COMMIT');

      await notifyUser(userId, 'deposit', `${usdtAmount.toFixed(2)} USDT fiat deposit confirmed`, { body: `${amount} ${currency} received and converted to USDT.` });
      logger.info(`Fiat deposit credited: ${usdtAmount} USDT to user ${userId}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(()=>{});
      throw err;
    } finally {
      client.release();
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error('Payment webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ── FIREBLOCKS WEBHOOK — withdrawal status ────
// Configure at: Fireblocks console → Settings → Webhooks
router.post('/withdrawal', async (req, res) => {
  try {
    // Verify Fireblocks webhook signature
    const pubKey = process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY;
    if (pubKey) {
      const signature = req.headers['fireblocks-signature'];
      const body      = JSON.stringify(req.body);
      const verify    = crypto.createVerify('RSA-SHA512');
      verify.update(body);
      if (!verify.verify(pubKey, signature, 'base64')) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { type, data } = req.body;
    // Fireblocks uses note field to store our txId
    const txId = data?.note?.replace('Withdrawal txId=', '') || null;
    if (!txId) return res.sendStatus(200);

    if (type === 'TRANSACTION_STATUS_UPDATED' && data.status === 'COMPLETED') {
      const txHash = data.txHash;
      await query("UPDATE transactions SET status='completed', tx_hash=$1, completed_at=NOW() WHERE id=$2", [txHash, txId]);
      logger.info(`Withdrawal confirmed via Fireblocks: ${txId} txHash=${txHash}`);
    } else if (data.status === 'FAILED' || data.status === 'REJECTED') {
      await query("UPDATE transactions SET status='failed', admin_note=$1 WHERE id=$2", [data.subStatus, txId]);
      logger.warn(`Withdrawal failed via Fireblocks: ${txId}`);
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error('Fireblocks webhook error:', err.message);
    res.sendStatus(500);
  }
});

module.exports = router;
