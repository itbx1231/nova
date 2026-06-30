const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const generated = crypto.randomBytes(48).toString('hex');
  try {
    const envPath = path.join(__dirname, '..', '.env');
    fs.appendFileSync(envPath, `\nJWT_SECRET=${generated}\n`);
    console.log('✅ Generated new JWT_SECRET and saved to .env');
  } catch (err) {
    console.error('⚠️ Could not save JWT_SECRET to .env. Sessions will not persist across restarts.');
  }
  return generated;
})();

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const verifyAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).json({ error: 'Forbidden: Requires Administrator Privileges' });
};

module.exports = { authMiddleware, verifyAdmin, JWT_SECRET };
