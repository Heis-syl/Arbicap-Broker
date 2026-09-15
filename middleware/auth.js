'use strict';
const jwt = require('jsonwebtoken');
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided.' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    // JWT payload uses `sub` for the user id (see generateToken in routes/auth.js);
    // normalize it to `id` since every route handler reads req.user.id.
    req.user = { ...decoded, id: decoded.sub };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}
function requireKYC(level) {
  return (req, res, next) => {
    if ((req.user?.kycLevel || 0) < level)
      return res.status(403).json({ error: `KYC Level ${level} required.` });
    next();
  };
}
module.exports = { authenticate, requireAdmin, requireKYC };
