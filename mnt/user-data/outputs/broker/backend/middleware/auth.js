/**
 * Authentication & Authorization Middleware
 */
'use strict';
const jwt    = require('jsonwebtoken');
const { redis } = require('../services/redis');
const { query } = require('../models/db');

// Verify JWT and attach req.user
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const token = header.split(' ')[1];

    // Check blacklist
    const blacklisted = await redis.get(`blacklist:${token}`);
    if (blacklisted) return res.status(401).json({ error: 'Token has been revoked.' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type === 'pre_auth') return res.status(401).json({ error: '2FA verification required.' });

    // Lightweight user attach (avoid DB hit on every request)
    req.user = { id: payload.sub, email: payload.email, kycLevel: payload.kycLevel, role: payload.role || 'user' };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Session expired. Please log in again.' });
    if (err.name === 'JsonWebTokenError')  return res.status(401).json({ error: 'Invalid authentication token.' });
    next(err);
  }
}

// Require admin role
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Require minimum KYC level
function requireKYC(minLevel) {
  return async (req, res, next) => {
    if (req.user.kycLevel < minLevel) {
      return res.status(403).json({
        error: `KYC Level ${minLevel} required.`,
        currentLevel: req.user.kycLevel,
        action: 'Please complete identity verification at /api/kyc',
      });
    }
    next();
  };
}

// Validate API key (for /api/* endpoints accessed programmatically)
async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return next(); // fall through to JWT auth
  try {
    const hash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
    const result = await query(`
      SELECT ak.*, u.id as uid, u.email, u.kyc_level, u.status
      FROM api_keys ak JOIN users u ON u.id = ak.user_id
      WHERE ak.key_hash = $1 AND ak.status = 'active'
        AND (ak.expires_at IS NULL OR ak.expires_at > NOW())
    `, [hash]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid API key.' });
    const key = result.rows[0];

    // IP whitelist check
    if (key.ip_whitelist?.length) {
      const clientIP = req.ip;
      if (!key.ip_whitelist.includes(clientIP)) {
        return res.status(403).json({ error: 'API key not permitted from this IP.' });
      }
    }

    // Permission check (injected per route)
    req.user        = { id: key.uid, email: key.email, kycLevel: key.kyc_level, role: 'user' };
    req.apiKey      = { id: key.id, permissions: key.permissions };
    req.isApiKeyAuth = true;

    // Update last used
    await query('UPDATE api_keys SET last_used_at = NOW(), last_used_ip = $1 WHERE id = $2', [req.ip, key.id]);
    next();
  } catch (err) { next(err); }
}

function requireApiPermission(perm) {
  return (req, res, next) => {
    if (req.isApiKeyAuth && !req.apiKey.permissions.includes(perm)) {
      return res.status(403).json({ error: `API key missing permission: ${perm}` });
    }
    next();
  };
}

module.exports = { authenticate, requireAdmin, requireKYC, apiKeyAuth, requireApiPermission };
