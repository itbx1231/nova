require('dotenv').config();
const { io } = require('socket.io-client');
const si = require('systeminformation');
const { executeLatentScan, executeHardwareDeepScan, collectFullTelemetry } = require('./scanners');

const HUB_URL   = process.env.HUB_URL   || 'http://localhost:5010';
const AGENT_TOKEN = process.env.AGENT_SECRET || process.env.AGENT_TOKEN || 'nova-x-edge-token-2026';
const HOST_ID   = process.env.HOST_ID   || 'edge-node-' + Math.random().toString(36).substring(7);

console.log('[Nova Edge] Booting... Hub: ' + HUB_URL + ' | ID: ' + HOST_ID);

const socket = io(HUB_URL, {
  auth: { token: AGENT_TOKEN, role: 'agent', hostId: HOST_ID },
  reconnectionDelay: 3000,
  reconnectionDelayMax: 10000
});

socket.on('connect', async () => {
  console.log('[Nova Edge] Connected to Hub. Socket: ' + socket.id);

  const [osInfo, sys, uuid] = await Promise.all([
    si.osInfo().catch(() => ({})),
    si.system().catch(() => ({})),
    si.uuid().catch(() => ({}))
  ]);

  socket.emit('agent:register', {
    hostname: osInfo.hostname,
    platform: osInfo.platform,
    distro: osInfo.distro,
    sysModel: sys.model,
    uuid: uuid.os || uuid.hardware
  });

  reportTelemetry();
});

socket.on('disconnect', () => {
  console.warn('[Nova Edge] Disconnected from Hub — will reconnect automatically.');
});

socket.on('connect_error', (err) => {
  console.error('[Nova Edge] Connection error:', err.message);
});

async function reportTelemetry() {
  if (!socket.connected) return;

  try {
    const [storageData, load, mem, net] = await Promise.all([
      collectFullTelemetry().catch(e => {
        console.error('[Nova Edge] Storage collection failed:', e.message);
        return { disks: [], partitions: [], raidArrays: [], lvm: null, virtualization: null, ioStats: [] };
      }),
      si.currentLoad().catch(() => ({ currentLoad: 0 })),
      si.mem().catch(() => ({ used: 0, total: 1 })),
      si.networkStats().catch(() => [])
    ]);

    socket.emit('agent:telemetry:push', {
      cpu: load.currentLoad || 0,
      mem: mem.used / mem.total,
      network: {
        rx:    net.length > 0 ? (net[0].rx_sec || 0) : 0,
        tx:    net.length > 0 ? (net[0].tx_sec || 0) : 0,
        iface: net.length > 0 ? (net[0].iface  || '') : ''
      },
      disks:         storageData.disks,
      partitions:    storageData.partitions,
      raidArrays:    storageData.raidArrays,
      lvm:           storageData.lvm,
      virtualization: storageData.virtualization,
      ioStats:       storageData.ioStats
    });
  } catch (err) {
    console.error('[Nova Edge] Telemetry push failed:', err.message);
  }

  setTimeout(reportTelemetry, 5000);
}

socket.on('agent:scan:request', async (payload) => {
  const { jobId, diskName, type } = payload;
  console.log('[Nova Edge] Scan request: ' + (type || '').toUpperCase() + ' on ' + diskName + ' [JOB ' + jobId + ']');

  if (type === 'fast') {
    try {
      const result = await executeLatentScan(diskName);
      socket.emit('agent:scan:result', { jobId, diskName, type: 'fast', result });
    } catch (err) {
      socket.emit('agent:scan:result', { jobId, diskName, type: 'fast', result: { success: false, error: err.message } });
    }
  } else if (type === 'deep') {
    executeHardwareDeepScan(diskName, (progress) => {
      socket.emit('agent:scan:progress', { jobId, diskName, progress });
    }).then(result => {
      socket.emit('agent:scan:result', { jobId, diskName, type: 'deep', result });
    }).catch(err => {
      socket.emit('agent:scan:result', { jobId, diskName, type: 'deep', result: { failed: true, message: err.message, error: true } });
    });
  }
});
