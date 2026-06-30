const { Client } = require('ssh2');
const db = require('../database');
const state = require('../state');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

function initSocket(io) {
    io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('hosts_update', state.hosts);
  socket.emit('bandwidth_update', { history: state.bandwidthHistory, current: state.bandwidthHistory[state.bandwidthHistory.length - 1] || { rx: 0, tx: 0 } });
  socket.emit('network_devices', Object.values(state.networkDevices));
  socket.emit('raid_zfs_update', raidZfsCache);

  // ─── Edge Agent Handlers ───
  socket.on('agent:register', (info) => {
    const hostId = socket.handshake.auth?.hostId || `agent-${socket.id.substring(0,6)}`;
    socket.hostId = hostId;
    socket.isAgent = true;
    console.log(`[Hub] Edge Agent Registered: ${hostId}`);
    state.hosts[hostId] = {
      name: `Agent: ${info.hostname}`,
      os: info.platform,
      disks: [], partitions: [], history: [],
      lastUpdate: Date.now(), status: 'online',
      connectionType: 'agent_push', cpu: 0, mem: 0,
      network: { rx: 0, tx: 0, iface: '' }
    };
    io.emit('hosts_update', state.hosts);
  });

  socket.on('agent:telemetry:push', (payload) => {
      const hostId = socket.hostId;
      if (!hostId || !state.hosts[hostId]) return;
  
      state.hosts[hostId].lastUpdate     = Date.now();
      state.hosts[hostId].status         = 'online';
      state.hosts[hostId].cpu            = payload.cpu || 0;
      state.hosts[hostId].mem            = payload.mem || 0;
      state.hosts[hostId].network        = payload.network || { rx: 0, tx: 0, iface: '' };
      state.hosts[hostId].disks          = payload.disks || [];
      state.hosts[hostId].partitions     = payload.partitions || [];
      state.hosts[hostId].raidArrays     = payload.raidArrays || [];
      state.hosts[hostId].lvm            = payload.lvm || null;
      state.hosts[hostId].virtualization = payload.virtualization || null;
      state.hosts[hostId].ioStats        = payload.ioStats || [];
  
      io.emit('hosts_update', state.hosts);
    });

  socket.on('agent:scan:progress', ({ jobId, diskName, progress }) => {
    io.emit('scan:progress', { jobId, hostId: socket.hostId, diskName, progress });
  });

  socket.on('agent:scan:result', ({ jobId, diskName, type, result }) => {
    io.emit('scan:complete', { jobId, hostId: socket.hostId, diskName, result, failed: result.failed || false });
  });


  socket.on('run_scan', async (hostId) => {
    if (hostId === 'localhost') {
      await pollDisks();
      socket.emit('scan_complete', { hostId: 'localhost' });
    }
  });

  socket.on('set_thresholds', (thresholds) => {
    state.alertThresholds = { ...alertThresholds, ...thresholds };
    logEvent('system', 'Thresholds updated via UI', state.alertThresholds);
    io.emit('thresholds_update', state.alertThresholds);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // FIX #9: Detach socket but start idle timer — do NOT kill session
    Object.keys(sshSessions).forEach(id => {
      if (sshSessions[id].socketId === socket.id) {
        sshSessions[id].socketId = null;
        // Auto-kill if unused for 30 minutes
        if (sshSessions[id].idleTimer) clearTimeout(sshSessions[id].idleTimer);
        sshSessions[id].idleTimer = setTimeout(() => {
          const s = sshSessions[id];
          if (s && !s.socketId && !s.killed) {
            console.log(`[Hub] Auto-killing idle session for ${id} (30min timeout)`);
            if (s.local && s.shell) s.shell.kill();
            else { if (s.shell) s.shell.end(); if (s.conn) s.conn.end(); }
            s.killed = true;
            delete sshSessions[id];
          }
        }, 30 * 60 * 1000);
      }
    });
  });

  // ─── Real-time SSH Shell (Persistent) ──────────────────────────────────────
  socket.on('ssh_shell_start', (hostId) => {
    // 1. Restore Existing Session if already running in the background
    const existingSession = sshSessions[hostId];
    if (existingSession && existingSession.shell && !existingSession.killed) {
      console.log(`[Hub] Restoring persistent terminal session for ${hostId}`);
      existingSession.socketId = socket.id;
      // FIX #9: Clear idle timer since user reconnected
      if (existingSession.idleTimer) { clearTimeout(existingSession.idleTimer); existingSession.idleTimer = null; }
      if (existingSession.history) {
        // FIX #8: Send ANSI reset before replaying history to avoid broken terminal colors
        socket.emit('ssh_shell_output', { hostId, data: '\x1b[0m' + existingSession.history });
      }
      return;
    }

    // FIX #2: Race Condition guard — prevent duplicate concurrent session creation
    if (existingSession && existingSession.starting) {
      console.warn(`[Hub] Session for ${hostId} is already starting. Ignoring duplicate.`);
      return;
    }

    // Lock: Mark as starting to block concurrent requests for same hostId
    sshSessions[hostId] = { starting: true, history: '', idleTimer: null };

    // Helper: line-based buffer (FIX #8) + stream to active socket
    const handleOutput = (d) => {
      const session = sshSessions[hostId];
      if (!session) return;
      const str = d.toString('utf8');
      session.history += str;
      // FIX #8: Keep last 1500 lines to avoid mid-line ANSI sequence breaks
      const lines = session.history.split('\n');
      if (lines.length > 1500) {
        session.history = lines.slice(-1500).join('\n');
      }
      if (session.socketId) {
        io.to(session.socketId).emit('ssh_shell_output', { hostId, data: str });
      }
    };

    if (hostId === 'localhost') {
       const shellProc = spawn('powershell.exe', [], { stdio: ['pipe', 'pipe', 'pipe'] });
       sshSessions[hostId] = { shell: shellProc, socketId: socket.id, local: true, history: '', idleTimer: null };

       shellProc.stdout.on('data', handleOutput);
       shellProc.stderr.on('data', handleOutput);
       shellProc.on('close', () => {
         if (sshSessions[hostId] && sshSessions[hostId].socketId) io.to(sshSessions[hostId].socketId).emit('ssh_shell_closed', hostId);
         if (sshSessions[hostId]) sshSessions[hostId].killed = true;
         delete sshSessions[hostId];
       });
       return;
    }

    const config = state.sshConfigs.find(c => `ssh-${c.host}` === hostId);
    if (!config) {
      delete sshSessions[hostId]; // FIX #2: Release starting lock
      return socket.emit('ssh_shell_error', 'Host configuration not found.');
    }

    const conn = new Client();
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', rows: 30, cols: 100 }, (err, stream) => {
        if (err) {
          delete sshSessions[hostId]; // FIX #2: Release on error
          return socket.emit('ssh_shell_error', `Shell Error: ${err.message}`);
        }

        sshSessions[hostId] = { conn, shell: stream, socketId: socket.id, history: '', idleTimer: null };

        stream.on('data', handleOutput).on('close', () => {
          if (sshSessions[hostId] && sshSessions[hostId].socketId) {
            io.to(sshSessions[hostId].socketId).emit('ssh_shell_closed', hostId);
          }
          if (sshSessions[hostId]) sshSessions[hostId].killed = true;
          delete sshSessions[hostId];
        });
      });
    }).on('error', (err) => {
      delete sshSessions[hostId]; // FIX #2: Release lock on connection error
      socket.emit('ssh_shell_error', `Connection Error: ${err.message}`);
    }).connect({
      host: config.host,
      port: config.port || 22,
      username: config.user || config.username,
      password: config.pass || config.password,
      readyTimeout: 15000,
      keepaliveInterval: 10000
    });
  });

  // FIX #4: PTY Resize — sync terminal dimensions with remote shell on browser window resize
  socket.on('ssh_shell_resize', ({ hostId, cols, rows }) => {
    const session = sshSessions[hostId];
    if (!session || session.killed || session.local || session.starting) return;
    try {
      if (session.shell && typeof session.shell.setWindow === 'function') {
        session.shell.setWindow(rows, cols, 0, 0);
      }
    } catch (e) {
      console.error('[Hub] PTY resize error:', e.message);
    }
  });

  socket.on('ssh_shell_data', ({ hostId, data }) => {
    const session = sshSessions[hostId];
    if (session && session.shell) {
      try {
        if (session.local) {
           if (!session.killed) session.shell.stdin.write(data);
        } else {
           if (!session.killed) session.shell.write(data);
        }
      } catch (err) {
        console.error('Socket Shell Write Error:', err.message);
      }
    }
  });

  socket.on('ssh_shell_stop', (hostId) => {
    const session = sshSessions[hostId];
    if (session) {
      session.killed = true;
      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (session.local) {
         if (session.shell) session.shell.kill();
      } else {
         if (session.shell) session.shell.end();
         if (session.conn) session.conn.end();
      }
      delete sshSessions[hostId];
    }
  });
  });
}

module.exports = { initSocket };
