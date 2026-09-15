/**
 * Auth Routes
 * POST /api/auth/register
 * POST /api/auth/login
 * POST /api/auth/verify-email
 * POST /api/auth/resend-verification
 * POST /api/auth/forgot-password
 * POST /api/auth/reset-password
 * POST /api/auth/2fa/setup
 * POST /api/auth/2fa/verify
 * POST /api/auth/2fa/disable
 * POST /api/auth/refresh
 * POST /api/auth/logout
 */

'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../models/db');
const { redis }  = require('../services/redis');
const { sendEmail } = require('../services/email');
const { authenticate } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { logger } = require('../services/logger');

const SALT_ROUNDS  = 12;
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN  || '7d';
const JWT_SECRET   = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET;
const APP_NAME     = process.env.APP_NAME || 'Arbicap';

// ── HELPERS ───────────────────────────────────
function generateToken(user, expiresIn = JWT_EXPIRES) {
  return jwt.sign(
    { sub: user.id, email: user.email, kycLevel: user.kyc_level, role: user.role || 'user' },
    JWT_SECRET,
    { expiresIn }
  );
}

function generateRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' }, REFRESH_SECRET, { expiresIn: '30d' });
}

function generateReferralCode() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

async function getLoginAttempts(ip) {
  const key = `login_attempts:${ip}`;
  const val = await redis.get(key);
  return parseInt(val || '0');
}

async function incrementLoginAttempts(ip) {
  const key = `login_attempts:${ip}`;
  await redis.incr(key);
  await redis.expire(key, 30 * 60); // 30 min window
}

async function clearLoginAttempts(ip) {
  await redis.del(`login_attempts:${ip}`);
}

// ── REGISTER ──────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, firstName, lastName, phone, country,
            accountType, referralCode } = req.body;

    // Validation
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Required fields: email, password, firstName, lastName' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check platform settings

    // Check duplicate email
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Resolve referral
    let referredBy = null;
    if (referralCode) {
      const ref = await query('SELECT id FROM users WHERE referral_code = $1', [referralCode.toUpperCase()]);
      if (ref.rows.length) referredBy = ref.rows[0].id;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const myReferralCode = generateReferralCode();

    const result = await query(`
      INSERT INTO users (email, password_hash, first_name, last_name, phone, country,
                         account_type, referral_code, referred_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, email, first_name, last_name, kyc_level, status, created_at
    `, [
      email.toLowerCase(), passwordHash, firstName, lastName,
      phone || null, country || null,
      accountType || 'individual', myReferralCode, referredBy,
    ]);

    const user = result.rows[0];

    // Create USDT wallet by default
    await query(
      'INSERT INTO wallets (user_id, symbol, total_balance, locked_balance) VALUES ($1,$2,0,0) ON CONFLICT DO NOTHING',
      [user.id, 'USDT']
    );

    // Send verification email
    const verifyToken = uuidv4();
    await query(`
      INSERT INTO email_verifications (user_id, token, type, expires_at)
      VALUES ($1, $2, 'email_verify', NOW() + INTERVAL '24 hours')
    `, [user.id, verifyToken]);

    await sendEmail({
      to: email,
      subject: `Verify your ${APP_NAME} account`,
      template: 'email-verify',
      data: {
        name: firstName,
        link: `${process.env.FRONTEND_URL}/verify-email.html?token=${verifyToken}`,
        appName: APP_NAME,
      },
    });

    await auditLog({ userId: user.id, action: 'user_registered', ip: req.ip });

    logger.info(`New user registered: ${email}`);
    res.status(201).json({
      message: 'Account created. Please check your email to verify your account.',
      userId: user.id,
    });
  } catch (err) { next(err); }
});

// ── LOGIN ─────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, rememberMe } = req.body;
    const ip = req.ip;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Brute force protection
    const attempts = await getLoginAttempts(ip);
    if (attempts >= 10) {
      return res.status(429).json({ error: 'Too many login attempts. Please wait 30 minutes.' });
    }

    const result = await query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      await incrementLoginAttempts(ip);
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    if (user.status === 'banned') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
    }

    await clearLoginAttempts(ip);

    // 2FA required
    if (user.two_fa_enabled) {
      // Issue a short-lived pre-auth token
      const preAuthToken = jwt.sign({ sub: user.id, type: 'pre_auth' }, JWT_SECRET, { expiresIn: '5m' });
      return res.json({ requires2FA: true, preAuthToken });
    }

    // Full login
    const token        = generateToken(user, rememberMe ? '30d' : JWT_EXPIRES);
    const refreshToken = generateRefreshToken(user.id);

    // Save session
    const sessionId = uuidv4();
    await query(`
      INSERT INTO sessions (id, user_id, token_hash, device_info, ip_address, expires_at)
      VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '${rememberMe ? '30' : '7'} days')
    `, [sessionId, user.id, require('crypto').createHash('sha256').update(token).digest('hex'),
        req.headers['user-agent'], ip]);

    // Update last login
    await query('UPDATE users SET last_login_at = NOW(), last_login_ip = $1 WHERE id = $2', [ip, user.id]);
    await auditLog({ userId: user.id, action: 'user_login', ip });

    res.json({
      token, refreshToken,
      user: {
        id: user.id, email: user.email,
        firstName: user.first_name, lastName: user.last_name,
        kycLevel: user.kyc_level, kycStatus: user.kyc_status,
        twoFaEnabled: user.two_fa_enabled,
        role: user.role || 'user',
      },
    });
  } catch (err) { next(err); }
});

// ── 2FA VERIFY (complete login) ───────────────
router.post('/2fa/verify', async (req, res, next) => {
  try {
    const { preAuthToken, code } = req.body;
    if (!preAuthToken || !code) {
      return res.status(400).json({ error: 'preAuthToken and code are required.' });
    }

    let payload;
    try { payload = jwt.verify(preAuthToken, JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Pre-auth token expired. Please log in again.' }); }

    if (payload.type !== 'pre_auth') {
      return res.status(401).json({ error: 'Invalid token type.' });
    }

    const result = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const valid = speakeasy.totp.verify({
      secret:   user.two_fa_secret,
      encoding: 'base32',
      token:    code.replace(/\s/g, ''),
      window:   1,
    });

    if (!valid) {
      return res.status(401).json({ error: 'Invalid 2FA code. Please try again.' });
    }

    const token        = generateToken(user);
    const refreshToken = generateRefreshToken(user.id);

    await query('UPDATE users SET last_login_at = NOW(), last_login_ip = $1 WHERE id = $2', [req.ip, user.id]);
    await auditLog({ userId: user.id, action: 'user_2fa_login', ip: req.ip });

    res.json({
      token, refreshToken,
      user: {
        id: user.id, email: user.email,
        firstName: user.first_name, lastName: user.last_name,
        kycLevel: user.kyc_level, kycStatus: user.kyc_status,
        role: user.role || 'user',
      },
    });
  } catch (err) { next(err); }
});

// ── 2FA SETUP ─────────────────────────────────
router.post('/2fa/setup', authenticate, async (req, res, next) => {
  try {
    const user = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const u    = user.rows[0];
    if (u.two_fa_enabled) {
      return res.status(400).json({ error: '2FA is already enabled on this account.' });
    }

    const secret = speakeasy.generateSecret({ name: `${APP_NAME} (${u.email})`, length: 32 });
    // Temporarily store secret in Redis until confirmed
    await redis.setex(`2fa_setup:${u.id}`, 600, secret.base32); // 10 min TTL

    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
    res.json({
      secret:    secret.base32,
      qrCode:    qrDataUrl,
      manualKey: secret.base32,
    });
  } catch (err) { next(err); }
});

// ── 2FA CONFIRM (save after setup) ───────────
router.post('/2fa/confirm', authenticate, async (req, res, next) => {
  try {
    const { code } = req.body;
    const secret   = await redis.get(`2fa_setup:${req.user.id}`);
    if (!secret) return res.status(400).json({ error: '2FA setup session expired. Please start again.' });

    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(400).json({ error: 'Invalid code. Please try again.' });

    await query('UPDATE users SET two_fa_secret = $1, two_fa_enabled = TRUE WHERE id = $2',
      [secret, req.user.id]);
    await redis.del(`2fa_setup:${req.user.id}`);
    await auditLog({ userId: req.user.id, action: '2fa_enabled', ip: req.ip });

    res.json({ message: '2FA has been enabled on your account.' });
  } catch (err) { next(err); }
});

// ── 2FA DISABLE ───────────────────────────────
router.post('/2fa/disable', authenticate, async (req, res, next) => {
  try {
    const { code, password } = req.body;
    const result = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user   = result.rows[0];

    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    const valid = speakeasy.totp.verify({ secret: user.two_fa_secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(400).json({ error: 'Invalid 2FA code.' });

    await query('UPDATE users SET two_fa_secret = NULL, two_fa_enabled = FALSE WHERE id = $1', [user.id]);
    await auditLog({ userId: user.id, action: '2fa_disabled', ip: req.ip });
    res.json({ message: '2FA has been disabled.' });
  } catch (err) { next(err); }
});

// ── EMAIL VERIFY ──────────────────────────────
router.post('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.body;
    const result = await query(`
      SELECT ev.*, u.id as uid FROM email_verifications ev
      JOIN users u ON u.id = ev.user_id
      WHERE ev.token = $1 AND ev.type = 'email_verify' AND ev.used_at IS NULL AND ev.expires_at > NOW()
    `, [token]);

    if (!result.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired verification link.' });
    }
    const ev = result.rows[0];
    await query('UPDATE users SET email_verified = TRUE, kyc_level = GREATEST(kyc_level, 1) WHERE id = $1', [ev.user_id]);
    await query('UPDATE email_verifications SET used_at = NOW() WHERE id = $1', [ev.id]);
    res.json({ message: 'Email verified successfully. You can now log in.' });
  } catch (err) { next(err); }
});

// ── FORGOT PASSWORD ───────────────────────────
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    const result = await query('SELECT id, first_name FROM users WHERE email = $1', [email?.toLowerCase()]);
    // Always respond OK to avoid email enumeration
    if (result.rows.length) {
      const user  = result.rows[0];
      const token = uuidv4();
      await query(`
        INSERT INTO email_verifications (user_id, token, type, expires_at)
        VALUES ($1, $2, 'password_reset', NOW() + INTERVAL '1 hour')
      `, [user.id, token]);
      await sendEmail({
        to: email,
        subject: `Reset your ${APP_NAME} password`,
        template: 'password-reset',
        data: {
          name: user.first_name,
          link: `${process.env.FRONTEND_URL}/reset-password.html?token=${token}`,
          appName: APP_NAME,
        },
      });
    }
    res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
  } catch (err) { next(err); }
});

// ── RESET PASSWORD ────────────────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 8) {
      return res.status(400).json({ error: 'Valid token and password (min 8 chars) required.' });
    }

    const result = await query(`
      SELECT ev.*, u.id as uid FROM email_verifications ev
      WHERE ev.token = $1 AND ev.type = 'password_reset' AND ev.used_at IS NULL AND ev.expires_at > NOW()
    `, [token]);

    if (!result.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    const ev   = result.rows[0];
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, ev.user_id]);
    await query('UPDATE email_verifications SET used_at = NOW() WHERE id = $1', [ev.id]);
    // Invalidate all sessions
    await query('DELETE FROM sessions WHERE user_id = $1', [ev.user_id]);
    await auditLog({ userId: ev.user_id, action: 'password_reset', ip: req.ip });

    res.json({ message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) { next(err); }
});

// ── REFRESH TOKEN ─────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required.' });

    let payload;
    try { payload = jwt.verify(refreshToken, REFRESH_SECRET); }
    catch { return res.status(401).json({ error: 'Invalid or expired refresh token.' }); }

    const result = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    const user   = result.rows[0];
    if (!user || user.status === 'banned') {
      return res.status(403).json({ error: 'Account not accessible.' });
    }

    const newToken        = generateToken(user);
    const newRefreshToken = generateRefreshToken(user.id);
    res.json({ token: newToken, refreshToken: newRefreshToken });
  } catch (err) { next(err); }
});

// ── LOGOUT ────────────────────────────────────
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    // Blacklist current token in Redis until it expires
    const token   = req.headers.authorization?.split(' ')[1];
    if (token) {
      const decoded = jwt.decode(token);
      const ttl     = decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 3600;
      if (ttl > 0) await redis.setex(`blacklist:${token}`, ttl, '1');
    }
    await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash = $2',
      [req.user.id, require('crypto').createHash('sha256').update(token).digest('hex')]);
    res.json({ message: 'Logged out successfully.' });
  } catch (err) { next(err); }
});

module.exports = router;
