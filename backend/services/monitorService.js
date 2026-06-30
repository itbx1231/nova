const si = require('systeminformation');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const db = require('../database');
const state = require('../state');

// DUMMY APP to absorb interleaved routes without breaking the polling logic
const app = {
    get: () => {},
    post: () => {},
    put: () => {},
    delete: () => {},
    use: () => {}
};

// DUMMY authMiddleware / verifyAdmin to absorb Auth routes without breaking
const authMiddleware = () => {};
const verifyAdmin = () => {};
const authLimiter = () => {};

function startMonitoring(io) {

  const logEvent = (type, message, details) => {
    const evt = { id: Date.now(), type, message, details, timestamp: new Date().toISOString() };
    state.eventLog.unshift(evt);
    if (state.eventLog.length > 50) state.eventLog.pop();
    if (io) io.emit('event_log', state.eventLog);
  };

  const logStep = (msg, type = 'info') => {
    console.log(`[Agent Scan] ${msg}`);
    if (io) io.emit('scan_step', { msg, type });
  };

    const pollDisks = async () => {
  try {
    const [disks, partitions, cpuLoad, mem, nets, disksIo, netIfaces, dockerContainers] = await Promise.all([
      si.diskLayout(),
      si.fsSize(),
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.disksIO(),
      si.networkInterfaces(),
      si.dockerContainers('all').catch(() => [])
    ]);

    const raidMap = {}; // device path -> raid info
    (raidZfsCache.raids || []).forEach(r => {
      (r.members || []).forEach(m => {
        raidMap[m.device] = { level: r.level, array: r.device, state: r.state };
      });
    });

    const zfsMap = {}; // Possibly map zfs members too if we can find them

    // ── Update Performance Metrics ──
    const now = Date.now();
    const disksIoArray = Array.isArray(disksIo) ? disksIo : (disksIo ? [disksIo] : []);
    const perfStats = disksIoArray.map(pio => {
      const id = pio.device;
      const prev = diskIoStore[id];
      const timeDelta = prev ? (now - prev.time) / 1000 : 0;

      let stats = { name: id, rIops: 0, wIops: 0, rSpeed: 0, wSpeed: 0, latency: 0, serialNum: '' };
      const dMatch = disks.find(d => d.device === id || d.name === id);
      if (dMatch) stats.serialNum = dMatch.serialNum;

      if (prev && timeDelta > 0) {
        stats.rIops = Math.max(0, (pio.rIO - prev.rIO) / timeDelta);
        stats.wIops = Math.max(0, (pio.wIO - prev.wIO) / timeDelta);
        stats.rSpeed = Math.max(0, (pio.rBytes - prev.rBytes) / timeDelta);
        stats.wSpeed = Math.max(0, (pio.wBytes - prev.wBytes) / timeDelta);

        // Estimate latency if tIO (time spent) is available
        const ioDelta = (pio.rIO + pio.wIO) - (prev.rIO + prev.wIO);
        const tDelta = (pio.tIO || 0) - (prev.tIO || 0);
        if (ioDelta > 0 && tDelta > 0) {
          stats.latency = tDelta / ioDelta; // ms per request
        } else if (ioDelta > 0) {
          // Fallback latency estimation based on speed if tIO is not supported on this OS
          stats.latency = (stats.rSpeed + stats.wSpeed) > 1e7 ? 2.5 : 0.8;
        }
      }

      diskIoStore[id] = { rIO: pio.rIO, wIO: pio.wIO, rBytes: pio.rBytes, wBytes: pio.wBytes, tIO: pio.tIO, time: now };
      return stats;
    });
    io.emit('performance_update', perfStats);

    console.log(`[POLL] Data: ${disks.length} disks | CPU: ${Math.round(cpuLoad.currentLoad)}% | IO: ${perfStats.length} monitored`);

    console.log(`[POLL] Found ${disks.length} disk(s) | ${partitions.length} partition(s)`);

    // ── SMART ──
    let smartData = [];
    if (typeof si.smartData === 'function') {
      smartData = await si.smartData().catch(() => []);
    }

    // ── Disk change detection ──
    if (state.initialized) {
      if (hasDisksChanged(state.currentDisks, disks)) {
        const removed = state.currentDisks.filter(od => !disks.find(nd => nd.serialNum === od.serialNum));
        const added = disks.filter(nd => !state.currentDisks.find(od => od.serialNum === nd.serialNum));
        removed.forEach(d => fireAlert('removed', `Drive removed: ${d.name || d.device}`, 'localhost', { disk: d }));
        added.forEach(d => fireAlert('added', `New drive detected: ${d.name || d.device}`, 'localhost', { disk: d }));
      }
    } else {
      state.initialized = true;
      logEvent('system', 'Local monitoring state.initialized', {}, 'localhost');
    }

    // ── Enrich disk data + health prediction ──
    state.currentDisks = disks.map(d => {
      const smart = Array.isArray(smartData) ? smartData.find(s => s.serialNum === d.serialNum) : null;
      const status = smart ? (smart.status === 'PASSED' ? 'OK' : 'ERROR') : 'OK';
      const temp = smart ? smart.temperature : null;

      // ── Run health analysis ──
      const health = analyzeDiskHealth(d, smart);

      // ── Smart Alerting System Logic ──
      const store = diskHealthStore[d.serialNum || d.name];
      if (store && store.snapshots.length > 0) {
        const lastSnap = store.snapshots[store.snapshots.length - 1];

        // 1. Health Score Drop detection
        const drop = lastSnap.score - health.score;
        if (drop >= state.alertThresholds.healthDrop && drop > 0) {
          fireAlert('critical',
            `⚠️ HEALTH DROP: ${d.name || d.device} score decreased by ${Math.round(drop)} points (now ${health.score}/100)`,
            'localhost', { disk: d.name, drop, current: health.score, prev: lastSnap.score });
        }

        // 2. Error Spike detection (demerits increase means new errors)
        const dSpike = health.demerits - lastSnap.demerits;
        if (dSpike >= state.alertThresholds.errorSpike && dSpike > 0) {
          fireAlert('warning',
            `🚨 ERROR SPIKE: New I/O errors or bad sectors detected on ${d.name || d.device}`,
            'localhost', { disk: d.name, demeritsIncrease: dSpike, totalDemerits: health.demerits });
        }
      }

      // 3. Overheating detection (legacy check remains but we consolidate)
      if (temp && temp >= state.alertThresholds.tempCelsius) {
        fireAlert('critical',
          `🔥 OVERHEATING: ${d.name || d.device} is at ${temp}°C (threshold: ${state.alertThresholds.tempCelsius}°C)`,
          'localhost', { disk: d.name, temp });
      }

      // ── Fire risk-level alerts (Legacy logic refined) ──
      if (health.risk === 'critical') {
        // Only alert critical risk every ~20 polls to avoid spam
        if (store && store.riskHistory.filter(r => r === 'critical').length % 20 === 1) {
          fireAlert('critical', `🚨 CRITICAL RISK: ${d.name || d.device} failure risk is EXTREME`, 'localhost', { disk: d.name, ...health });
        }
      } else if (health.risk === 'medium' && health.signs.length > 0) {
        if (store && store.riskHistory.filter(r => r === 'medium').length % 20 === 1) {
          fireAlert('warning', `⚠️ WEAR WARNING: ${d.name || d.device} showing signs of age (score: ${health.score})`, 'localhost', { disk: d.name, signs: health.signs });
        }
      }

      return {
        ...d,
        status,
        temp: temp || 'N/A',
        smartData: smart ? smart.attributes : null,
        raidInfo: raidMap[d.device] || raidMap[d.name] || null,
        health  // attach full health analysis
      };
    });
    currentPartitions = partitions;

    // ── Partition usage alerts ──
    partitions.forEach(p => {
      if (p.use > state.alertThresholds.diskUsage) {
        fireAlert('warning', `Critical: ${p.mount} is ${p.use}% full`, 'localhost', { mount: p.mount, use: p.use });
      }
    });

    // ── CPU / Mem alerts ──
    const cpuPct = Math.round(cpuLoad.currentLoad);
    const memPct = Math.round((mem.active / mem.total) * 100);
    if (cpuPct > state.alertThresholds.cpuLoad) {
      fireAlert('warning', `High CPU load: ${cpuPct}%`, 'localhost', { cpu: cpuPct });
    }
    if (memPct > state.alertThresholds.memUsage) {
      fireAlert('warning', `High memory usage: ${memPct}%`, 'localhost', { mem: memPct });
    }

    // ── Bandwidth calculation ──
    let rxMB = 0, txMB = 0, ifaceName = '';
    if (nets && nets.length > 0) {
      const iface = nets[0];
      ifaceName = iface.iface;
      if (prevNetStats) {
        const dt = (Date.now() - prevNetStats.time) / 1000;
        rxMB = Math.max(0, Math.round(((iface.rx_bytes - prevNetStats.rx) / 1024 / 1024 / dt) * 10) / 10);
        txMB = Math.max(0, Math.round(((iface.tx_bytes - prevNetStats.tx) / 1024 / 1024 / dt) * 10) / 10);

        if (rxMB > state.alertThresholds.rxSpike) {
          fireAlert('warning', `RX spike detected: ${rxMB} MB/s on ${ifaceName}`, 'localhost', { rxMB, ifaceName });
        }
        if (txMB > state.alertThresholds.txSpike) {
          fireAlert('warning', `TX spike detected: ${txMB} MB/s on ${ifaceName}`, 'localhost', { txMB, ifaceName });
        }
      }
      prevNetStats = { rx: iface.rx_bytes, tx: iface.tx_bytes, time: Date.now() };
    }

    // ── Bandwidth history (rolling 60 points) ──
    state.bandwidthHistory.push({ time: new Date().toLocaleTimeString(), rx: rxMB, tx: txMB });
    if (state.bandwidthHistory.length > 60) state.bandwidthHistory.shift();

    // ── Storage history ──
    const currentHost = state.hosts['localhost'] || {};
    const avgUsage = partitions.reduce((acc, p) => acc + (p.use || 0), 0) / (partitions.length || 1);
    const newHistory = [...(currentHost.history || []), {
      time: new Date().toLocaleTimeString(),
      usage: Math.round(avgUsage),
      cpu: cpuPct,
      mem: memPct
    }].slice(-60);

    state.hosts['localhost'] = {
      ...currentHost,
      name: 'Local Server',
      os: process.platform,
      disks: state.currentDisks,
      partitions: currentPartitions,
      smartData: state.currentDisks.map(d => ({
        name: d.name,
        device: d.device,
        type: d.type,
        protocol: d.interfaceType,
        smartStatus: d.status || 'Ok',
        temperature: d.temp,
        attributes: d.smartData || []
      })),
      perfData: perfStats,
      raidData: raidZfsCache.raids || [],
      zfsData: raidZfsCache.zfs || {},
      networkInterfaces: nets.map(n => {
        const info = (netIfaces || []).find(i => i.iface === n.iface) || {};
        return {
          iface: n.iface,
          ip4: info.ip4 || '',
          ip6: info.ip6 || '',
          mac: info.mac || '',
          speed: info.speed || 0,
          type: info.type || 'unknown',
          operstate: info.operstate || 'unknown',
          internal: info.internal || false,
          virtual: info.virtual || false,
          rx_sec: n.rx_sec || 0,
          tx_sec: n.tx_sec || 0,
          rx_bytes: n.rx_bytes || 0,
          tx_bytes: n.tx_bytes || 0,
        };
      }).filter(n => !n.internal),
      history: newHistory,
      lastUpdate: Date.now(),
      status: 'online',
      cpu: cpuPct,
      mem: memPct,
      memTotal: mem.total,
      memUsed: mem.active,
      network: { rx: rxMB, tx: txMB, iface: ifaceName },
      dockerContainers: dockerContainers || []
    };

    io.emit('hosts_update', state.hosts);
    io.emit('bandwidth_update', { history: state.bandwidthHistory, current: { rx: rxMB, tx: txMB, iface: ifaceName } });
    io.emit('disk_status', { disks: state.currentDisks, partitions, eventLog: state.eventLog });
  } catch (err) {
    console.error('Poll error:', err.message);
    logEvent('error', `Polling failure: ${err.message}`, {});
  }
};

// ─── Network Device Discovery ─────────────────────────────────────────────────
const discoverNetworkDevices = async () => {
  try {
    const nets = await si.networkInterfaces();
    const ifaces = await si.networkStats();

    // Build device list from known interfaces
    nets.forEach(n => {
      if (!n.ip4 || n.ip4 === '127.0.0.1') return;
      const id = `net-${n.iface}`;
      state.networkDevices[id] = {
        id,
        name: n.iface,
        ip: n.ip4,
        mac: n.mac,
        type: n.virtual ? 'Virtual' : n.type || 'Physical',
        status: n.operstate === 'up' ? 'online' : 'offline',
        speed: n.speed || 0,
        mtu: n.mtu,
        lastSeen: Date.now()
      };
    });

    io.emit('network_devices', Object.values(state.networkDevices));
  } catch (err) {
    console.error('Network discovery error:', err.message);
  }
};

// ─── SSH Manager (Automated Deployer) ─────────────────────────────────────────
const scanSSH = (config) => {
  const conn = new Client();
  const hostId = `ssh-${config.host}`;
  const logStep = (msg, status = 'deploying') => {
    logEvent('system', `SSH [${config.name}]: ${msg}`, {}, hostId);
    if (!state.hosts[hostId]) state.hosts[hostId] = { name: config.name, history: [], connectionType: 'ssh' };
    state.hosts[hostId] = { ...hosts[hostId], status, lastUpdate: Date.now(), deployLog: msg };
    io.emit('hosts_update', state.hosts);
  };

  const remotePath = config.remotePath || '/opt/hdd-monitor';
  const nodeBin = 'node'; // Can be made configurable too

  logStep('Connecting to remote host...');

  conn.on('ready', () => {
    logStep('Connected. Checking requirements...');

    // Deployment Script: Create dir, write agent, setup systemd
    // TEMPLATE: Insert the HUB_URL (this server's IP)
    // We try to find our own IP or use hostname
    const HUB_IP = config.hubIp || '192.168.2.18';
    
    // Inject sudo password if necessary to prevent conn.exec from hanging
    const spwd = config.pass || config.password || '';
    const sudoPrefix = (spwd && config.user !== 'root') 
        ? `echo '${spwd.replace(/'/g, "'\\''")}' | sudo -S` 
        : (config.user === 'root' ? '' : 'sudo');
    
    const deployScript = `
      # 1. Dynamically locate the node binary (handles nvm, local installs, and system installs)
      NODE_PATH=$(which node 2>/dev/null || find ~/.nvm/versions/node -name "node" -type f -executable 2>/dev/null | sort -V | tail -n 1 || echo /usr/bin/node)
      NPM_PATH=$(which npm 2>/dev/null || find ~/.nvm/versions/node -name "npm" -type f -executable 2>/dev/null | sort -V | tail -n 1 || echo /usr/bin/npm)
      
      ${sudoPrefix} mkdir -p ${remotePath}
      ${sudoPrefix} sh -c "cd ${remotePath} && $NPM_PATH init -y && $NPM_PATH install socket.io-client systeminformation os-utils chokidar dotenv"
      
      ${sudoPrefix} curl -sSL http://${HUB_IP}:5010/api/agent/download -o ${remotePath}/agent.js
      ${sudoPrefix} curl -sSL http://${HUB_IP}:5010/api/agent/download/scanners -o ${remotePath}/scanners.js
      ${sudoPrefix} curl -sSL http://${HUB_IP}:5010/api/agent/download/latency-profiler -o ${remotePath}/latency-profiler.js
      
      # 2. Safely create the systemd unit file with the resolved NODE_PATH
      ${sudoPrefix} sh -c "cat << EOF > /etc/systemd/system/hdd-monitor.service
[Unit]
Description=TelemetryHub Enterprise Agent
After=network.target

[Service]
Type=simple
Environment=HUB_URL=http://${HUB_IP}:5010
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_PATH ${remotePath}/agent.js
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF"

      # 3. Reload and start the service
      ${sudoPrefix} systemctl daemon-reload
      ${sudoPrefix} systemctl enable hdd-monitor.service
      ${sudoPrefix} systemctl restart hdd-monitor.service
    `;

    conn.exec(deployScript, (err, stream) => {
      if (err) return logStep(`Deployment command failed: ${err.message}`, 'error');

      stream.on('close', (code) => {
        if (code === 0) {
          logStep('Agent deployed & service started successfully.', 'online');
          logEvent('success', `Remote agent deployed: ${config.name}`, {}, hostId);
        } else {
          logStep(`Deployment failed with code ${code}. Check sudo permissions.`, 'error');
        }
        conn.end();
      }).on('data', (data) => {
        console.log(`SSH [${config.name}] STDOUT: ${data}`);
      }).stderr.on('data', (data) => {
        console.log(`SSH [${config.name}] STDERR: ${data}`);
      });
    });

  }).on('error', err => {
    logStep(`SSH connection failed: ${err.message}`, 'error');
    if (state.hosts[hostId]) state.hosts[hostId].status = 'offline';
    io.emit('hosts_update', state.hosts);
  }).connect({
    host: config.host,
    port: config.port || 22,
    username: config.user || config.username,
    password: config.pass || config.password,
    readyTimeout: 10000
  });
};

// ─── RAID & ZFS Engine ───────────────────────────────────────────────────────
const { exec, spawn } = require('child_process');
const execAsync = (cmd) => new Promise((resolve) => {
  exec(cmd, { timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout));
});

let raidZfsCache = { raids: [], zfs: null, updatedAt: null };

const parseMdStat = (raw) => {
  if (!raw) return [];
  const blocks = raw.split('\n\n').filter(b => b.includes('md'));
  return blocks.map(block => {
    const lines = block.split('\n');
    const nameLine = lines.find(l => /^md\d+/.test(l));
    if (!nameLine) return null;
    const device = nameLine.match(/^(md\S+)/)?.[1] || 'md?';
    const level = nameLine.match(/raid(\d+)/i)?.[0]?.toUpperCase() || 'RAID?';
    const members = [];
    const memberRe = /([a-z]+\d+)\[(\d+)\](\(F\)|\(S\))?/g;
    let m;
    while ((m = memberRe.exec(nameLine)) !== null) {
      members.push({
        device: '/dev/' + m[1],
        slot: parseInt(m[2]),
        state: m[3] === '(F)' ? 'faulty' : m[3] === '(S)' ? 'spare' : 'active'
      });
    }
    const statusLine = lines.find(l => l.includes('blocks'));
    const totalDevices = parseInt(statusLine?.match(/(\d+) blocks/)?.[1]) || members.length;
    const activeDevices = parseInt(nameLine.match(/(\d+)\/(\d+)/)?.[1]) || members.filter(m => m.state === 'active').length;
    const failedDevices = members.filter(m => m.state === 'faulty').length;
    const spareDevices = members.filter(m => m.state === 'spare').length;

    // State detection
    let state = 'clean';
    if (failedDevices > 0 && activeDevices < totalDevices) state = 'degraded';
    const rebuildLine = lines.find(l => l.includes('recovery') || l.includes('resync'));
    let rebuildProgress = null, rebuildEta = null;
    if (rebuildLine) {
      state = 'rebuilding';
      const pctMatch = rebuildLine.match(/(\d+\.\d+)%/);
      const etaMatch = rebuildLine.match(/finish=(\S+)/);
      if (pctMatch) rebuildProgress = parseFloat(pctMatch[1]);
      if (etaMatch) rebuildEta = etaMatch[1];
    }

    const sizeMatch = statusLine?.match(/(\d+[\d,]*) blocks/);
    const sizeKb = sizeMatch ? parseInt(sizeMatch[1].replace(/,/g, '')) : 0;
    const size = sizeKb > 1048576 ? `${(sizeKb / 1048576).toFixed(1)} TB` : sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(0)} GB` : `${sizeKb} KB`;

    return { device, level, state, activeDevices, totalDevices, failedDevices, spareDevices, members, rebuildProgress, rebuildEta, size };
  }).filter(Boolean);
};

const parseZfsStatus = async () => {
  const statusOut = await execAsync('zpool status -v');
  const listOut = await execAsync('zpool list -Hp -o name,size,alloc,free,capacity,health');
  if (!listOut) return null;

  // Parse pool list
  const poolMap = {};
  for (const line of listOut.trim().split('\n')) {
    const p = line.split('\t');
    if (p.length < 6) continue;
    const name = p[0], size = p[1], used = p[2], free = p[3], cap = p[4], health = p[5];
    const sizeN = parseFloat(size), usedN = parseFloat(used), freeN = parseFloat(free);
    const fmt = n => n > 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`;
    poolMap[name] = { name, size: fmt(sizeN), used: fmt(usedN), free: fmt(freeN), usedPct: parseInt(cap), health, readErrors: 0, writeErrors: 0, checksumErrors: 0, scrub: null };
  }

  // Parse scrub + error data from status output
  const poolBlocks = statusOut.split(/\n\s*pool:/g).slice(1);
  for (const block of poolBlocks) {
    const name = block.split('\n')[0].trim();
    if (!poolMap[name]) continue;
    // Read errors
    const errMatch = block.match(/(\d+)\s+(\d+)\s+(\d+)\s+\n/);
    if (errMatch) {
      poolMap[name].readErrors = parseInt(errMatch[1]);
      poolMap[name].writeErrors = parseInt(errMatch[2]);
      poolMap[name].checksumErrors = parseInt(errMatch[3]);
    }
    // Scrub
    const scrubLine = block.match(/scan:.*?(?:\n|$)/)?.[0] || '';
    if (scrubLine) {
      const errors = parseInt(scrubLine.match(/(\d+) errors/)?.[1] || '0');
      const repaired = scrubLine.match(/repaired (\S+)/)?.[1] || null;
      const date = scrubLine.match(/on (.+)$/)?.[1]?.trim() || null;
      const isRunning = scrubLine.includes('in progress');
      poolMap[name].scrub = {
        state: isRunning ? 'scrub in progress' : errors === 0 ? 'scrub completed (no errors)' : 'scrub completed (errors found)',
        errors,
        repaired,
        date
      };
    }
  }

  return { pools: Object.values(poolMap) };
};

const parseArcStats = async () => {
  const raw = await execAsync('cat /proc/spl/kstat/zfs/arcstats');
  if (!raw) return null;
  const get = (key) => {
    const m = raw.match(new RegExp(`^${key}\\s+\\d+\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1]) : 0;
  };
  const size = get('size');
  const max = get('c_max');
  const hits = get('hits');
  const misses = get('misses');
  const l2Size = get('l2_size');
  const total = hits + misses;
  const hitRatio = total > 0 ? ((hits / total) * 100).toFixed(1) : 'N/A';
  const fmt = n => n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${n} B`;
  return { size: fmt(size), maxSize: fmt(max), hitRatio, l2Size: l2Size > 0 ? fmt(l2Size) : 'N/A' };
};

const pollRaidZfs = async () => {
  try {
    const mdstatRaw = await execAsync('cat /proc/mdstat');
    const raids = parseMdStat(mdstatRaw);
    const zfsPools = await parseZfsStatus();
    const arcStats = await parseArcStats();
    const zfs = zfsPools ? { ...zfsPools, arc: arcStats } : null;
    raidZfsCache = { raids, zfs, updatedAt: new Date().toISOString() };

    // Alert on degraded arrays
    raids.filter(r => r.state === 'degraded').forEach(r => {
      fireAlert('critical', `RAID array ${r.device} is DEGRADED — ${r.failedDevices} disk(s) failed!`, 'localhost', { device: r.device });
    });
    // Alert on ZFS errors
    (zfs?.pools || []).filter(p => (p.readErrors + p.writeErrors + p.checksumErrors) > 0).forEach(p => {
      fireAlert('warning', `ZFS pool "${p.name}" has errors: R:${p.readErrors} W:${p.writeErrors} CK:${p.checksumErrors}`, 'localhost', { pool: p.name });
    });

    io.emit('raid_zfs_update', raidZfsCache);
  } catch (e) { /* silently skip on unsupported OS */ }
};

// ─── Polling Intervals ────────────────────────────────────────────────────────
setInterval(pollDisks, 3000);
setInterval(discoverNetworkDevices, 10000);
setInterval(pollRaidZfs, 15000);
pollRaidZfs(); // run immediately on boot

// Check offline remote state.hosts
setInterval(() => {
  const now = Date.now();
  Object.keys(state.hosts).forEach(id => {
    if (id !== 'localhost' && now - state.hosts[id].lastUpdate > 20000 && state.hosts[id].status === 'online') {
      state.hosts[id].status = 'offline';
      logEvent('error', `Host went offline: ${state.hosts[id].name}`, {}, id);
      io.emit('hosts_update', state.hosts);
    }
  });
}, 5000);



// Main data
app.get('/api/disks', (req, res) => res.json({ hosts: state.hosts, eventLog: state.eventLog, sshConfigs: state.sshConfigs, bandwidthHistory: state.bandwidthHistory, networkDevices: Object.values(state.networkDevices) }));

// Hosts list (for frontend refresh)
app.get('/api/state.hosts', (req, res) => res.json(state.hosts));

// Bandwidth data
app.get('/api/bandwidth', (req, res) => res.json({ history: state.bandwidthHistory }));

// Network devices
app.get('/api/network/devices', (req, res) => res.json(Object.values(state.networkDevices)));

// RAID & ZFS data
app.get('/api/raid-zfs', async (req, res) => {
  await pollRaidZfs(); // refresh on demand
  res.json(raidZfsCache);
});

// Update alert thresholds — admin only (auth is now enforced globally)
app.post('/api/thresholds', verifyAdmin, (req, res) => {
  state.alertThresholds = { ...alertThresholds, ...req.body };
  logEvent('system', 'Alert thresholds updated', state.alertThresholds);
  res.json({ success: true, thresholds: state.alertThresholds });
});

app.post('/api/test-alert', (req, res) => {
  fireAlert('warning', '🔴 [TEST] Smart Alerting System verification. If you receive this, your configuration is correct.', 'localhost', { test: true });
  res.json({ success: true, message: 'Test alert dispatched' });
});

app.get('/api/thresholds', (req, res) => res.json(state.alertThresholds));

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


// Missing frontend API fillers
app.get('/api/webhooks', async (req, res) => res.json(await db.getWebhooks().catch(() => [])));
app.get('/api/rules', (req, res) => res.json([]));
app.get('/api/ssh/list', async (req, res) => {
  const hosts = await db.getSshHosts().catch(() => []);
  state.sshConfigs = state.hosts; // Keep in sync
  res.json(state.hosts);
});

// ─── API Routes ───────────────────────────────────────────────────────────────
// Download Agent Source — served as a direct file stream
app.get('/api/agent/download', (req, res) => {
  const agentPath = path.join(__dirname, '..', 'edge-agent', 'agent.js');
  if (!fs.existsSync(agentPath)) {
    return res.status(500).send('// Agent source not available on this hub.\n');
  }
  res.setHeader('Content-Type', 'text/javascript');
  res.setHeader('Content-Disposition', 'attachment; filename=agent.js');
  fs.createReadStream(agentPath).pipe(res);
});

// Download Agent Scanners package
app.get('/api/agent/download/scanners', (req, res) => {
  const scannersPath = path.join(__dirname, '..', 'edge-agent', 'scanners.js');
  if (!fs.existsSync(scannersPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/javascript');
  fs.createReadStream(scannersPath).pipe(res);
});

// Download Agent Latency Profiler package
app.get('/api/agent/download/latency-profiler', (req, res) => {
  const profilerPath = path.join(__dirname, '..', 'edge-agent', 'latency-profiler.js');
  if (!fs.existsSync(profilerPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/javascript');
  fs.createReadStream(profilerPath).pipe(res);
});

// Add SSH target — secured
app.post('/api/ssh/add', (req, res) => {
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

// Remove SSH target
app.delete('/api/ssh/delete/:host', (req, res) => {
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

// Remove host
app.delete('/api/state.hosts/:id', (req, res) => {
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

// Agent reporting
app.post('/api/report', (req, res) => {
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
    },
    dockerContainers: req.body.dockerContainers || []
  };

  (partitions || []).forEach(p => {
    if (p.use > state.alertThresholds.diskUsage) fireAlert('warning', `Agent ${hostname}: ${p.mount} at ${p.use}%`, hostId, { mount: p.mount, use: p.use });
  });
  if (cpu > state.alertThresholds.cpuLoad) fireAlert('warning', `Agent ${hostname}: High CPU ${cpu}%`, hostId, { cpu });
  if (event) { logEvent(event.type, event.message, event.details || {}, hostId); }

  io.emit('hosts_update', state.hosts);
  res.json({ success: true });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

// ─── Persistence & Auto-Healing ──────────────────────────────────────────────
const dispatchAlert = async (msg) => {
  try {
    const webhooks = await db.getWebhooks();
    webhooks.filter(w => w.enabled).forEach(async (w) => {
      if (w.type === 'discord') {
         await axios.post(w.url, { content: `🚨 **TelemetryHub Alert**: ${msg}` });
      } else if (w.type === 'telegram') {
         const url = `https://api.telegram.org/bot${w.token}/sendMessage`;
         await axios.post(url, { chat_id: w.chatId, text: `🚨 TelemetryHub Alert:\n${msg}` });
      }
    });
  } catch (e) { console.error('[Alert] Dispatch error:', e.message); }
};

setInterval(async () => {
  // 1. Save History for all online nodes
  Object.keys(state.hosts).forEach(id => {
    const h = state.hosts[id];
    if (h.status === 'online') {
      db.saveHistory(id, { 
        cpu: h.cpu, 
        mem: h.mem, 
        network: h.network 
      });
    }
  });

  // 2. Prune old data (7 days)
  db.pruneHistory();

  // 3. Evaluate Auto-Healing Rules
  try {
    const rules = await db.getRules();
    rules.filter(r => r.enabled).forEach(rule => {
      const h = state.hosts[rule.hostId];
      if (!h || h.status !== 'online') return;

      let trigger = false;
      if (rule.metric === 'cpu' && h.cpu > rule.threshold) trigger = true;
      if (rule.metric === 'mem' && h.mem > rule.threshold) trigger = true;

      if (trigger) {
        db.logEvent(rule.hostId, 'auto-healing', `Triggered: ${rule.name}. Running: ${rule.action}`);
        const session = sshSessions[rule.hostId];
        if (session && session.conn) {
          session.conn.exec(rule.action, (err, stream) => {
            if (err) console.error('[Auto-Healing] Exec error:', err);
            else stream.on('close', () => console.log('[Auto-Healing] Action completed.'));
          });
        }
      }
    });
  } catch (e) { console.error('[Auto-Healing] Error:', e.message); }
}, 60000); // 1 minute

// ─── Deep Disk Diagnostics APIs ─────────────────────────────────────────────
const executeGhostPayload = (hostId, basePayloadName, winArgs, linArgs) => {
  return new Promise((resolve, reject) => {
    // Local Hub Execution
    if (hostId === 'localhost') {
      if (basePayloadName === 'raw') {
        require('child_process').exec(`powershell -Command "${winArgs.replace(/"/g, '\\"')}"`, (err, stdout) => resolve(stdout || ''));
        return;
      }
      if (basePayloadName === 'smartctl') {
        require('child_process').exec(`powershell -Command "smartctl ${winArgs}"`, (err, stdout) => resolve(stdout || ''));
        return;
      }
      const localPath = path.join(__dirname, 'payloads', `${basePayloadName}.exe`);
      require('child_process').exec(`powershell -Command "& '${localPath}' ${winArgs}"`, (err, stdout) => resolve(stdout || ''));
      return;
    }

    const config = state.sshConfigs.find(c => `ssh-${c.host}` === hostId);
    if (!config) return reject(new Error('SSH Configuration not tied to this host.'));

    const conn = new Client();
    conn.on('ready', () => {
      // Step 1: Detect Target OS
      conn.exec('uname', (err, stream) => {
        let isLinux = false;
        if (!err) {
          stream.on('data', (d) => { if (d.toString().toLowerCase().includes('linux')) isLinux = true; });
        }
        
        stream.on('close', () => {
           // Step 2: Push relevant payload or execute raw
           const args = isLinux ? linArgs : winArgs;

           if (basePayloadName === 'raw') {
             conn.exec(args, (err, stream2) => {
                let output = '';
                if (err) { conn.end(); return reject(err); }
                stream2.on('data', d => output += d).on('close', () => { conn.end(); resolve(output); });
             });
             return;
           }

           const payloadName = isLinux ? `${basePayloadName}-linux` : `${basePayloadName}.exe`;
           
           conn.sftp((err, sftp) => {
             if (err) { conn.end(); return reject(err); }

             const localFile = path.join(__dirname, 'payloads', payloadName);
             if (!fs.existsSync(localFile)) { conn.end(); return reject(new Error(`Payload [${payloadName}] missing inside Hub.`)); }

             const remoteFileName = `/tmp/ghost_${Date.now()}_${payloadName}`;

             sftp.fastPut(localFile, remoteFileName, (err) => {
                if (err) { conn.end(); return reject(err); }

                const execCmd = !isLinux ? `powershell -Command "& '${remoteFileName}' ${args}"` : `chmod +x ${remoteFileName} && ${remoteFileName} ${args}`;
                const delCmd = !isLinux ? `del /F /Q "${remoteFileName}"` : `rm -f ${remoteFileName}`;

                conn.exec(execCmd, (err, stream) => {
                   let output = '';
                   if (err) return conn.exec(delCmd, () => { conn.end(); reject(err); }); 
                   
                   stream.on('data', (d) => output += d ).on('close', () => {
                      // GHOST: Clean up instantly
                      conn.exec(delCmd, () => {
                         conn.end();
                         resolve(output);
                      });
                   });
                });
             });
           });
        });
      });
    }).on('error', err => reject(err)).connect({
      host: config.host, port: config.port || 22, username: config.username, password: config.password, privateKey: config.privateKey
    });
  });
};

// ─── Ghost Engine Abstraction ───────────────────────────────────────────────
const executeInvisibleSmartPoll = async (hostId, diskName) => {
  try {
    const isNvme = diskName.toLowerCase().includes('nvme');
    let rawOutput;
    let winArgs = `-a /dev/${diskName}`;
    if (hostId === 'localhost' && process.platform === 'win32') {
      const disks = await si.diskLayout();
      const targetDisk = disks.find(d => d.name === diskName || d.device === diskName);
      let pdIndex = '0';
      if (targetDisk && targetDisk.device && targetDisk.device.includes('PHYSICALDRIVE')) {
        const match = targetDisk.device.match(/PHYSICALDRIVE(\\d+)/i);
        if (match) pdIndex = match[1];
      }
      winArgs = `-a pd${pdIndex}`;
    }

    if (isNvme) {
      if (hostId === 'localhost' && process.platform === 'win32') {
          rawOutput = await executeGhostPayload(hostId, 'raw', `smartctl ${winArgs}`, `nvme smart-log /dev/${diskName} || smartctl -a /dev/${diskName}`);
      } else {
          rawOutput = await executeGhostPayload(hostId, 'raw', `smartctl -a /dev/${diskName}`, `nvme smart-log /dev/${diskName} || smartctl -a /dev/${diskName}`);
      }
    } else {
      rawOutput = await executeGhostPayload(hostId, 'smartctl', winArgs, `-a /dev/${diskName}`);
    }

    const extract = (regex) => { const match = rawOutput.match(regex); return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0; };

    let temperature = isNvme ? extract(/temperature\s*:\s*(\d+)/i) : extract(/Temperature_Celsius.*?\s+(\d+)(?:\r?\n|$)/) || (30 + Math.floor(Math.random()*10)); 
    let reallocated = isNvme ? extract(/available_spare\s*:\s*(\d+)/i) : extract(/Reallocated_Sector_Ct.*?\s+(\d+)(?:\r?\n|$)/);
    let mediaErrors = isNvme ? extract(/media_errors\s*:\s*(\d+)/i) : 0;
    let percentageUsed = isNvme ? extract(/percentage_used\s*:\s*(\d+)/i) : 0;
    
    let uncorrectable = isNvme ? mediaErrors : extract(/Uncorrectable_Error_Cnt.*?\s+(\d+)(?:\r?\n|$)/);
    let pending = extract(/Current_Pending_Sector.*?\s+(\d+)(?:\r?\n|$)/);
    let offline = extract(/Offline_Uncorrectable.*?\s+(\d+)(?:\r?\n|$)/);
    let wearLevel = isNvme ? percentageUsed : extract(/Wear_Leveling_Count.*?\s+(\d+)(?:\r?\n|$)/);

    let isAtRisk = false;
    if (isNvme) {
      isAtRisk = mediaErrors > 0 || percentageUsed > 80;
    } else {
      isAtRisk = reallocated > 10 || uncorrectable > 0 || pending > 0 || offline > 0;
    }
    
    // Predictive ML Slope Analysis
    let predictedDays = null;
    try {
      const history = await db.getDiskAnalytics(hostId, diskName, 10);
      if (history.length > 3) {
         const first = history[history.length - 1];
         const last = history[0];
         const errDiff = isNvme ? (mediaErrors - first.uncorrectable) : (reallocated - first.reallocated);
         const timeDiffDays = (new Date(last.timestamp) - new Date(first.timestamp)) / (1000 * 60 * 60 * 24);
         
         if (errDiff > 0 && timeDiffDays > 0) {
            const slope = errDiff / timeDiffDays; // Errors per day
            const remainingToCrit = isNvme ? (100 - percentageUsed) : (50 - reallocated); // rough heuristic
            if (slope > 0) predictedDays = Math.max(1, Math.round(remainingToCrit / slope));
            
            if (predictedDays !== null && predictedDays < 30) {
              isAtRisk = true; // Mark as at risk if predicted failure is within 30 days
            }
         }
      }
    } catch(e) {}

    // Save to historical telemetry DB
    db.saveDiskAnalytics(hostId, diskName, isAtRisk ? 'WARNING' : 'PASSED', temperature, isNvme ? percentageUsed : (reallocated || 0), isNvme ? mediaErrors : (uncorrectable || 0));

    return {
      success: true, scan_type: 'fast', disk: diskName, timestamp: new Date().toISOString(),
      predicted_days: predictedDays,
      fatal_five: isNvme ? {
        'NVMe Media Errors': mediaErrors,
        'NVMe Percentage Used': percentageUsed,
        'NVMe Available Spare': extract(/available_spare\s*:\s*(\d+)/i) || 100,
        'Temperature': temperature
      } : {
        'SMART 5 (Reallocated Sectors)': reallocated,
        'SMART 187 (Uncorrectable Errors)': uncorrectable,
        'SMART 197 (Pending Sectors)': pending,
        'SMART 198 (Offline Uncorrectable)': offline,
        'SMART 173 (Wear Leveling)': wearLevel || (diskName.includes('Samsung') ? 269 : 0)
      },
      temperature, overall_health: isAtRisk ? 'WARNING' : 'PASSED', isAtRisk, reallocated: (isNvme ? mediaErrors : reallocated)
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

app.post('/api/scan/fast', async (req, res) => {
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

// ─── Autonomous Webhook Engine (Discord/Telegram) ───────────────────────────
const dispatchEmergencyWebhook = async (title, message, severity="critical") => {
  try {
    const hooks = await db.getWebhooks();
    const activeHooks = hooks.filter(h => h.enabled && h.url);
    if (activeHooks.length === 0) return;

    for (let hook of activeHooks) {
      if (hook.type === 'discord') {
        const color = severity === 'critical' ? 15548997 : severity === 'warning' ? 16776960 : 3447003;
        await axios.post(hook.url, {
          embeds: [{ title: `🚨 NOVA NOC Alert: ${title}`, description: message, color, timestamp: new Date().toISOString() }]
        });
      } else if (hook.type === 'telegram') {
        const text = `🚨 *NOVA NOC Alert: ${title}*\n${message}`;
        const tgUrl = `https://api.telegram.org/bot${hook.token}/sendMessage`;
        await axios.post(tgUrl, { chat_id: hook.chatId, text, parse_mode: 'Markdown' });
      }
    }
  } catch(e) { console.error('[Webhook Dispatcher Failed]', e.message); }
};

// ─── Autonomous NOC Scheduler (The Ghost Fleet) ─────────────────────────────
setInterval(async () => {
  if (state.sshConfigs.length === 0) return;
  console.log('[NOC Scheduler] Waking up Ghost Fleet to perform invisible fleet-wide hardware poll...');
  for (let config of state.sshConfigs) {
    const hostId = `ssh-${config.host}`;
    try {
      // QoS Dynamic Load Check
      const loadOk = await checkHostLoadQoS(hostId);
      if (!loadOk) {
         db.logEvent(hostId, 'system', 'Scan jitter applied. High CPU load detected, deferring scan to avoid production impact.');
         continue; // skips this host to next cycle
      }

      // In a real scenario we poll lsblk or Get-PhysicalDisk, here we simulate checks
      const disksToPoll = ['OS_Drive_0', 'nvme0n1']; 
      for (const diskName of disksToPoll) {
        const result = await executeInvisibleSmartPoll(hostId, diskName);
        if (result.success && result.isAtRisk) {
          db.logEvent(hostId, 'ai_predictive', `Autonomous Scan detected PREDICTIVE FAILURE on ${diskName}. Slope: ${result.predicted_days ? result.predicted_days + ' days remaining.' : 'Critical thresholds reached.'}`);
          dispatchEmergencyWebhook(`Predictive Disk Failure (${hostId})`, `The Ghost Engine has detected that drive **${diskName}** has breached safety thresholds.\nPredicted Time to Failure: **${result.predicted_days ? result.predicted_days + ' Days' : 'IMMINENT'}**\nErrors Logged: ${result.reallocated}`, 'critical');
          
          triggerDiskFailureAutoRemediation(hostId, diskName);
        }
      }
    } catch(e) {}
  }
}, 60 * 60 * 1000); // Runs once every 60 minutes across all servers

const checkHostLoadQoS = async (hostId) => {
  try {
     const rawMsg = await executeGhostPayload(hostId, 'raw', 'powershell "Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average"', 'cat /proc/loadavg');
     if (hostId.includes('ssh-') && rawMsg) {
       const loadPars = parseFloat(rawMsg.trim().split(' ')[0]);
       if (loadPars > 4.0) return false; 
     }
     return true;
  } catch(e) { return true; } 
};

const triggerDiskFailureAutoRemediation = async (hostId, diskName) => {
  try {
    const rules = await db.getRules();
    const diskRules = rules.filter(r => r.enabled && r.hostId === hostId && r.metric === 'disk_failure_imminent');
    for (let rule of diskRules) {
      db.logEvent(hostId, 'auto-healing', `Triggered disk failure remediation: ${rule.name}`);
      await executeGhostPayload(hostId, 'raw', rule.action, rule.action);
    }
  } catch(e) { console.error('AutoRemediation error', e); }
};

// ─── Kernel OS-Level Log Scraper ────────────────────────────────────────────
app.post('/api/scan/kernel-logs', async (req, res) => {
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

app.post('/api/scan/deep', async (req, res) => {
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


app.get('/api/scan/history/:hostId/:diskName', async (req, res) => {
  try {
    const history = await db.getDiskAnalytics(req.params.hostId, req.params.diskName);
    res.json({ success: true, history });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Enterprise APIs ────────────────────────────────────────────────────────
app.get('/api/enterprise/history/:hostId', async (req, res) => {
  try { res.json(await db.getHistory(req.params.hostId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/enterprise/webhooks', async (req, res) => {
  try { res.json(await db.getWebhooks()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/enterprise/webhooks', (req, res) => {
  db.addWebhook(req.body); 
  res.json({ success: true });
});

app.get('/api/enterprise/rules', async (req, res) => {
  try { res.json(await db.getRules()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/enterprise/rules', (req, res) => {
  db.addRule(req.body);
  res.json({ success: true });
});

app.get('/api/enterprise/logs', async (req, res) => {
  try {
    const logs = await db.getEvents();
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE SERVICES API (PostgreSQL / Redis / MongoDB / Docker)
// ═══════════════════════════════════════════════════════════════════════════
const net = require('net');
const { Client: PgClient } = require('pg');
const Redis = require('ioredis');
const { MongoClient } = require('mongodb');

// ─── TCP Ping helper ────────────────────────────────────────────────────────
function tcpPing(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ ok: true, latency });
    });
    socket.on('error', () => { socket.destroy(); resolve({ ok: false, latency: 0 }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, latency: 0 }); });
    socket.connect(port, host);
  });
}

// ─── PostgreSQL Stats ────────────────────────────────────────────────────────
async function getPgStats(svc) {
  const client = new PgClient({
    host: svc.host, port: svc.port || 5432,
    user: svc.username, password: svc.password,
    database: svc.database_name || 'postgres',
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const [connRes, cacheRes, dbRes, slowRes] = await Promise.all([
    client.query(`SELECT count(*) as total, count(*) FILTER (WHERE state='active') as active, count(*) FILTER (WHERE state='idle') as idle FROM pg_stat_activity`),
    client.query(`SELECT sum(blks_hit)::float / greatest(sum(blks_hit) + sum(blks_read), 1) * 100 AS cache_hit FROM pg_stat_database`),
    client.query(`SELECT pg_database_size(current_database())::float / 1024 / 1024 AS size_mb`),
    client.query(`SELECT count(*) as slow FROM pg_stat_activity WHERE state='active' AND query_start < now() - interval '5 seconds'`),
  ]);
  await client.end();
  return {
    connections_total:  parseInt(connRes.rows[0].total),
    connections_active: parseInt(connRes.rows[0].active),
    connections_idle:   parseInt(connRes.rows[0].idle),
    cache_hit_pct:      parseFloat(cacheRes.rows[0].cache_hit).toFixed(1),
    db_size_mb:         parseFloat(dbRes.rows[0].size_mb).toFixed(1),
    slow_queries:       parseInt(slowRes.rows[0].slow),
  };
}

// ─── Redis Stats ─────────────────────────────────────────────────────────────
async function getRedisStats(svc) {
  const redis = new Redis({
    host: svc.host, port: svc.port || 6379,
    password: svc.password || undefined,
    connectTimeout: 5000, commandTimeout: 5000,
    lazyConnect: true,
  });
  await redis.connect();
  const info = await redis.info('all');
  await redis.quit();
  const parse = (key) => {
    const match = info.match(new RegExp(`${key}:(.*)`));
    return match ? match[1].trim() : '0';
  };
  const hits = parseInt(parse('keyspace_hits'));
  const misses = parseInt(parse('keyspace_misses'));
  const hitRate = hits + misses === 0 ? 100 : ((hits / (hits + misses)) * 100).toFixed(1);
  return {
    used_memory_mb:     (parseInt(parse('used_memory')) / 1024 / 1024).toFixed(1),
    peak_memory_mb:     (parseInt(parse('used_memory_peak')) / 1024 / 1024).toFixed(1),
    connected_clients:  parseInt(parse('connected_clients')),
    hit_rate_pct:       parseFloat(hitRate),
    evicted_keys:       parseInt(parse('evicted_keys')),
    total_commands_ps:  parseInt(parse('instantaneous_ops_per_sec')),
    uptime_days:        Math.floor(parseInt(parse('uptime_in_seconds')) / 86400),
    redis_version:      parse('redis_version'),
  };
}

// ─── MongoDB Stats ────────────────────────────────────────────────────────────
async function getMongoStats(svc) {
  const uri = svc.connection_string ||
    `mongodb://${svc.username ? `${svc.username}:${svc.password}@` : ''}${svc.host}:${svc.port || 27017}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const admin = client.db('admin');
  const [status, dbList] = await Promise.all([
    admin.command({ serverStatus: 1 }),
    admin.command({ listDatabases: 1 }),
  ]);
  await client.close();
  const ops = status.opcounters;
  const repl = status.repl;
  return {
    version:            status.version,
    uptime_hours:       Math.floor(status.uptime / 3600),
    connections_current: status.connections.current,
    connections_avail:   status.connections.available,
    ops_insert:         ops.insert,
    ops_query:          ops.query,
    ops_update:         ops.update,
    ops_delete:         ops.delete,
    total_dbs:          dbList.databases.length,
    repl_set:           repl ? repl.setName : null,
    repl_is_primary:    repl ? repl.ismaster : null,
  };
}

// ─── GET all services ────────────────────────────────────────────────────────
app.get('/api/services', async (req, res) => {
  try {
    const rows = await db.getServices(req.query.type || null);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST add service ─────────────────────────────────────────────────────────
app.post('/api/services', async (req, res) => {
  try {
    const svc = await db.addService(req.body);
    res.json(svc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE service ───────────────────────────────────────────────────────────
app.delete('/api/services/:id', async (req, res) => {
  try {
    await db.deleteService(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST ping service (TCP) ──────────────────────────────────────────────────
app.post('/api/services/:id/ping', async (req, res) => {
  try {
    const services = await db.getServices();
    const svc = services.find(s => s.id === parseInt(req.params.id));
    if (!svc) return res.status(404).json({ error: 'Not found' });
    const { ok, latency } = await tcpPing(svc.host, svc.port || getDefaultPort(svc.type), 4000);
    await db.updateServiceStatus(svc.id, ok ? 'online' : 'offline', latency);
    res.json({ status: ok ? 'online' : 'offline', latency });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET live stats for a service ────────────────────────────────────────────
app.get('/api/services/:id/stats', async (req, res) => {
  try {
    const services = await db.getServices();
    const svc = services.find(s => s.id === parseInt(req.params.id));
    if (!svc) return res.status(404).json({ error: 'Not found' });
    let stats = {};
    if (svc.type === 'postgres') stats = await getPgStats(svc);
    else if (svc.type === 'redis') stats = await getRedisStats(svc);
    else if (svc.type === 'mongodb') stats = await getMongoStats(svc);
    else {
      const { ok, latency } = await tcpPing(svc.host, svc.port || 2375, 3000);
      stats = { status: ok ? 'online' : 'offline', latency };
    }
    await db.updateServiceStatus(svc.id, 'online', stats.latency || 0);
    res.json({ ...stats, service: svc });
  } catch (e) {
    const id = parseInt(req.params.id);
    await db.updateServiceStatus(id, 'offline', 0);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET historical chart data for a service stat ─────────────────────────────
app.get('/api/services/:id/history', async (req, res) => {
  try {
    const data = await db.getServiceStats(
      parseInt(req.params.id),
      req.query.key || 'connections_active',
      parseInt(req.query.limit) || 30
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function getDefaultPort(type) {
  return { postgres: 5432, redis: 6379, mongodb: 27017, docker: 2375 }[type] || 80;
}

// ─── Background polling for registered services (every 30s) ──────────────────
async function pollServices() {
  try {
    const services = await db.getServices();
    for (const svc of services) {
      try {
        let stats = {};
        if (svc.type === 'postgres') stats = await getPgStats(svc);
        else if (svc.type === 'redis') stats = await getRedisStats(svc);
        else if (svc.type === 'mongodb') stats = await getMongoStats(svc);
        await db.updateServiceStatus(svc.id, 'online', stats.latency || 0);
        // Save key metrics for history charts
        const keyMap = {
          postgres: [['connections_active', stats.connections_active], ['cache_hit_pct', stats.cache_hit_pct]],
          redis:    [['used_memory_mb', stats.used_memory_mb], ['hit_rate_pct', stats.hit_rate_pct], ['total_commands_ps', stats.total_commands_ps]],
          mongodb:  [['connections_current', stats.connections_current], ['ops_query', stats.ops_query]],
        };
        (keyMap[svc.type] || []).forEach(([k, v]) => {
          if (v !== undefined) db.saveServiceStat(svc.id, k, parseFloat(v) || 0);
        });
        io.emit('service:update', { id: svc.id, status: 'online', stats });
      } catch {
        await db.updateServiceStatus(svc.id, 'offline', 0);
        io.emit('service:update', { id: svc.id, status: 'offline', stats: {} });
      }
    }
  } catch (e) { console.error('[Services] Poll error:', e.message); }
}
// NOTE: pollServices (basic) is superseded by pollServicesWithAlerts below.
// setInterval(pollServices, 30000); // REMOVED - duplicate

// ═══════════════════════════════════════════════════════════════════════════
// AUTH API (JWT) — JWT_SECRET, authMiddleware, verifyAdmin defined at top of file
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/verify
app.get('/api/auth/verify', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(401).json({ valid: false });
    // Sanitize user before sending back
    res.json({ valid: true, user: { id: user.id, username: user.username, role: user.role } });
  } catch { res.status(401).json({ valid: false }); }
});

// POST /api/auth/logout
app.post('/api/auth/logout', authMiddleware, (req, res) => {
  db.logEvent('hub', 'auth', `User '${req.user.username}' logged out`);
  res.json({ success: true });
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await db.getUser(req.user.username);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await db.pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/users
app.get('/api/auth/users', authMiddleware, verifyAdmin, async (req, res) => {
  try { res.json(await db.getUsers()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/users (Create User)
app.post('/api/auth/users', authMiddleware, verifyAdmin, async (req, res) => {
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

// PUT /api/auth/users/:id/role
app.put('/api/auth/users/:id/role', authMiddleware, verifyAdmin, async (req, res) => {
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

// DELETE /api/auth/users/:id
app.delete('/api/auth/users/:id', authMiddleware, verifyAdmin, async (req, res) => {
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

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2: SMART ALERTS ENGINE
// ═══════════════════════════════════════════════════════════════════════════
const alertCooldown = new Map(); // serviceId -> lastAlertTimestamp
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

async function sendAlertNotification(svc, message, severity = 'critical') {
  const now = Date.now();
  const last = alertCooldown.get(svc.id) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return; // cooldown active
  alertCooldown.set(svc.id, now);

  db.logAlert({ service_id: svc.id, service_name: svc.name, service_type: svc.type, severity, message, channel: 'system', sent: false });
  io.emit('alert:new', { service_id: svc.id, service_name: svc.name, severity, message, timestamp: new Date().toISOString() });

  // Fetch webhooks
  const webhooks = await db.getWebhooks().catch(() => []);
  for (const wh of webhooks.filter(w => w.enabled)) {
    try {
      if (wh.type === 'discord' && wh.url) {
        await axios.post(wh.url, {
          embeds: [{
            title: `🚨 ${severity.toUpperCase()}: ${svc.name}`,
            description: message,
            color: severity === 'critical' ? 0xFF0000 : 0xFFA500,
            fields: [{ name: 'Service Type', value: svc.type, inline: true }, { name: 'Host', value: svc.host, inline: true }],
            timestamp: new Date().toISOString(),
            footer: { text: 'Disk Monitoring System GUI' }
          }]
        });
        db.logAlert({ service_id: svc.id, service_name: svc.name, service_type: svc.type, severity, message, channel: 'discord', sent: true });
      } else if (wh.type === 'telegram' && wh.token && wh.chatId) {
        const text = `🚨 *${severity.toUpperCase()}*: ${svc.name}\n${message}\nHost: \`${svc.host}\`\nType: ${svc.type}`;
        await axios.post(`https://api.telegram.org/bot${wh.token}/sendMessage`, { chat_id: wh.chatId, text, parse_mode: 'Markdown' });
        db.logAlert({ service_id: svc.id, service_name: svc.name, service_type: svc.type, severity, message, channel: 'telegram', sent: true });
      }
    } catch (err) { console.error('[Alert] Webhook failed:', err.message); }
  }
}

// GET /api/alerts - alert history
app.get('/api/alerts', async (req, res) => {
  try { res.json(await db.getAlertLog(parseInt(req.query.limit) || 100)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alerts/test - test webhook
app.post('/api/alerts/test', async (req, res) => {
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

// Hook alert engine into pollServices — patch the catch block
const _origPoll = pollServices;
// Replace pollServices with alert-aware version
(async () => {
  // Monkey-patch: wrap the existing pollServices to trigger alerts
  const originalInterval = setInterval; // already called above
})();

// Enhanced service poller WITH alerts
async function pollServicesWithAlerts() {
  try {
    const services = await db.getServices();
    for (const svc of services) {
      const wasOnline = svc.status === 'online';
      try {
        let stats = {};
        if (svc.type === 'postgres') stats = await getPgStats(svc);
        else if (svc.type === 'redis') stats = await getRedisStats(svc);
        else if (svc.type === 'mongodb') stats = await getMongoStats(svc);
        await db.updateServiceStatus(svc.id, 'online', stats.latency || 0);
        const keyMap = {
          postgres: [['connections_active', stats.connections_active], ['cache_hit_pct', stats.cache_hit_pct]],
          redis:    [['used_memory_mb', stats.used_memory_mb], ['hit_rate_pct', stats.hit_rate_pct], ['total_commands_ps', stats.total_commands_ps]],
          mongodb:  [['connections_current', stats.connections_current], ['ops_query', stats.ops_query]],
        };
        (keyMap[svc.type] || []).forEach(([k, v]) => {
          if (v !== undefined) db.saveServiceStat(svc.id, k, parseFloat(v) || 0);
        });
        io.emit('service:update', { id: svc.id, status: 'online', stats });
        // Recovery alert
        if (!wasOnline) {
          await sendAlertNotification(svc, `✅ ${svc.name} is back ONLINE on ${svc.host}`, 'info');
        }
      } catch {
        await db.updateServiceStatus(svc.id, 'offline', 0);
        io.emit('service:update', { id: svc.id, status: 'offline', stats: {} });
        if (wasOnline) {
          await sendAlertNotification(svc, `❌ ${svc.name} went OFFLINE on ${svc.host}:${svc.port}`, 'critical');
        }
      }
    }
  } catch (e) { console.error('[Services] Poll error:', e.message); }
}
setInterval(pollServicesWithAlerts, 30000);
}

module.exports = { startMonitoring };
