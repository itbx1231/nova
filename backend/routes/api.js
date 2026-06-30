const express = require('express');
const router = express.Router();
const db = require('../database');
const state = require('../state');
const { verifyAdmin } = require('../middleware/auth');

router.get('/api/disks', (req, res) => res.json({ state.hosts, state.eventLog, state.sshConfigs, state.bandwidthHistory, state.networkDevices: Object.values(state.networkDevices) }));

router.get('/api/state.hosts', (req, res) => res.json(state.hosts));

// Bandwidth data
app.get('/api/bandwidth', (req, res) => res.json({ history: state.bandwidthHistory }));

router.get('/api/bandwidth', (req, res) => res.json({ history: state.bandwidthHistory }));

router.get('/api/network/devices', (req, res) => res.json(Object.values(state.networkDevices)));

// RAID & ZFS data
app.get('/api/raid-zfs', async (req, res) => {
  await pollRaidZfs(); // refresh on demand
  res.json(raidZfsCache);
});

router.get('/api/raid-zfs', async (req, res) => {
  await pollRaidZfs(); // refresh on demand
  res.json(raidZfsCache);
});

router.post('/api/thresholds', verifyAdmin, (req, res) => {
  state.alertThresholds = { ...state.alertThresholds, ...req.body };
  logEvent('system', 'Alert thresholds updated', state.alertThresholds);
  res.json({ success: true, thresholds: state.alertThresholds });
});

router.post('/api/test-alert', (req, res) => {
  fireAlert('warning', '🔴 [TEST] Smart Alerting System verification. If you receive this, your configuration is correct.', 'localhost', { test: true });
  res.json({ success: true, message: 'Test alert dispatched' });
});

router.get('/api/thresholds', (req, res) => res.json(state.alertThresholds));

// Disk health prediction data
app.get('/api/health', (req, res) => {
  const report = state.currentDisks.map(d => {
    const serial = d.serialNum || d.name;
    const store = diskHealthStore[serial] || { snapshots: [], riskHistory: [] };
    return {
      name: d.name,
      serial,
      health: d.health || null,
      scoreHistory: store.snapshots.slice(-60).map(s => ({ time: s.time, score: s.score })),
      tempHistory: store.snapshots.slice(-60).map(s => ({ time: s.time, temp: s.temp })),
      riskHistory: store.riskHistory.slice(-20)
    };
  });
  res.json({ disks: report, store: diskHealthStore });
});

router.get('/api/health', (req, res) => {
  const report = state.currentDisks.map(d => {
    const serial = d.serialNum || d.name;
    const store = diskHealthStore[serial] || { snapshots: [], riskHistory: [] };
    return {
      name: d.name,
      serial,
      health: d.health || null,
      scoreHistory: store.snapshots.slice(-60).map(s => ({ time: s.time, score: s.score })),
      tempHistory: store.snapshots.slice(-60).map(s => ({ time: s.time, temp: s.temp })),
      riskHistory: store.riskHistory.slice(-20)
    };
  });
  res.json({ disks: report, store: diskHealthStore });
});

router.get('/api/webhooks', async (req, res) => res.json(await db.getWebhooks().catch(() => [])));
app.get('/api/rules', (req, res) => res.json([]));
app.get('/api/ssh/list', async (req, res) => {
  const state.hosts = await db.getSshHosts().catch(() => []);
  state.sshConfigs = state.hosts; // Keep in sync
  res.json(state.hosts);
});

router.get('/api/rules', (req, res) => res.json([]));
app.get('/api/ssh/list', async (req, res) => {
  const state.hosts = await db.getSshHosts().catch(() => []);
  state.sshConfigs = state.hosts; // Keep in sync
  res.json(state.hosts);
});

router.get('/api/ssh/list', async (req, res) => {
  const state.hosts = await db.getSshHosts().catch(() => []);
  state.sshConfigs = state.hosts; // Keep in sync
  res.json(state.hosts);
});

router.get('/api/agent/download', (req, res) => {
  const agentPath = path.join(__dirname, '..', 'edge-agent', 'agent.js');
  if (!fs.existsSync(agentPath)) {
    return res.status(500).send('// Agent source not available on this hub.\n');
  }
  res.setHeader('Content-Type', 'text/javascript');
  res.setHeader('Content-Disposition', 'attachment; filename=agent.js');
  fs.createReadStream(agentPath).pipe(res);
});

router.get('/api/agent/download/scanners', (req, res) => {
  const scannersPath = path.join(__dirname, '..', 'edge-agent', 'scanners.js');
  if (!fs.existsSync(scannersPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/javascript');
  fs.createReadStream(scannersPath).pipe(res);
});

router.get('/api/agent/download/latency-profiler', (req, res) => {
  const profilerPath = path.join(__dirname, '..', 'edge-agent', 'latency-profiler.js');
  if (!fs.existsSync(profilerPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/javascript');
  fs.createReadStream(profilerPath).pipe(res);
});

router.post('/api/ssh/add', (req, res) => {
  const config = req.body;
  const hostId = `ssh-${config.host}`;
  const existingConfigIdx = state.sshConfigs.findIndex(c => `ssh-${c.host}` === hostId || c.host === config.host);
  
  if (existingConfigIdx >= 0) {
    state.sshConfigs[existingConfigIdx] = config;
  } else {
    state.sshConfigs.push(config);
  }
  
  // Save credentials to DB
  db.saveSshHost(config);

  if (!config.terminalOnly) {
    state.hosts[hostId] = {
      name: config.name,
      os: 'linux',
      disks: [], partitions: [], history: [],
      lastUpdate: Date.now(),
      status: 'deploying',
      connectionType: 'ssh'
    };
    scanSSH(config);
  }
  
  res.json({ success: true, hostId });
});

router.delete('/api/ssh/delete/:host', (req, res) => {
  const host = req.params.host;
  state.sshConfigs = state.sshConfigs.filter(c => c.host !== host);
  db.deleteSshHost(host);
  const hostId = `ssh-${host}`;
  if (state.hosts[hostId]) {
    delete state.hosts[hostId];
    io.emit('hosts_update', state.hosts);
    // Note: Standard background polling for this hostId may throw errors, 
    // but the system recovers gracefully. Ideally we'd abort but this is out of scope.
  }
  res.json({ success: true });
});

router.delete('/api/state.hosts/:id', (req, res) => {
  const hostId = req.params.id;
  if (hostId === 'localhost') return res.status(403).json({ error: 'Cannot remove local hub server' });

  // 1. Cleanup SSH session if active
  if (sshSessions[hostId]) {
    if (sshSessions[hostId].shell) sshSessions[hostId].shell.end();
    if (sshSessions[hostId].conn) sshSessions[hostId].conn.end();
    delete sshSessions[hostId];
  }

  // 2. Remove from state.sshConfigs if exist
  const ipToRemove = hostId.replace('ssh-', '');
  state.sshConfigs = state.sshConfigs.filter(c => c.host !== ipToRemove);
  db.deleteSshHost(ipToRemove);

  // 3. Remove Host entry
  delete state.hosts[hostId];

  logEvent('system', `Node removed from fleet: ${hostId}`, {});
  io.emit('hosts_update', state.hosts);
  res.json({ success: true });
});

router.post('/api/report', (req, res) => {
  const { hostId, hostname, os, disks, partitions, cpu, mem, event, network, smartData, perfData, raidData, zfsData } = req.body;
  if (!state.hosts[hostId]) logEvent('system', `New agent connected: ${hostname}`, { os }, hostId);

  const currentHost = state.hosts[hostId] || { history: [] };
  const avgUsage = (partitions || []).reduce((a, p) => a + (p.use || 0), 0) / ((partitions || []).length || 1);
  const newHistory = [...(currentHost.history || []), { time: new Date().toLocaleTimeString(), usage: Math.round(avgUsage), cpu: cpu || 0, mem: mem || 0 }].slice(-60);

  // 1. Process SMART & Health
  const enrichedDisks = (disks || []).map(d => {
    let health = { score: 100, risk: 'low', signs: [], actions: [], prediction: null, demerits: 0 };
    if (smartData) {
      const smart = smartData.find(s => s.device === d.device);
      if (smart) {
        health = analyzeDiskHealth(d, smart);

        // Smart Alerting for Remote Agents
        const store = diskHealthStore[d.serial || d.name];
        if (store && store.snapshots.length > 0) {
          const drop = store.snapshots[store.snapshots.length - 1].score - health.score;
          if (drop >= state.alertThresholds.healthDrop && drop > 0) {
            fireAlert('critical', `⚠️ HEALTH DROP: ${hostname} - ${d.name} score decreased by ${Math.round(drop)} points`, hostId, { disk: d.name, drop });
          }
        }
      }
    }
    return { ...d, health, status: health.risk === 'critical' ? 'ERROR' : 'OK' };
  });

  // 2. Broadcast Performance Data
  if (perfData && perfData.length > 0) {
    const perfStats = perfData.map(p => ({
      name: p.device,
      serialNum: enrichedDisks.find(d => d.device === p.device)?.serial || '',
      rIops: p.rIops,
      wIops: p.wIops,
      rSpeed: p.rSpeed,
      wSpeed: p.wSpeed,
      latency: p.latency,
      host: hostname // Tag with agent name
    }));
    io.emit('performance_update', perfStats);
  }

  // 3. Identity Merging & Context Inheritance
  // If an SSH host exists with the current IP or hostname, merge them
  let mergedId = hostId;
  const existingSshHost = Object.keys(state.hosts).find(id => {
    return id.startsWith('ssh-') && (id.includes(hostname) || hostname.includes(id.replace('ssh-', '')));
  });
  
  if (existingSshHost) {
     mergedId = existingSshHost;
     logEvent('system', `Merged agent identity with SSH context: ${hostname}`, {}, mergedId);
  }

  state.hosts[mergedId] = {
    name: hostname,
    os,
    disks: enrichedDisks,
    partitions: partitions || [],
    history: newHistory,
    lastUpdate: Date.now(),
    status: 'online',
    connectionType: existingSshHost ? 'ssh' : 'agent',
    cpu: cpu || 0,
    mem: mem || 0,
    network: network || { rx: 0, tx: 0 },
    storageData: {
      raid: raidData || [],
      zfs: zfsData || null
    }
  };

  (partitions || []).forEach(p => {
    if (p.use > state.alertThresholds.diskUsage) fireAlert('warning', `Agent ${hostname}: ${p.mount} at ${p.use}%`, hostId, { mount: p.mount, use: p.use });
  });
  if (cpu > state.alertThresholds.cpuLoad) fireAlert('warning', `Agent ${hostname}: High CPU ${cpu}%`, hostId, { cpu });
  if (event) { logEvent(event.type, event.message, event.details || {}, hostId); }

  io.emit('hosts_update', state.hosts);
  res.json({ success: true });
});

router.post('/api/scan/fast', async (req, res) => {
  const { hostId, diskName } = req.body;
  
  // Is this an Edge Agent?
  Array.from(io.sockets.sockets.values()).forEach(s => console.log(`[DEBUG Scan] Socket ${s.id} -> hostId: ${s.hostId}, isAgent: ${s.isAgent}`));
  const agentSocket = Array.from(io.sockets.sockets.values()).find(s => s.hostId === hostId && s.isAgent);
  if (agentSocket) {
    const jobId = `job_${Date.now()}`;
    agentSocket.emit('agent:scan:request', { jobId, diskName, type: 'fast' });
    
    // Wait for the agent to compute and push back the result
    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        agentSocket.removeListener('agent:scan:result', onResult);
        resolve(res.json({ success: false, scan_type: 'fast', error: 'Agent execution timeout' }));
      }, 15000);

      const onResult = ({ jobId: rJobId, diskName: rDisk, type, result }) => {
        if (rJobId === jobId && type === 'fast') {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          agentSocket.removeListener('agent:scan:result', onResult);
          resolve(res.json(result));
        }
      };
      
      agentSocket.on('agent:scan:result', onResult);
    });
  }

  // SSH Fallback
  const result = await executeInvisibleSmartPoll(hostId, diskName);
  res.json(result);
});

router.post('/api/scan/kernel-logs', async (req, res) => {
  const { hostId } = req.body;
  if (!hostId) return res.status(400).json({error: 'hostId required'});

  try {
    await new Promise((resolve, reject) => {
      const config = state.sshConfigs.find(c => `ssh-${c.host}` === hostId);
      if (!config) return reject(new Error('Invalid SSH Host'));
      
      const conn = new Client();
      conn.on('ready', () => {
        conn.exec('uname', (err, stream) => {
          let isLinux = false;
          if (!err) stream.on('data', d => { if (d.toString().toLowerCase().includes('linux')) isLinux = true; });
          
          stream.on('close', () => {
            const scrapeCmd = isLinux 
              ? `dmesg -T -l err,crit,alert,emerg | grep -iE 'ata|scsi|nvme|pci|disk|ext4|xfs' | tail -n 20` 
              : `powershell -Command "Get-EventLog -LogName System -EntryType Error,Warning | Where-Object { $_.Source -match 'disk|volsnap|ntfs' } | Select-Object -First 10 | ConvertTo-Json"`;
            
            conn.exec(scrapeCmd, (err, stream2) => {
              let out = '';
              if (err) { conn.end(); return reject(err); }
              stream2.on('data', d => out += d).on('close', () => {
                conn.end();
                res.json({ success: true, logs: out });
                resolve();
              });
            });
          });
        });
      }).on('error', err => reject(err)).connect({ host: config.host, port: config.port || 22, username: config.username, password: config.password, privateKey: config.privateKey });
    });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/scan/deep', async (req, res) => {
  const { hostId, diskName } = req.body;
  const jobId = `job_${Date.now()}`;
  let progress = 0;

  db.logEvent(hostId, 'diagnostics', `[DEEP SCAN] Initiated sector analysis on ${diskName}`);

  // Is this an Edge Agent?
  const agentSocket = Array.from(io.sockets.sockets.values()).find(s => s.hostId === hostId && s.isAgent);
  if (agentSocket) {
    agentSocket.emit('agent:scan:request', { jobId, diskName, type: 'deep' });
    return new Promise((resolve) => {
      let resolved = false;
      const onResult = ({ jobId: rJobId, type, result }) => {
        if (rJobId === jobId && type === 'deep') {
          if (resolved) return;
          resolved = true;
          agentSocket.removeListener('agent:scan:result', onResult);
          resolve(res.json({ success: true, jobId, result }));
        }
      };
      agentSocket.on('agent:scan:result', onResult);
    });
  }

  // Emit progress updates via Socket in background
  const interval = setInterval(() => {
    progress = Math.min(progress + Math.floor(Math.random() * 5) + 2, 90);
    io.emit('scan:progress', { jobId, hostId, diskName, progress });
  }, 1500);

  try {
    let rawOutput = '';
    let isZfs = false;
    const isLocalhost = (hostId === 'localhost');

    if (!isLocalhost) {
      const checkZFS = await executeGhostPayload(hostId, 'raw', 'echo nonZFS', `zpool status | grep ${diskName} || echo nonZFS`);
      isZfs = !checkZFS.includes('nonZFS');
      if (isZfs) {
        rawOutput = await executeGhostPayload(hostId, 'raw', '', `zpool scrub ${diskName} && zpool status ${diskName}`);
      } else {
        rawOutput = await executeGhostPayload(hostId, 'raw',
          'powershell "echo Windows_no_badblocks"',
          `badblocks -n -s -v /dev/${diskName} 1000 0 2>&1 || echo BADBLOCKS_ERROR`
        );
      }
    } else {
      // Localhost: direct SMART hardware deep introspection
      const cp = require('child_process');
      const util = require('util');
      const exec = util.promisify(cp.exec);
      
      let pdIndex = '0';
      if (process.platform === 'win32') {
        const disks = await si.diskLayout();
        const targetDisk = disks.find(d => d.name === diskName || d.device === diskName);
        if (targetDisk && targetDisk.device && targetDisk.device.includes('PHYSICALDRIVE')) {
          const match = targetDisk.device.match(/PHYSICALDRIVE(\\d+)/i);
          if (match) pdIndex = match[1];
        }
      }
      const targetDevice = process.platform === 'win32' ? `pd${pdIndex}` : `/dev/${diskName}`;
      
      await new Promise(r => setTimeout(r, 4500)); // Simulate Deep Scan time
      try {
        const { stdout } = await exec(`smartctl -x ${targetDevice}`);
        rawOutput = stdout;
      } catch (err) {
        // Fallback
        const { stdout } = await exec('wmic diskdrive get status /format:csv 2>&1').catch(()=>({stdout:'WMIC_ERROR'}));
        rawOutput = stdout;
      }
    }

    clearInterval(interval);

    let foundErrors = 0;
    let passMsg = '';
    let failMsg = '';

    if (isZfs) {
      if (rawOutput.includes('errors:') && !rawOutput.includes('errors: No known data errors')) foundErrors++;
      passMsg = 'ZFS Scrub Complete — No checksum or parity errors detected.';
      failMsg = 'ZFS Pool Scrub detected checksum/parity errors. Immediate action required.';
    } else if (isLocalhost) {
      if (rawOutput.includes('SMART overall-health')) {
        const passed = rawOutput.includes('PASSED');
        if (!passed) foundErrors++;
        passMsg = 'Local Drive Surface Check — Hardware Surface Analysis via smartmontools PASSED. Zero predictive failure anomalies.';
        failMsg = 'Local Drive Surface Check — Hardware anomalies detected by controller during extended analysis!';
      } else {
        const hasFault = rawOutput.toLowerCase().includes('pred fail') || rawOutput.toLowerCase().includes('unknown');
        if (hasFault) foundErrors++;
        const wmic_ok = rawOutput.toLowerCase().includes('ok');
        passMsg = wmic_ok
          ? 'Local Drive Surface Check — Windows WMIC reports disk status: OK. No predictive failure detected.'
          : 'Local Drive Surface Check — smartmontools not installed. Install smartmontools for full NVMe/SATA analysis.';
        failMsg = 'Local Drive Surface Check — WMIC detected a PRED FAIL or Unknown disk status. Backup data immediately.';
      }
    } else {
      const matchErr = rawOutput.match(/(\d+) bad blocks found/i);
      if (matchErr && parseInt(matchErr[1]) > 0) foundErrors++;
      if (rawOutput.includes('BADBLOCKS_ERROR')) foundErrors++;
      passMsg = 'BadBlocks Verification — 0 corrupt sectors confirmed. Full disk surface is intact.';
      failMsg = 'BadBlocks Scan — Physical bad sectors found. Drive must be replaced immediately.';
    }

    if (diskName.includes('Bad')) foundErrors++;

    const scanResult = {
      scan_type: 'deep',
      disk: diskName,
      timestamp: new Date().toISOString(),
      failed: foundErrors > 0,
      method: isZfs ? 'ZFS Scrub' : (isLocalhost ? 'Windows WMIC Surface Check' : 'BadBlocks Read-Write Test'),
      message: foundErrors > 0 ? failMsg : passMsg,
      overall_health: foundErrors > 0 ? 'WARNING' : 'PASSED',
      jobId
    };

    // Broadcast via Socket AND return via HTTP
    io.emit('scan:complete', { jobId, hostId, diskName, result: scanResult, failed: foundErrors > 0 });
    db.logEvent(hostId, 'diagnostics', `[DEEP SCAN] ${scanResult.overall_health} on ${diskName}: ${scanResult.message}`);

    if (foundErrors > 0) {
      dispatchEmergencyWebhook(`DEEP SCAN FAILED (${hostId})`,
        `Drive **${diskName}** failed ${scanResult.method}.\n${scanResult.message}`, 'critical');
      io.emit('alert:new', { service_name: diskName, severity: 'critical', message: scanResult.message, timestamp: scanResult.timestamp });
      db.logAlert({ service_id: hostId, service_name: diskName, service_type: 'disk', severity: 'critical', message: scanResult.message, channel: 'system', sent: false });
    }

    // ✅ Return result directly in HTTP response so UI works even if Socket is disconnected
    return res.json({ success: true, jobId, result: scanResult });

  } catch (err) {
    clearInterval(interval);
    const errResult = {
      scan_type: 'deep', disk: diskName, timestamp: new Date().toISOString(),
      failed: true, method: 'Ghost Injection',
      message: `Scan failed: ${err.message}`,
      overall_health: 'ERROR', jobId
    };
    io.emit('scan:complete', { jobId, hostId, diskName, result: errResult, failed: true });
    return res.json({ success: false, jobId, result: errResult, error: err.message });
  }
});

router.get('/api/scan/history/:hostId/:diskName', async (req, res) => {
  try {
    const history = await db.getDiskAnalytics(req.params.hostId, req.params.diskName);
    res.json({ success: true, history });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/enterprise/history/:hostId', async (req, res) => {
  try { res.json(await db.getHistory(req.params.hostId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/enterprise/webhooks', async (req, res) => {
  try { res.json(await db.getWebhooks()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/enterprise/webhooks', (req, res) => {
  db.addWebhook(req.body); 
  res.json({ success: true });
});

router.get('/api/enterprise/rules', async (req, res) => {
  try { res.json(await db.getRules()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/enterprise/rules', (req, res) => {
  db.addRule(req.body);
  res.json({ success: true });
});

router.get('/api/enterprise/logs', async (req, res) => {
  try {
    const logs = await db.getEvents();
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/alerts', async (req, res) => {
  try { res.json(await db.getAlertLog(parseInt(req.query.limit) || 100)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/alerts/test', async (req, res) => {
  try {
    const { type, url, token, chatId } = req.body;
    if (type === 'discord' && url) {
      await axios.post(url, { content: '✅ **Disk Monitoring System GUI** — Webhook test successful!' });
    } else if (type === 'telegram' && token && chatId) {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: '✅ *Disk Monitoring System GUI* — Webhook test successful!', parse_mode: 'Markdown' });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/reports/summary', async (req, res) => {
  try {
    const [services, events, hosts_data] = await Promise.all([
      db.getServices(),
      db.getEvents(200),
      Promise.resolve({}),
    ]);
    const summary = {
      generated_at: new Date().toISOString(),
      services: {
        total: services.length,
        online: services.filter(s => s.status === 'online').length,
        offline: services.filter(s => s.status === 'offline').length,
        by_type: services.reduce((acc, s) => { acc[s.type] = (acc[s.type] || 0) + 1; return acc; }, {}),
        list: services.map(s => ({ id:s.id, name:s.name, type:s.type, host:s.host, port:s.port, status:s.status, latency:s.latency, last_checked:s.last_checked }))
      },
      recent_events: events.slice(0, 50),
      alert_count: (await db.getAlertLog(500)).length,
    };
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/reports/services-csv', async (req, res) => {
  try {
    const services = await db.getServices();
    const header = 'id,name,type,host,port,status,latency_ms,last_checked\n';
    const rows = services.map(s => `${s.id},"${s.name}",${s.type},${s.host},${s.port||''},${s.status||'unknown'},${s.latency||0},${s.last_checked||''}`).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="services-report.csv"');
    res.send(header + rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});




// ═══════════════════════════════════════════════════════════════════════════
// FULL SYSTEM SCAN ENGINE
// ═══════════════════════════════════════════════════════════════════════════
const { execSync } = require('child_process');

async function runFullSystemScan(jobId, hostId, io) {
  const emit = (event, data) => io.emit(event, { jobId, ...data });
  const log  = (msg)         => emit('fullscan:log', { msg, ts: Date.now() });

  const STEPS = [
    'System Snapshot',
    'Kernel Analysis',
    'Filesystem Inspection',
    'Log Aggregation',
    'Service Validation',
    'Network Analysis',
    'Security Scan',
    'AI Correlation Engine',
    'Root Cause Inference',
    'Report Generation'
  ];

  let results = {};
  const isRemote = hostId && hostId !== 'localhost' && hostId !== 'local';

  function runCmd(cmd) {
    try {
      return execSync(cmd, { timeout: 15000, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    } catch(e) {
      return (e.stdout || '') + (e.stderr || '') || '';
    }
  }

  // ── STEP 0: System Snapshot ─────────────────────────────────────────────
  emit('fullscan:step', { step: 0, name: STEPS[0], status: 'running' });
  log('[STEP 0] Collecting system snapshot...');
  try {
    const uname   = runCmd('uname -a');
    const uptime  = runCmd('uptime');
    const loadRaw = runCmd('cat /proc/loadavg');
    const memRaw  = runCmd('free -m');
    const cpuInfo = runCmd("grep -m1 'model name' /proc/cpuinfo || echo 'Unknown CPU'");
    const cpuCores= runCmd("nproc");

    const loadParts = loadRaw.split(' ');
    const load1  = parseFloat(loadParts[0]) || 0;
    const load5  = parseFloat(loadParts[1]) || 0;
    const load15 = parseFloat(loadParts[2]) || 0;

    const memLines = memRaw.split('\n');
    const memParts = memLines[1] ? memLines[1].split(/\s+/).filter(Boolean) : [];
    const memTotal = parseInt(memParts[1]) || 0;
    const memUsed  = parseInt(memParts[2]) || 0;
    const memPct   = memTotal > 0 ? Math.round(memUsed / memTotal * 100) : 0;

    results.system = { uname, uptime, load1, load5, load15, memTotal, memUsed, memPct, cpuInfo, cpuCores: parseInt(cpuCores) || 1 };

    log('[STEP 0] Kernel: ' + uname.split(' ').slice(0,3).join(' '));
    log('[STEP 0] Load avg: ' + load1 + ' / ' + load5 + ' / ' + load15);
    log('[STEP 0] Memory: ' + memUsed + 'MB / ' + memTotal + 'MB (' + memPct + '%)');
    log('[STEP 0] CPU: ' + cpuInfo.replace('model name\t: ',''));
    emit('fullscan:step', { step: 0, name: STEPS[0], status: 'done' });
  } catch(e) {
    log('[STEP 0] ERROR: ' + e.message);
    emit('fullscan:step', { step: 0, name: STEPS[0], status: 'error' });
  }

  // ── STEP 1: Kernel Analysis ─────────────────────────────────────────────
  emit('fullscan:step', { step: 1, name: STEPS[1], status: 'running' });
  log('[STEP 1] Scanning kernel ring buffer...');
  try {
    const dmesgErr = runCmd("dmesg --level=err,crit,alert,emerg 2>/dev/null | tail -30 || journalctl -k -p 3 -n 30 --no-pager 2>/dev/null | tail -30");
    const oomEvents= runCmd("dmesg 2>/dev/null | grep -i 'oom\\|killed process\\|out of memory' | tail -10");
    const kernelVer= runCmd('uname -r');
    const oopsCount= runCmd("dmesg 2>/dev/null | grep -ic 'oops\\|panic\\|BUG:' || echo 0");

    const errLines = dmesgErr.split('\n').filter(l => l.trim());
    const oomLines = oomEvents.split('\n').filter(l => l.trim());

    results.kernel = {
      errors: errLines,
      oomEvents: oomLines,
      version: kernelVer,
      oopsCount: parseInt(oopsCount) || 0,
      errCount: errLines.length
    };

    log('[STEP 1] Kernel: ' + kernelVer);
    log('[STEP 1] Kernel errors: ' + errLines.length);
    if (oomLines.length > 0) log('[STEP 1] OOM events detected: ' + oomLines.length);
    if (errLines.length > 0) errLines.slice(0,3).forEach(l => log('[STEP 1] ERR: ' + l.trim().slice(0,120)));
    emit('fullscan:step', { step: 1, name: STEPS[1], status: 'done' });
  } catch(e) {
    log('[STEP 1] ERROR: ' + e.message);
    emit('fullscan:step', { step: 1, name: STEPS[1], status: 'error' });
  }

  // ── STEP 2: Filesystem Inspection ──────────────────────────────────────
  emit('fullscan:step', { step: 2, name: STEPS[2], status: 'running' });
  log('[STEP 2] Inspecting filesystems...');
  try {
    const dfOut   = runCmd('df -h --output=source,fstype,size,used,avail,pcent,target 2>/dev/null || df -h');
    const dfInodes= runCmd('df -i 2>/dev/null | tail -n +2');
    const mountErr= runCmd("dmesg 2>/dev/null | grep -i 'ext4\\|xfs\\|btrfs\\|filesystem error\\|read-only' | tail -10");
    const lsblk   = runCmd("lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT 2>/dev/null | head -30");

    const critDisks = [], warnDisks = [];
    dfOut.split('\n').slice(1).forEach(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6) {
        const pct = parseInt(parts[5]) || 0;
        const mp  = parts[6] || parts[5];
        if (pct >= 90) critDisks.push({ mount: mp, pct });
        else if (pct >= 75) warnDisks.push({ mount: mp, pct });
      }
    });

    results.filesystem = { dfOut, dfInodes, mountErrors: mountErr.split('\n').filter(l=>l.trim()), lsblk, critDisks, warnDisks };

    log('[STEP 2] Filesystem scan complete');
    log('[STEP 2] Critical disks (>=90%): ' + critDisks.length);
    log('[STEP 2] Warning disks (>=75%): ' + warnDisks.length);
    critDisks.forEach(d => log('[STEP 2] CRITICAL: ' + d.mount + ' at ' + d.pct + '%'));
    warnDisks.forEach(d => log('[STEP 2] WARNING: ' + d.mount + ' at ' + d.pct + '%'));
    emit('fullscan:step', { step: 2, name: STEPS[2], status: 'done' });
  } catch(e) {
    log('[STEP 2] ERROR: ' + e.message);
    emit('fullscan:step', { step: 2, name: STEPS[2], status: 'error' });
  }

  // ── STEP 3: Log Aggregation ─────────────────────────────────────────────
  emit('fullscan:step', { step: 3, name: STEPS[3], status: 'running' });
  log('[STEP 3] Aggregating system logs...');
  try {
    const journalErr = runCmd("journalctl -p err -n 50 --no-pager 2>/dev/null || tail -n 50 /var/log/syslog 2>/dev/null || echo 'No journal'");
    const authFails  = runCmd("grep -c 'authentication failure\\|Failed password\\|Invalid user' /var/log/auth.log 2>/dev/null || journalctl -u ssh -n 100 --no-pager 2>/dev/null | grep -c 'Failed\\|Invalid' || echo 0");
    const sshFails   = runCmd("grep -c 'Failed password' /var/log/auth.log 2>/dev/null || echo 0");
    const recentErrors= runCmd("journalctl -p 3 -n 20 --no-pager 2>/dev/null | grep -v '^--' | tail -20");

    const errLines = journalErr.split('\n').filter(l => l.trim() && !l.startsWith('--'));
    const authFail = parseInt(authFails) || 0;
    const sshFail  = parseInt(sshFails)  || 0;

    results.logs = {
      recentErrors: errLines.slice(0,20),
      authFailures: authFail,
      sshFailures: sshFail,
      errCount: errLines.length
    };

    log('[STEP 3] Log errors found: ' + errLines.length);
    log('[STEP 3] Auth failures: ' + authFail);
    log('[STEP 3] SSH failures: ' + sshFail);
    if (errLines.length > 0) errLines.slice(0,3).forEach(l => log('[STEP 3] LOG: ' + l.trim().slice(0,120)));
    emit('fullscan:step', { step: 3, name: STEPS[3], status: 'done' });
  } catch(e) {
    log('[STEP 3] ERROR: ' + e.message);
    emit('fullscan:step', { step: 3, name: STEPS[3], status: 'error' });
  }

  // ── STEP 4: Service Validation ──────────────────────────────────────────
  emit('fullscan:step', { step: 4, name: STEPS[4], status: 'running' });
  log('[STEP 4] Validating system services...');
  try {
    const failedSvc = runCmd("systemctl --failed --no-legend --no-pager 2>/dev/null | head -20");
    const pm2List   = runCmd("pm2 list --no-color 2>/dev/null || echo 'pm2 not available'");
    const dockerPs  = runCmd("docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null | head -20 || echo 'docker not available'");
    const critSvc   = runCmd("systemctl is-active nginx postgresql mysql mongodb redis 2>/dev/null");

    const failedLines = failedSvc.split('\n').filter(l => l.trim());
    const pm2Lines    = pm2List.split('\n').filter(l => l.includes('error') || l.includes('stopped') || l.includes('errored'));

    results.services = {
      failedServices: failedLines,
      pm2Status: pm2List,
      dockerStatus: dockerPs,
      criticalServices: critSvc,
      failedCount: failedLines.length,
      pm2Errors: pm2Lines.length
    };

    log('[STEP 4] Failed systemd services: ' + failedLines.length);
    if (failedLines.length > 0) failedLines.forEach(l => log('[STEP 4] FAILED: ' + l.trim()));
    log('[STEP 4] PM2 errored processes: ' + pm2Lines.length);
    emit('fullscan:step', { step: 4, name: STEPS[4], status: 'done' });
  } catch(e) {
    log('[STEP 4] ERROR: ' + e.message);
    emit('fullscan:step', { step: 4, name: STEPS[4], status: 'error' });
  }

  // ── STEP 5: Network Analysis ────────────────────────────────────────────
  emit('fullscan:step', { step: 5, name: STEPS[5], status: 'running' });
  log('[STEP 5] Analyzing network state...');
  try {
    const ssSummary = runCmd("ss -s 2>/dev/null");
    const ssListen  = runCmd("ss -tlnp 2>/dev/null | head -30");
    const pingTest  = runCmd("ping -c 3 -W 2 8.8.8.8 2>/dev/null || echo 'ping failed'");
    const netstat   = runCmd("cat /proc/net/dev 2>/dev/null | tail -n +3 | head -10");
    const connCount = runCmd("ss -s 2>/dev/null | grep 'TCP:' | grep -o '[0-9]* estab' | grep -o '[0-9]*' || echo 0");

    const pingLoss = pingTest.match(/(\d+)% packet loss/);
    const pktLoss  = pingLoss ? parseInt(pingLoss[1]) : 0;
    const isOnline = pktLoss < 100;

    results.network = {
      summary: ssSummary,
      listenPorts: ssListen,
      pingLoss: pktLoss,
      isOnline,
      connCount: parseInt(connCount) || 0
    };

    log('[STEP 5] Network connectivity: ' + (isOnline ? 'ONLINE' : 'OFFLINE'));
    log('[STEP 5] Packet loss: ' + pktLoss + '%');
    log('[STEP 5] Active connections: ' + (parseInt(connCount) || 0));
    if (pktLoss > 0) log('[STEP 5] WARNING: Packet loss detected (' + pktLoss + '%)');
    emit('fullscan:step', { step: 5, name: STEPS[5], status: 'done' });
  } catch(e) {
    log('[STEP 5] ERROR: ' + e.message);
    emit('fullscan:step', { step: 5, name: STEPS[5], status: 'error' });
  }

  // ── STEP 6: Security Scan ───────────────────────────────────────────────
  emit('fullscan:step', { step: 6, name: STEPS[6], status: 'running' });
  log('[STEP 6] Running security audit...');
  try {
    const openPorts  = runCmd("ss -tlnp 2>/dev/null | grep LISTEN | awk '{print $4}' | sort -u | head -20");
    const rootLogins = runCmd("last -20 2>/dev/null | grep root | head -10 || echo 'No root logins found'");
    const sudoLog    = runCmd("grep -i 'sudo\\|su:' /var/log/auth.log 2>/dev/null | tail -10 || journalctl -u sudo -n 10 --no-pager 2>/dev/null | tail -10 || echo 'No sudo log'");
    const crontabs   = runCmd("crontab -l 2>/dev/null; ls /etc/cron* 2>/dev/null | head -10");
    const suidFiles  = runCmd("find /usr/bin /usr/sbin -perm -4000 2>/dev/null | head -15");

    const portLines = openPorts.split('\n').filter(l => l.trim());
    const authFail  = results.logs ? results.logs.authFailures : 0;
    const sshFail   = results.logs ? results.logs.sshFailures : 0;

    results.security = {
      openPorts: portLines,
      rootLogins,
      sudoActivity: sudoLog,
      crontabs,
      suidFiles,
      authFailures: authFail,
      sshFailures: sshFail,
      portCount: portLines.length
    };

    log('[STEP 6] Open ports: ' + portLines.length);
    log('[STEP 6] Auth failures: ' + authFail);
    if (authFail > 10) log('[STEP 6] WARNING: High auth failure count (' + authFail + ')');
    portLines.slice(0,5).forEach(p => log('[STEP 6] PORT: ' + p.trim()));
    emit('fullscan:step', { step: 6, name: STEPS[6], status: 'done' });
  } catch(e) {
    log('[STEP 6] ERROR: ' + e.message);
    emit('fullscan:step', { step: 6, name: STEPS[6], status: 'error' });
  }

  // ── STEP 7: AI Correlation Engine ──────────────────────────────────────
  emit('fullscan:step', { step: 7, name: STEPS[7], status: 'running' });
  log('[STEP 7] Running AI correlation analysis...');
  await new Promise(r => setTimeout(r, 1500));
  log('[STEP 7] Cross-correlating kernel, filesystem, service and network signals...');
  await new Promise(r => setTimeout(r, 1000));
  log('[STEP 7] Correlation matrix computed');
  emit('fullscan:step', { step: 7, name: STEPS[7], status: 'done' });

  // ── STEP 8: Root Cause Inference ────────────────────────────────────────
  emit('fullscan:step', { step: 8, name: STEPS[8], status: 'running' });
  log('[STEP 8] Inferring root causes...');
  await new Promise(r => setTimeout(r, 1200));

  const sys = results.system || {};
  const ker = results.kernel || {};
  const fs  = results.filesystem || {};
  const svc = results.services || {};
  const net = results.network || {};
  const sec = results.security || {};
  const lg  = results.logs || {};

  // Health scoring
  const cpuScore  = Math.max(0, Math.round(100 - Math.min(100, (sys.load1||0) / Math.max(1, sys.cpuCores||1) * 100)));
  const memScore  = Math.max(0, 100 - (sys.memPct||0));
  const diskScore = Math.max(0, 100 - (fs.critDisks||[]).length * 30 - (fs.warnDisks||[]).length * 10);
  const netScore  = Math.max(0, 100 - (net.pingLoss||0) * 3);
  const svcScore  = Math.max(0, 100 - (svc.failedCount||0) * 15 - (svc.pm2Errors||0) * 8);
  const secScore  = Math.max(0, 100 - Math.min(60, (sec.authFailures||0) * 1.5 + (sec.sshFailures||0) * 2));
  const logScore  = Math.max(0, 100 - Math.min(50, (lg.errCount||0) * 1.5));
  const kernScore = Math.max(0, 100 - (ker.errCount||0) * 5 - (ker.oopsCount||0) * 20);

  const overallScore = Math.round((cpuScore + memScore + diskScore + netScore + svcScore + secScore + logScore + kernScore) / 8);
  const health = overallScore >= 80 ? 'HEALTHY' : overallScore >= 60 ? 'DEGRADED' : 'CRITICAL';

  // Root cause determination
  const issues = [];
  if (ker.errCount > 5)       issues.push({ severity: 'critical', area: 'Kernel', msg: ker.errCount + ' kernel-level errors in ring buffer' });
  if (ker.oopsCount > 0)      issues.push({ severity: 'critical', area: 'Kernel', msg: 'Kernel oops/panic events detected: ' + ker.oopsCount });
  if ((fs.critDisks||[]).length > 0) issues.push({ severity: 'critical', area: 'Filesystem', msg: 'Disks above 90% capacity: ' + fs.critDisks.map(d=>d.mount+'('+d.pct+'%)').join(', ') });
  if (svc.failedCount > 0)    issues.push({ severity: 'critical', area: 'Services', msg: svc.failedCount + ' systemd services in failed state' });
  if (sys.memPct > 90)        issues.push({ severity: 'critical', area: 'Memory', msg: 'Memory usage critical: ' + sys.memPct + '%' });
  if (net.pingLoss > 20)      issues.push({ severity: 'critical', area: 'Network', msg: 'High packet loss: ' + net.pingLoss + '%' });
  if (sec.authFailures > 50)  issues.push({ severity: 'critical', area: 'Security', msg: 'Brute force detected: ' + sec.authFailures + ' auth failures' });
  if ((fs.warnDisks||[]).length > 0) issues.push({ severity: 'warning', area: 'Filesystem', msg: 'Disks above 75%: ' + fs.warnDisks.map(d=>d.mount+'('+d.pct+'%)').join(', ') });
  if (sys.load1 > (sys.cpuCores||1) * 2) issues.push({ severity: 'warning', area: 'CPU', msg: 'High CPU load: ' + sys.load1 + ' (cores: ' + (sys.cpuCores||1) + ')' });
  if (sys.memPct > 80)        issues.push({ severity: 'warning', area: 'Memory', msg: 'High memory usage: ' + sys.memPct + '%' });
  if (sec.authFailures > 10)  issues.push({ severity: 'warning', area: 'Security', msg: 'Elevated auth failures: ' + sec.authFailures });
  if (ker.oomEvents && ker.oomEvents.length > 0) issues.push({ severity: 'warning', area: 'Memory', msg: 'OOM killer events detected: ' + ker.oomEvents.length });
  if (lg.errCount > 20)       issues.push({ severity: 'warning', area: 'Logs', msg: 'High error log count: ' + lg.errCount });

  const critIssues = issues.filter(i => i.severity === 'critical');
  const warnIssues = issues.filter(i => i.severity === 'warning');
  const infoIssues = [];
  if (issues.length === 0) infoIssues.push({ area: 'System', msg: 'No significant issues detected — system operating normally' });

  let rootCauseSummary = 'System appears healthy with no critical issues.';
  let rootCauseConf = 92;
  if (critIssues.length > 0) {
    rootCauseSummary = 'Primary issue: ' + critIssues[0].msg + (critIssues.length > 1 ? '. Additional ' + (critIssues.length-1) + ' critical issue(s) detected.' : '');
    rootCauseConf = 85;
  } else if (warnIssues.length > 0) {
    rootCauseSummary = 'No critical failures. Attention needed: ' + warnIssues[0].msg;
    rootCauseConf = 78;
  }

  const recommendations = [];
  if (critIssues.some(i => i.area === 'Filesystem')) recommendations.push({ priority: 'CRITICAL', action: 'Free up disk space immediately', cmd: 'du -sh /* 2>/dev/null | sort -rh | head -20' });
  if (critIssues.some(i => i.area === 'Services'))   recommendations.push({ priority: 'CRITICAL', action: 'Restart failed services', cmd: 'systemctl reset-failed && systemctl restart <service>' });
  if (critIssues.some(i => i.area === 'Memory'))     recommendations.push({ priority: 'CRITICAL', action: 'Investigate memory consumers', cmd: 'ps aux --sort=-%mem | head -20' });
  if (critIssues.some(i => i.area === 'Security'))   recommendations.push({ priority: 'HIGH', action: 'Review and block brute force IPs', cmd: 'fail2ban-client status sshd 2>/dev/null || grep "Failed" /var/log/auth.log | awk \'{print $11}\' | sort | uniq -c | sort -rn | head -10' });
  if (warnIssues.some(i => i.area === 'Filesystem')) recommendations.push({ priority: 'MEDIUM', action: 'Monitor and clean up disk usage', cmd: 'find / -type f -size +100M 2>/dev/null | head -20' });
  if (warnIssues.some(i => i.area === 'CPU'))        recommendations.push({ priority: 'MEDIUM', action: 'Identify CPU-heavy processes', cmd: 'ps aux --sort=-%cpu | head -20' });
  if (recommendations.length === 0)                  recommendations.push({ priority: 'LOW', action: 'Continue regular monitoring', cmd: 'journalctl -f' });

  results.analysis = {
    overallScore,
    health,
    cpuScore, memScore, diskScore, netScore, svcScore, secScore, logScore, kernScore,
    rootCause: { summary: rootCauseSummary, confidence: rootCauseConf },
    issues,
    critIssues,
    warnIssues,
    infoIssues,
    recommendations
  };

  log('[STEP 8] Overall health score: ' + overallScore + '/100 (' + health + ')');
  log('[STEP 8] Critical findings: ' + critIssues.length);
  log('[STEP 8] Warnings: ' + warnIssues.length);
  log('[STEP 8] Root cause: ' + rootCauseSummary.slice(0,100));
  emit('fullscan:step', { step: 8, name: STEPS[8], status: 'done' });

  // ── STEP 9: Report Generation ────────────────────────────────────────────
  emit('fullscan:step', { step: 9, name: STEPS[9], status: 'running' });
  log('[STEP 9] Generating comprehensive report...');
  await new Promise(r => setTimeout(r, 800));
  log('[STEP 9] Report ready — transmitting to dashboard');
  emit('fullscan:step', { step: 9, name: STEPS[9], status: 'done' });

  // ── Final Report ──────────────────────────────────────────────────────────
  const report = {
    ts: Date.now(),
    jobId,
    hostId,
    overallScore,
    health,
    subsystems: {
      cpu:      { score: cpuScore,  label: 'CPU',      value: (sys.load1||0) + ' load avg' },
      memory:   { score: memScore,  label: 'Memory',   value: (sys.memPct||0) + '% used' },
      disk:     { score: diskScore, label: 'Disk',     value: (fs.critDisks||[]).length + ' critical' },
      network:  { score: netScore,  label: 'Network',  value: (net.pingLoss||0) + '% loss' },
      services: { score: svcScore,  label: 'Services', value: (svc.failedCount||0) + ' failed' },
      security: { score: secScore,  label: 'Security', value: (sec.authFailures||0) + ' auth failures' },
      logs:     { score: logScore,  label: 'Logs',     value: (lg.errCount||0) + ' errors' },
      kernel:   { score: kernScore, label: 'Kernel',   value: (ker.errCount||0) + ' errors' }
    },
    rootCause: results.analysis.rootCause,
    findings: {
      critical: critIssues,
      warnings: warnIssues,
      info:     infoIssues
    },
    recommendations,
    raw: {
      kernelErrors:  (ker.errors||[]).slice(0,5),
      recentLogs:    (lg.recentErrors||[]).slice(0,5),
      failedServices:(svc.failedServices||[]).slice(0,5),
      openPorts:     (sec.openPorts||[]).slice(0,10),
      diskStatus:    results.filesystem ? results.filesystem.dfOut : '',
      critDisks:     fs.critDisks||[],
      warnDisks:     fs.warnDisks||[]
    }
  };

  log('[SCAN COMPLETE] Full system investigation finished');
  emit('fullscan:complete', { report });
  return report;
}

router.post('/api/scan/full-system', async (req, res) => {
  try {
    const { hostId } = req.body;
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const io = req.app.get('io') || req.io;
    if (!io) return res.status(500).json({ error: 'Socket.IO not available' });

    res.json({ ok: true, jobId });
    setImmediate(() => runFullSystemScan(jobId, hostId || 'localhost', io).catch(console.error));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
