const express = require('express');
const router = express.Router();
const db = require('../database');
const net = require('net');
const jwt = require('jsonwebtoken');

// ─── Auth helpers for sub-router ────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;

const routerAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token invalid or expired' }); }
};

const routerAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).json({ error: 'Forbidden: Admin required' });
};

// Strip sensitive fields from service objects
const sanitizeService = (svc) => {
  const { password, connection_string, ...safe } = svc;
  return safe;
};

// ─── TCP Ping Helper ─────────────────────────────────────────────────────────
const tcpPing = (host, port, timeoutMs = 4000) => {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let resolved = false;

    const done = (ok) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ ok, latency: Date.now() - start });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.connect(port, host);
  });
};

// ─── Default port per service type ──────────────────────────────────────────
const getDefaultPort = (type) => {
  switch (type) {
    case 'postgres': return 5432;
    case 'redis': return 6379;
    case 'mongodb': return 27017;
    case 'docker': return 9100;
    default: return 80;
  }
};

// ─── PostgreSQL Stats ────────────────────────────────────────────────────────
const getPgStats = async (svc) => {
  try {
    const { Client } = require('pg');
    const client = new Client({
      host: svc.host,
      port: svc.port || 5432,
      user: svc.username || 'postgres',
      password: svc.password || '',
      database: svc.database_name || 'postgres',
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    await client.connect();

    const [connRes, cacheRes, sizeRes, slowRes] = await Promise.all([
      client.query(`
        SELECT 
          count(*) AS total,
          count(*) FILTER (WHERE state = 'active') AS active,
          count(*) FILTER (WHERE state = 'idle') AS idle
        FROM pg_stat_activity WHERE datname = current_database()
      `),
      client.query(`
        SELECT 
          ROUND(
            100.0 * sum(blks_hit) / NULLIF(sum(blks_hit) + sum(blks_read), 0), 2
          ) AS hit_pct
        FROM pg_stat_database WHERE datname = current_database()
      `),
      client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size, pg_database_size(current_database()) AS size_bytes`),
      client.query(`
        SELECT count(*) AS slow
        FROM pg_stat_activity
        WHERE state = 'active'
          AND query_start < now() - interval '5 seconds'
          AND datname = current_database()
      `),
    ]);

    await client.end();

    const row = connRes.rows[0];
    return {
      connections_total: parseInt(row.total),
      connections_active: parseInt(row.active),
      connections_idle: parseInt(row.idle),
      cache_hit_pct: parseFloat(cacheRes.rows[0]?.hit_pct || 0),
      db_size_mb: Math.round((sizeRes.rows[0]?.size_bytes || 0) / 1024 / 1024),
      db_size_pretty: sizeRes.rows[0]?.size || '—',
      slow_queries: parseInt(slowRes.rows[0]?.slow || 0),
    };
  } catch (e) {
    return { error: e.message };
  }
};

// ─── Redis Stats ─────────────────────────────────────────────────────────────
const getRedisStats = async (svc) => {
  try {
    const redis = require('redis');
    const client = redis.createClient({
      socket: { host: svc.host, port: svc.port || 6379, connectTimeout: 5000 },
      password: svc.password || undefined,
    });
    await client.connect();
    const info = await client.info();
    await client.disconnect();

    const parse = (key) => {
      const match = info.match(new RegExp(`^${key}:(.+)$`, 'm'));
      return match ? match[1].trim() : null;
    };

    return {
      clients: parseInt(parse('connected_clients') || 0),
      memory_used_mb: Math.round(parseInt(parse('used_memory') || 0) / 1024 / 1024),
      memory_peak_mb: Math.round(parseInt(parse('used_memory_peak') || 0) / 1024 / 1024),
      instantaneous_ops_per_sec: parseInt(parse('instantaneous_ops_per_sec') || 0),
      uptime_days: Math.round(parseInt(parse('uptime_in_seconds') || 0) / 86400),
      redis_version: parse('redis_version'),
      role: parse('role'),
      keyspace_hits: parseInt(parse('keyspace_hits') || 0),
      keyspace_misses: parseInt(parse('keyspace_misses') || 0),
    };
  } catch (e) {
    return { error: e.message };
  }
};

// ─── MongoDB Stats ───────────────────────────────────────────────────────────
const getMongoStats = async (svc) => {
  try {
    const { MongoClient } = require('mongodb');
    const auth = svc.username && svc.password
      ? `${encodeURIComponent(svc.username)}:${encodeURIComponent(svc.password)}@`
      : '';
    const uri = `mongodb://${auth}${svc.host}:${svc.port || 27017}/?connectTimeoutMS=5000&serverSelectionTimeoutMS=5000`;
    const client = new MongoClient(uri);
    await client.connect();
    const admin = client.db('admin');
    const serverStatus = await admin.command({ serverStatus: 1 });
    await client.close();

    const conn = serverStatus.connections || {};
    const net = serverStatus.network || {};
    const ops = serverStatus.opcounters || {};
    const opTotal = (ops.insert || 0) + (ops.query || 0) + (ops.update || 0) + (ops.delete || 0) + (ops.getmore || 0) + (ops.command || 0);

    return {
      connections_current: conn.current || 0,
      connections_available: conn.available || 0,
      connections_total_created: conn.totalCreated || 0,
      network_bytes_in: net.bytesIn || 0,
      network_bytes_out: net.bytesOut || 0,
      opcounters_total: opTotal,
      opcounters: {
        insert: ops.insert || 0,
        query: ops.query || 0,
        update: ops.update || 0,
        delete: ops.delete || 0,
      },
      uptime_seconds: serverStatus.uptimeMillis ? Math.round(serverStatus.uptimeMillis / 1000) : 0,
      version: serverStatus.version,
    };
  } catch (e) {
    return { error: e.message };
  }
};

// ─── Node Exporter / Generic Stats ───────────────────────────────────────────
const getNodeExporterStats = async (svc) => {
  try {
    const http = require('http');
    const raw = await new Promise((resolve, reject) => {
      const req = http.get(`http://${svc.host}:${svc.port || 9100}/metrics`, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    const getMetric = (name) => {
      const m = raw.match(new RegExp(`^${name}\\s+([\\d.]+)`, 'm'));
      return m ? parseFloat(m[1]) : null;
    };

    const cpuIdle = getMetric('node_cpu_seconds_total{cpu="0",mode="idle"}');
    const memTotal = getMetric('node_memory_MemTotal_bytes');
    const memFree = getMetric('node_memory_MemAvailable_bytes');
    const diskFree = getMetric('node_filesystem_avail_bytes{mountpoint="/",fstype!="rootfs"}') ||
      getMetric('node_filesystem_avail_bytes{mountpoint="/"}');
    const uptime = getMetric('node_time_seconds') && getMetric('node_boot_time_seconds')
      ? getMetric('node_time_seconds') - getMetric('node_boot_time_seconds')
      : null;

    return {
      cpu_load_1m: cpuIdle !== null ? Math.round((1 - cpuIdle) * 100) : null,
      mem_used_pct: memTotal && memFree ? parseFloat(((1 - memFree / memTotal) * 100).toFixed(1)) : null,
      disk_free_gb: diskFree !== null ? parseFloat((diskFree / 1024 / 1024 / 1024).toFixed(1)) : null,
      uptime_days: uptime ? Math.round(uptime / 86400) : null,
    };
  } catch (e) {
    return { error: e.message };
  }
};

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/services?type=postgres
router.get('/api/services', routerAuth, async (req, res) => {
  try {
    const rows = await db.getServices(req.query.type || null);
    res.json(rows.map(sanitizeService));
  } catch (e) {
    res.status(500).json({ error: 'Failed to retrieve services' });
  }
});

// POST /api/services (Admin only)
router.post('/api/services', routerAuth, routerAdmin, async (req, res) => {
  try {
    const svc = await db.addService(req.body);
    res.json(sanitizeService(svc));
  } catch (e) {
    res.status(500).json({ error: 'Failed to add service' });
  }
});

// DELETE /api/services/:id (Admin only)
router.delete('/api/services/:id', routerAuth, routerAdmin, async (req, res) => {
  try {
    await db.deleteService(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

// POST /api/services/:id/ping  (TCP connectivity check)
router.post('/api/services/:id/ping', async (req, res) => {
  try {
    const services = await db.getServices();
    const svc = services.find(s => s.id === parseInt(req.params.id));
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const port = svc.port || getDefaultPort(svc.type);
    const { ok, latency } = await tcpPing(svc.host, port, 4000);
    await db.updateServiceStatus(svc.id, ok ? 'online' : 'offline', latency);
    res.json({ status: ok ? 'online' : 'offline', latency });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/services/:id/stats  (Full metrics from the service)
router.get('/api/services/:id/stats', async (req, res) => {
  try {
    const services = await db.getServices();
    const svc = services.find(s => s.id === parseInt(req.params.id));
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    let stats = {};

    if (svc.type === 'postgres') {
      stats = await getPgStats(svc);
    } else if (svc.type === 'redis') {
      stats = await getRedisStats(svc);
    } else if (svc.type === 'mongodb') {
      stats = await getMongoStats(svc);
    } else {
      // docker / node-exporter
      stats = await getNodeExporterStats(svc);
      if (stats.error) {
        // Fallback: just do a TCP ping
        const { ok, latency } = await tcpPing(svc.host, svc.port || 9100, 3000);
        stats = { status: ok ? 'online' : 'offline', latency };
      }
    }

    // Persist stats snapshot
    if (!stats.error) {
      await db.updateServiceStatus(svc.id, 'online', stats.latency || 0);
      // Save a stat snapshot for history chart
      const chartKey = { postgres: 'connections_active', redis: 'memory_used_mb', mongodb: 'connections_current', docker: 'cpu_load_1m' }[svc.type] || 'value';
      const chartVal = stats[chartKey];
      if (chartVal !== undefined && chartVal !== null) {
        await db.saveServiceStat(svc.id, chartKey, chartVal).catch(() => {});
      }
    } else {
      await db.updateServiceStatus(svc.id, 'offline', 0);
    }

    res.json({ ...stats, service: { id: svc.id, name: svc.name, type: svc.type } });
  } catch (e) {
    await db.updateServiceStatus(parseInt(req.params.id), 'offline', 0).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// GET /api/services/:id/history
router.get('/api/services/:id/history', async (req, res) => {
  try {
    const data = await db.getServiceStats(
      parseInt(req.params.id),
      req.query.key || 'connections_active',
      parseInt(req.query.limit) || 30
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
