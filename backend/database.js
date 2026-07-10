const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://nova:nova_password@127.0.0.1:5432/nova_telemetry'
});

// Initialize Tables
const initDB = async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      hostId TEXT,
      cpu REAL,
      mem REAL,
      rx REAL,
      tx REAL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      hostId TEXT,
      type TEXT,
      message TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY,
      type TEXT,
      url TEXT,
      token TEXT,
      chatId TEXT,
      enabled INTEGER DEFAULT 1
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS rules (
      id SERIAL PRIMARY KEY,
      name TEXT,
      hostId TEXT,
      metric TEXT,
      threshold REAL,
      action TEXT,
      enabled INTEGER DEFAULT 1
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ssh_hosts (
      host TEXT PRIMARY KEY,
      name TEXT,
      "user" TEXT,
      pass TEXT,
      port INTEGER,
      remotePath TEXT,
      hubIp TEXT,
      lastConnected TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER,
      username TEXT,
      password TEXT,
      database_name TEXT,
      connection_string TEXT,
      status TEXT DEFAULT 'unknown',
      latency INTEGER DEFAULT 0,
      last_checked TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS service_stats (
      id SERIAL PRIMARY KEY,
      service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
      stat_key TEXT,
      stat_value REAL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS alert_log (
      id SERIAL PRIMARY KEY,
      service_id INTEGER,
      service_name TEXT,
      service_type TEXT,
      severity TEXT DEFAULT 'warning',
      message TEXT,
      channel TEXT,
      status TEXT DEFAULT 'sent',
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS scan_reports (
        id         BIGSERIAL PRIMARY KEY,
        file       TEXT UNIQUE,
        host_id    TEXT,
        ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
        mode       TEXT,
        score      INT,
        health     TEXT,
        critical   INT DEFAULT 0,
        warnings   INT DEFAULT 0,
        subsystems JSONB,
        raw        JSONB
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_reports_host_ts ON scan_reports(host_id, ts DESC)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS disk_analytics (
      id SERIAL PRIMARY KEY,
      hostId TEXT,
      diskName TEXT,
      healthStatus TEXT,
      temperature INTEGER,
      reallocated INTEGER,
      uncorrectable INTEGER,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    console.log('[PostgreSQL] Database tables initialized successfully.');
  } catch (err) {
    console.error('[PostgreSQL] Initialization error:', err);
  }
};

const initPromise = initDB();

const saveHistory = async (hostId, data) => {
  await initPromise;
  await pool.query(
    `INSERT INTO history (hostId, cpu, mem, rx, tx) VALUES ($1, $2, $3, $4, $5)`,
    [hostId, data.cpu || 0, data.mem || 0, (data.network || {}).rx || 0, (data.network || {}).tx || 0]
  );
};

const logEvent = async (hostId, type, message) => {
  await initPromise;
  await pool.query(`INSERT INTO events (hostId, type, message) VALUES ($1, $2, $3)`, [hostId, type, message]);
};

const getHistory = async (hostId, limit = 100) => {
  await initPromise;
  const { rows } = await pool.query(`SELECT * FROM history WHERE hostId = $1 ORDER BY timestamp DESC LIMIT $2`, [hostId, limit]);
  return rows.reverse();
};

const getWebhooks = async () => {
  await initPromise;
  const { rows } = await pool.query(`SELECT * FROM webhooks`);
  return rows;
};

const getRules = async () => {
  await initPromise;
  const { rows } = await pool.query(`SELECT * FROM rules`);
  return rows;
};

const addWebhook = async (data) => {
  await initPromise;
  await pool.query(`INSERT INTO webhooks (type, url, token, chatId) VALUES ($1, $2, $3, $4)`, [data.type, data.url, data.token, data.chatId]);
};

const addRule = async (data) => {
  await initPromise;
  await pool.query(`INSERT INTO rules (name, hostId, metric, threshold, action) VALUES ($1, $2, $3, $4, $5)`, [data.name, data.hostId, data.metric, data.threshold, data.action]);
};

const getEvents = async (limit = 500) => {
  await initPromise;
  const { rows } = await pool.query(`SELECT * FROM events ORDER BY timestamp DESC LIMIT $1`, [limit]);
  return rows;
};

const pruneHistory = async () => {
  await initPromise;
  await pool.query(`DELETE FROM history WHERE timestamp < NOW() - INTERVAL '7 days'`);
};

const getSshHosts = async () => {
  await initPromise;
  const { rows } = await pool.query(`SELECT * FROM ssh_hosts ORDER BY lastConnected DESC`);
  return rows;
};

const saveSshHost = async (data) => {
  await initPromise;
  await pool.query(`
    INSERT INTO ssh_hosts (host, name, "user", pass, port, remotePath, hubIp, lastConnected) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
    ON CONFLICT (host) DO UPDATE SET 
      name = EXCLUDED.name,
      "user" = EXCLUDED."user",
      pass = EXCLUDED.pass,
      port = EXCLUDED.port,
      remotePath = EXCLUDED.remotePath,
      hubIp = EXCLUDED.hubIp,
      lastConnected = CURRENT_TIMESTAMP
  `, [data.host, data.name, data.user, data.pass, data.port, data.remotePath, data.hubIp]);
};

const deleteSshHost = async (host) => {
  await initPromise;
  await pool.query(`DELETE FROM ssh_hosts WHERE host = $1`, [host]);
};

// ─── Service CRUD ─────────────────────────────────────────────────────────
const getServices = async (type) => {
  await initPromise;
  if (type) {
    const { rows } = await pool.query(`SELECT * FROM services WHERE type = $1 ORDER BY created_at DESC`, [type]);
    return rows;
  }
  const { rows } = await pool.query(`SELECT * FROM services ORDER BY created_at DESC`);
  return rows;
};

const addService = async (data) => {
  await initPromise;
  const { rows } = await pool.query(`
    INSERT INTO services (type, name, host, port, username, password, database_name, connection_string)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
  `, [
    data.type, data.name, data.host, data.port || null,
    data.username || null, data.password || null,
    data.database_name || null, data.connection_string || null
  ]);
  return { id: rows[0].id, ...data };
};

const updateServiceStatus = async (id, status, latency) => {
  await initPromise;
  await pool.query(`UPDATE services SET status = $1, latency = $2, last_checked = CURRENT_TIMESTAMP WHERE id = $3`, [status, latency || 0, id]);
};

const deleteService = async (id) => {
  await initPromise;
  await pool.query(`DELETE FROM services WHERE id = $1`, [id]);
};

const saveServiceStat = async (serviceId, key, value) => {
  await initPromise;
  await pool.query(`INSERT INTO service_stats (service_id, stat_key, stat_value) VALUES ($1, $2, $3)`, [serviceId, key, value]);
};

const getServiceStats = async (serviceId, key, limit = 30) => {
  await initPromise;
  const { rows } = await pool.query(`SELECT stat_value, timestamp FROM service_stats WHERE service_id = $1 AND stat_key = $2 ORDER BY timestamp DESC LIMIT $3`, [serviceId, key, limit]);
  return rows.reverse();
};

// ─── User Management ─────────────────────────────────────────────────────────
const getUser = async (username) => {
  await initPromise;
  const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  return rows[0];
};

const getUserById = async (id) => {
  await initPromise;
  const { rows } = await pool.query(`SELECT id, username, role, last_login, created_at FROM users WHERE id = $1`, [id]);
  return rows[0];
};

const createUser = async (username, passwordHash, role = 'admin') => {
  await initPromise;
  const { rows } = await pool.query(`INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id`, [username, passwordHash, role]);
  return { id: rows[0].id, username, role };
};

const updateLastLogin = async (id) => {
  await initPromise;
  await pool.query(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
};

const getUsers = async () => {
  await initPromise;
  const { rows } = await pool.query(`SELECT id, username, role, last_login, created_at FROM users ORDER BY created_at DESC`);
  return rows;
};

const deleteUser = async (id) => {
  await initPromise;
  const result = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  return result.rowCount;
};

const updateUserRole = async (id, role) => {
  await initPromise;
  const result = await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [role, id]);
  return result.rowCount;
};

// ─── Alert Log ───────────────────────────────────────────────────────────────
const logAlert = async (data) => {
  await initPromise;
  await pool.query(`INSERT INTO alert_log (service_id, service_name, service_type, severity, message, channel, sent) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [data.service_id || null, data.service_name, data.service_type || 'system', data.severity || 'warning', data.message, data.channel || 'system', data.sent ? 1 : 0]);
};

const getAlertLog = async (limit = 100) => {
  await initPromise;
  const { rows } = await pool.query(`SELECT * FROM alert_log ORDER BY timestamp DESC LIMIT $1`, [limit]);
  return rows;
};

// ─── Disk Predictive Analytics ───────────────────────────────────────────────
const saveDiskAnalytics = async (hostId, diskName, healthStatus, temp, reallocated, uncorrectable) => {
  // Sanitize N/A values
  if (typeof temp === 'string' && temp.toUpperCase() === 'N/A') temp = null;
  if (typeof reallocated === 'string' && reallocated.toUpperCase() === 'N/A') reallocated = null;
  if (typeof uncorrectable === 'string' && uncorrectable.toUpperCase() === 'N/A') uncorrectable = null;
  await initPromise;
  await pool.query(`INSERT INTO disk_analytics (hostId, diskName, healthStatus, temperature, reallocated, uncorrectable) VALUES ($1, $2, $3, $4, $5, $6)`, [hostId, diskName, healthStatus || 'UNKNOWN', temp || 30, reallocated || 0, uncorrectable || 0]);
};

const getDiskAnalytics = async (hostId, diskName, limit = 50) => {
  await initPromise;
  const { rows } = await pool.query(`SELECT * FROM disk_analytics WHERE hostId = $1 AND diskName = $2 ORDER BY timestamp DESC LIMIT $3`, [hostId, diskName, limit]);
  return rows.reverse();
};

module.exports = { 
  saveHistory, logEvent, getHistory, 
  getWebhooks, addWebhook, 
  getRules, addRule, getEvents,
  pruneHistory, getSshHosts, saveSshHost, deleteSshHost,
  getServices, addService, updateServiceStatus, deleteService,
  saveServiceStat, getServiceStats,
  getUser, getUserById, createUser, updateLastLogin, getUsers, deleteUser, updateUserRole,
  logAlert, getAlertLog,
  saveDiskAnalytics, getDiskAnalytics,
  pool,
};
