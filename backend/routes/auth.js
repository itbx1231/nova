const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { authMiddleware, verifyAdmin, JWT_SECRET } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password, remember } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    const user = await db.getUser(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    await db.updateLastLogin(user.id);
    
    // Determine token expiration based on "Remember Me" toggle
    const expiresIn = remember ? '30d' : '24h';
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn });
    
    db.logEvent('hub', 'auth', `User '${username}' logged in via UI`);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// GET /api/auth/verify
router.get('/verify', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(401).json({ valid: false });
    // Sanitize user before sending back
    res.json({ valid: true, user: { id: user.id, username: user.username, role: user.role } });
  } catch { 
    res.status(401).json({ valid: false }); 
  }
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, (req, res) => {
  db.logEvent('hub', 'auth', `User '${req.user.username}' logged out`);
  res.json({ success: true });
});

// POST /api/auth/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await db.getUser(req.user.username);
    
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password incorrect' });
    
    const hash = await bcrypt.hash(newPassword, 12);
    await db.pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, user.id]);
    
    db.logEvent('hub', 'auth', `User '${req.user.username}' changed password`);
    res.json({ success: true });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

router.get('/api/auth/users', authMiddleware, verifyAdmin, async (req, res) => {
  try { res.json(await db.getUsers()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/auth/users', authMiddleware, verifyAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const existing = await db.getUser(username);
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hash = await bcrypt.hash(password, 12);
    await db.createUser(username, hash, role || 'viewer');
    db.logEvent('hub', 'auth', `Admin created new user '${username}'`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/auth/users/:id/role', authMiddleware, verifyAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    // Prevent self-demotion
    if (parseInt(req.params.id) === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot demote yourself' });
    }
    await db.updateUserRole(req.params.id, role);
    db.logEvent('hub', 'auth', `Admin updated role to '${role}' for user ID ${req.params.id}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/auth/users/:id', authMiddleware, verifyAdmin, async (req, res) => {
  try {
    // Prevent self-deletion
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    await db.deleteUser(req.params.id);
    db.logEvent('hub', 'auth', `Admin deleted user ID ${req.params.id}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;
