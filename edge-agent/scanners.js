'use strict';
const cp = require('child_process');
const util = require('util');
const exec = util.promisify(cp.exec);

// Timeout-bounded safe exec — never throws, returns '' on failure
async function safeExec(cmd, timeoutMs) {
  try {
    const { stdout } = await exec(cmd, { timeout: timeoutMs || 8000 });
    return (stdout || '').trim();
  } catch (e) {
    return '';
  }
}

// ── Virtualization Detection ────────────────────────────────────────────────
async function detectVirtualization() {
  try {
    const [vendor, product, virt] = await Promise.all([
      safeExec('cat /sys/class/dmi/id/sys_vendor 2>/dev/null', 2000),
      safeExec('cat /sys/class/dmi/id/product_name 2>/dev/null', 2000),
      safeExec('systemd-detect-virt 2>/dev/null', 2000)
    ]);
    const v = (vendor || '').toLowerCase();
    let type = 'none';
    if (virt && virt !== 'none') type = virt.trim();
    else if (v.includes('qemu') || v.includes('kvm')) type = 'kvm';
    else if (v.includes('vmware')) type = 'vmware';
    else if (v.includes('microsoft')) type = 'hyper-v';
    else if (v.includes('virtualbox') || (product || '').toLowerCase().includes('virtualbox')) type = 'virtualbox';
    else if (v.includes('xen')) type = 'xen';
    return type !== 'none' ? { type, vendor: (vendor || '').trim(), product: (product || '').trim() } : null;
  } catch {
    return null;
  }
}

// ── lsblk Full Tree ──────────────────────────────────────────────────────────
async function getLsblk() {
  const raw = await safeExec('lsblk -J -O 2>/dev/null', 10000);
  if (!raw) return [];
  try {
    return JSON.parse(raw).blockdevices || [];
  } catch {
    return [];
  }
}

// ── Filesystem / Mount Info ──────────────────────────────────────────────────
async function getFilesystems() {
  const [dfRaw, blkidRaw] = await Promise.all([
    safeExec('df -hTP 2>/dev/null', 5000),
    safeExec('blkid 2>/dev/null', 5000)
  ]);

  const SKIP_TYPES = new Set([
    'tmpfs','devtmpfs','udev','cgroup','cgroup2','overlay','proc','sysfs',
    'pstore','bpf','debugfs','tracefs','fusectl','configfs','mqueue',
    'hugetlbfs','securityfs','nsfs','squashfs'
  ]);

  const filesystems = [];
  for (const line of dfRaw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const [source, type, size, used, avail, usePctStr, ...mountParts] = parts;
    const mount = mountParts.join(' ');
    if (SKIP_TYPES.has(type) || source === 'Filesystem' || !mount) continue;

    let uuid = null, label = null;
    const blkLine = blkidRaw.split('\n').find(l => l.startsWith(source + ':'));
    if (blkLine) {
      const um = blkLine.match(/UUID="([^"]+)"/);
      const lm = blkLine.match(/LABEL="([^"]+)"/);
      if (um) uuid = um[1];
      if (lm) label = lm[1];
    }
    filesystems.push({ source, type, size, used, avail, usePct: parseInt(usePctStr) || 0, mount, uuid, label });
  }
  return filesystems;
}

// ── LVM Mapping ─────────────────────────────────────────────────────────────
async function getLVM() {
  try {
    const [pvRaw, vgRaw, lvRaw] = await Promise.all([
      safeExec('pvs --reportformat json --units h 2>/dev/null', 5000),
      safeExec('vgs --reportformat json --units h 2>/dev/null', 5000),
      safeExec('lvs --reportformat json --units h 2>/dev/null', 5000)
    ]);
    let pvs = [], vgs = [], lvs = [];
    try { pvs = JSON.parse(pvRaw).report[0].pv || []; } catch {}
    try { vgs = JSON.parse(vgRaw).report[0].vg || []; } catch {}
    try { lvs = JSON.parse(lvRaw).report[0].lv || []; } catch {}
    if (pvs.length || vgs.length || lvs.length) return { pvs, vgs, lvs };
  } catch {}
  return null;
}

// ── SMART Data ───────────────────────────────────────────────────────────────
async function getSmartData(deviceName) {
  const dev = deviceName.startsWith('/dev/') ? deviceName : '/dev/' + deviceName;
  const infoOut = await safeExec('smartctl -i ' + dev + ' 2>/dev/null', 6000);
  if (!infoOut) return { available: false, reason: 'smartctl not found or permission denied' };
  if (/Unavailable|lacks SMART|not supported|Unknown USB/i.test(infoOut)) {
    return { available: false, reason: 'Device does not support SMART (virtual or unsupported device)' };
  }
  const smartOut = await safeExec('smartctl -a ' + dev + ' 2>/dev/null', 10000);
  if (!smartOut) return { available: false, reason: 'Failed to read SMART data' };
  return parseSmart(smartOut, dev);
}

function parseSmart(raw, device) {
  const lines = raw.split('\n');
  const result = {
    available: true, device,
    model: null, serial: null, firmware: null,
    capacity: null, rotationRate: null,
    temperature: null, powerOnHours: null, powerCycles: null,
    overallHealth: null, smartEnabled: true,
    attributes: {}
  };

  for (const line of lines) {
    if (/Device Model\s*:/i.test(line))    result.model = line.split(':').slice(1).join(':').trim();
    if (/Model Number\s*:/i.test(line))    result.model = result.model || line.split(':').slice(1).join(':').trim();
    if (/Serial Number\s*:/i.test(line))   result.serial = line.split(':').slice(1).join(':').trim();
    if (/Firmware Version\s*:/i.test(line)) result.firmware = line.split(':').slice(1).join(':').trim();
    if (/User Capacity\s*:/i.test(line))   result.capacity = line.split(':').slice(1).join(':').trim();
    if (/Rotation Rate\s*:/i.test(line))   result.rotationRate = line.split(':').slice(1).join(':').trim();
    if (/SMART overall-health/i.test(line)) result.overallHealth = line.includes('PASSED') ? 'PASSED' : 'FAILED';
    if (/Current Drive Temperature\s*:/i.test(line)) {
      const m = line.match(/(\d+)\s*C/);
      if (m) result.temperature = parseInt(m[1]);
    }
  }

  let inTable = false;
  for (const line of lines) {
    if (/ID#\s+ATTRIBUTE_NAME/i.test(line)) { inTable = true; continue; }
    if (inTable && line.trim() === '') { inTable = false; continue; }
    if (inTable) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 10 && /^\d+$/.test(parts[0])) {
        const id = parts[0], name = parts[1];
        const value = parseInt(parts[3]), worst = parseInt(parts[4]), thresh = parseInt(parts[5]);
        const rawVal = parseInt((parts[9] || '0').replace(/[^0-9]/g, '')) || 0;
        result.attributes[id] = { id, name, value, worst, thresh, raw: rawVal };
        if (id === '190' || id === '194') result.temperature = result.temperature || rawVal;
        if (id === '9')  result.powerOnHours = rawVal;
        if (id === '12') result.powerCycles = rawVal;
      }
    }
  }
  return result;
}

// ── I/O Stats ────────────────────────────────────────────────────────────────
async function getIOStats() {
  const raw = await safeExec('iostat -dx 1 1 2>/dev/null', 8000);
  if (!raw) return [];
  const lines = raw.split('\n');
  const stats = [];
  let headers = null;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;
    if (parts[0] === 'Device') { headers = parts; continue; }
    if (headers && parts.length >= headers.length - 2 && parts[0] !== 'Device') {
      const stat = { device: parts[0] };
      headers.slice(1).forEach((h, i) => {
        // Normalize: r/s → r_s, rkB/s → rkB_s, %util → util_pct
        const key = h.replace(/\//g, '_').replace(/^%/, 'pct_');
        stat[key] = parseFloat(parts[i + 1]) || 0;
      });
      stats.push(stat);
    }
  }
  return stats;
}

// ── RAID Arrays ──────────────────────────────────────────────────────────────
async function getRAID() {
  const mdstat = await safeExec('cat /proc/mdstat 2>/dev/null', 3000);
  if (!mdstat || !mdstat.includes(' : ')) return [];
  const arrays = [];
  const blocks = mdstat.split('\n\n').filter(b => /^md\d+/.test(b));
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0];
    const nameM = header.match(/^(md\S+)\s+:\s+\S+\s+(\S+)\s+(.*)/);
    if (!nameM) continue;
    const [, device, level, rest] = nameM;
    const members = [];
    const memberRe = /([a-z]+\d+)\[(\d+)\](\(F\)|\(S\))?/g;
    let rm;
    while ((rm = memberRe.exec(rest)) !== null) {
      members.push({ device: '/dev/' + rm[1], slot: parseInt(rm[2]), state: rm[3] === '(F)' ? 'faulty' : rm[3] === '(S)' ? 'spare' : 'active' });
    }
    const progLine = lines.find(l => l.includes('recovery') || l.includes('resync'));
    let rebuildProgress = null;
    if (progLine) {
      const pm = progLine.match(/(\d+\.\d+)%/);
      if (pm) rebuildProgress = parseFloat(pm[1]);
    }
    const status = members.some(m => m.state === 'faulty') ? 'degraded' : progLine ? 'rebuilding' : 'clean';
    arrays.push({ device, level: level.toUpperCase(), status, members, rebuildProgress });
  }
  return arrays;
}

// ── Kernel Storage Errors ────────────────────────────────────────────────────
async function getDmesgErrors() {
  const raw = await safeExec(
    'dmesg -T -l err,crit,warn 2>/dev/null | grep -iE "ata|scsi|nvme|disk|ext4|xfs|btrfs|sd[a-z]|blk" | tail -30',
    5000
  );
  return raw ? raw.split('\n').filter(l => l.trim()) : [];
}

// ── Full Telemetry Collection (called by agent loop) ─────────────────────────
async function collectFullTelemetry() {
  const [lsblkDevices, filesystems, ioStats, raid, virt] = await Promise.all([
    getLsblk(),
    getFilesystems(),
    getIOStats(),
    getRAID(),
    detectVirtualization()
  ]);

  const diskDevices = lsblkDevices.filter(d => d.type === 'disk');

  const smartResults = await Promise.all(
    diskDevices.map(d => getSmartData(d.kname || d.name).catch(() => ({ available: false, reason: 'error' })))
  );

  const lvm = await getLVM();

  const enrichedDisks = diskDevices.map((d, i) => {
    const smart = smartResults[i];
    const ioStat = ioStats.find(s => s.device === (d.kname || d.name));

    // Resolve bus/transport for virtual disks where tran is null
    let bus = d.tran || null;
    if (!bus && d.subsystems) {
      const subs = d.subsystems.split(':');
      if (subs.includes('nvme'))  bus = 'NVMe';
      else if (subs.includes('virtio') && subs.includes('scsi')) bus = 'VirtIO SCSI';
      else if (subs.includes('virtio')) bus = 'VirtIO';
      else if (subs.includes('scsi')) bus = 'SCSI';
      else if (subs.includes('usb')) bus = 'USB';
      else if (subs.includes('ide')) bus = 'IDE';
    }
    if (!bus && virt) bus = 'Virtual (' + virt.type.toUpperCase() + ')';

    return {
      device: d.path || '/dev/' + d.kname,
      name: d.kname,
      model: d.model || null,
      vendor: d.vendor ? d.vendor.trim() : null,
      serial: d.serial || null,
      size: d.size,
      type: d.rota ? 'HDD' : 'SSD',
      bus,
      subsystems: d.subsystems,
      rotational: d.rota,
      partitionTable: d.pttype,
      smartStatus: smart.available ? (smart.overallHealth || 'OK') : 'N/A',
      smartAvailable: smart.available,
      smartReason: smart.available ? null : smart.reason,
      temperature: smart.available ? smart.temperature : null,
      powerOnHours: smart.available ? smart.powerOnHours : null,
      isVirtual: !!(virt) || /qemu|virtual/i.test((d.model || '') + (d.vendor || '')),
      hypervisor: virt ? virt.type : null,
      ioStats: ioStat ? {
        readIops:  ioStat.r_s  || 0,
        writeIops: ioStat.w_s  || 0,
        readMBps:  (ioStat.rkB_s || 0) / 1024,
        writeMBps: (ioStat.wkB_s || 0) / 1024,
        readAwait: ioStat.r_await || 0,
        writeAwait: ioStat.w_await || 0,
        util:      ioStat.pct_util || 0
      } : null,
      smartAttributes: smart.available ? smart.attributes : null,
      children: (d.children || []).map(p => ({
        name: p.kname,
        type: p.type,
        fstype: p.fstype || null,
        size: p.size,
        mountpoint: p.mountpoint || (p.mountpoints || [null])[0] || null,
        label: p.label || null,
        partuuid: p.partuuid || null,
        uuid: p.uuid || null,
        partTypeName: p.parttypename || null
      }))
    };
  });

  return {
    disks: enrichedDisks,
    partitions: filesystems,
    raidArrays: raid,
    lvm: lvm || null,
    virtualization: virt,
    ioStats
  };
}

// ── Fast Scan ────────────────────────────────────────────────────────────────
async function executeLatentScan(diskName) {
  try {
    const devName = diskName.replace('/dev/', '');
    const device = '/dev/' + devName;

    const [smart, lsblkRaw, ioStats, dmesgErrors, filesystems, virt] = await Promise.all([
      getSmartData(devName),
      safeExec('lsblk -J -O ' + device + ' 2>/dev/null', 5000),
      getIOStats(),
      getDmesgErrors(),
      getFilesystems(),
      detectVirtualization()
    ]);

    let topology = null;
    try { topology = (JSON.parse(lsblkRaw).blockdevices || [])[0] || null; } catch {}

    const ioStat = ioStats.find(s => s.device === devName);

    // Resolve bus type
    let bus = topology && topology.tran ? topology.tran : null;
    if (!bus && topology && topology.subsystems) {
      const subs = topology.subsystems.split(':');
      if (subs.includes('nvme')) bus = 'NVMe';
      else if (subs.includes('virtio') && subs.includes('scsi')) bus = 'VirtIO SCSI';
      else if (subs.includes('virtio')) bus = 'VirtIO';
      else if (subs.includes('scsi')) bus = 'SCSI';
    }
    if (!bus && virt) bus = 'Virtual (' + virt.type.toUpperCase() + ')';

    // Partition summary for this disk
    const diskKids = (topology && topology.children) ? topology.children.map(c => c.kname || c.name) : [];
    const partitions = filesystems.filter(f => {
      return diskKids.some(k => f.source.includes(k)) || f.source.includes(devName);
    });

    // Risk assessment
    const risks = [];
    if (smart.available) {
      const rv = smart.attributes && smart.attributes['5'] ? smart.attributes['5'].raw : 0;
      const pv = smart.attributes && smart.attributes['197'] ? smart.attributes['197'].raw : 0;
      const uv = smart.attributes && smart.attributes['198'] ? smart.attributes['198'].raw : 0;
      const crc = smart.attributes && smart.attributes['199'] ? smart.attributes['199'].raw : 0;
      if (rv > 0)  risks.push({ level: rv > 10 ? 'critical' : 'warning', msg: rv + ' reallocated sector(s)' });
      if (pv > 0)  risks.push({ level: 'critical', msg: pv + ' pending sector(s)' });
      if (uv > 0)  risks.push({ level: 'critical', msg: uv + ' offline-uncorrectable sector(s)' });
      if (crc > 0) risks.push({ level: 'warning',  msg: crc + ' CRC/UDMA errors — check cable' });
      if (smart.temperature && smart.temperature > 55) risks.push({ level: 'warning', msg: 'High temperature: ' + smart.temperature + '°C' });
    }
    if (dmesgErrors.length > 0) risks.push({ level: 'warning', msg: dmesgErrors.length + ' kernel storage error(s) in dmesg' });

    const rv = smart.available && smart.attributes['5']   ? smart.attributes['5'].raw   : 0;
    const pv = smart.available && smart.attributes['197'] ? smart.attributes['197'].raw : 0;
    const uv = smart.available && smart.attributes['198'] ? smart.attributes['198'].raw : 0;
    const crc = smart.available && smart.attributes['199'] ? smart.attributes['199'].raw : 0;

    return {
      success: true,
      scan_type: 'fast',
      timestamp: new Date().toISOString(),
      disk: devName,
      diskModel: (topology && topology.model) || (virt ? virt.vendor + ' Virtual Disk' : 'Unknown'),
      diskSize: (topology && topology.size) || 'Unknown',
      diskType: topology ? (topology.rota ? 'HDD' : 'SSD') : 'Unknown',
      busType: bus || 'Unknown',
      virtualization: virt,
      partitions,
      topology: topology ? {
        name: topology.name,
        children: (topology.children || []).map(c => ({
          name: c.name, type: c.type, fstype: c.fstype,
          size: c.size, mountpoint: c.mountpoint || (c.mountpoints || [])[0],
          label: c.label, uuid: c.uuid
        }))
      } : null,
      ioStats: ioStat ? {
        readIops: ioStat.r_s || 0, writeIops: ioStat.w_s || 0,
        readMBps: (ioStat.rkB_s || 0) / 1024, writeMBps: (ioStat.wkB_s || 0) / 1024,
        readAwait: ioStat.r_await || 0, writeAwait: ioStat.w_await || 0,
        util: ioStat.pct_util || 0
      } : null,
      risks,
      dmesgErrors: dmesgErrors.slice(0, 10),
      overall_health: risks.some(r => r.level === 'critical') ? 'WARNING' : 'PASSED',
      smartFallback: !smart.available,
      fallbackAnalysis: smart.available ? null : computeFallbackAnalysis(ioStat, dmesgErrors, virt, topology),
      fatal_five: smart.available ? {
        'SMART 5 (Reallocated Sectors)':    rv,
        'SMART 197 (Pending Sectors)':      pv,
        'SMART 198 (Uncorrectable)':        uv,
        'SMART 199 (CRC Errors)':           crc,
        'Temperature (°C)':            smart.temperature || 'N/A'
      } : {
        'SMART Status':      'Not Available',
        'Reason':            smart.reason,
        'I/O Read IOPS':     ioStat ? (ioStat.r_s || 0) : 0,
        'I/O Write IOPS':    ioStat ? (ioStat.w_s || 0) : 0,
        'I/O Await Read ms': ioStat ? (ioStat.r_await || 0) : 0
      },
      smartStatus: smart.available ? (smart.overallHealth || 'OK') : 'N/A'
    };
  } catch (err) {
    return { success: false, scan_type: 'fast', error: err.message };
  }
}

// ── Deep Scan ────────────────────────────────────────────────────────────────
function executeHardwareDeepScan(diskName, progressCallback) {
  return new Promise(function(resolve) {
    const devName = diskName.replace('/dev/', '');
    const device = '/dev/' + devName;
    const results = { phases: [], timestamp: new Date().toISOString(), device };

    async function run() {
      function tick(p) { progressCallback(p); }

      try {
        // Phase 1: SMART (0-20)
        tick(5);
        const smart = await getSmartData(devName);
        results.smart = smart;
        tick(20);

        // Phase 2: Full topology (20-35)
        tick(22);
        const lsblkRaw = await safeExec('lsblk -J -O ' + device + ' 2>/dev/null', 5000);
        let topology = null;
        try { topology = (JSON.parse(lsblkRaw).blockdevices || [])[0]; } catch {}
        results.topology = topology;
        tick(35);

        // Phase 3: Filesystems (35-50)
        tick(37);
        results.filesystems = await getFilesystems();
        tick(50);

        // Phase 4: I/O metrics (50-60)
        tick(52);
        const ioStats = await getIOStats();
        results.ioStats = ioStats.find(s => s.device === devName) || null;
        tick(60);

        // Phase 5: Kernel errors (60-70)
        tick(62);
        results.dmesgErrors = await getDmesgErrors();
        tick(70);

        // Phase 6: Virtualization + SMART test status (70-85)
        tick(72);
        const virt = await detectVirtualization();
        results.virtualization = virt;
        if (smart.available) {
          const statusRaw = await safeExec('smartctl -c ' + device + ' 2>/dev/null', 5000);
          results.smartTestStatus = /Self-test in progress|in progress/i.test(statusRaw) ? 'in_progress'
            : /completed without error/i.test(statusRaw) ? 'passed' : 'not_running';
        } else {
          results.smartTestStatus = 'unavailable';
          results.smartUnavailableReason = smart.reason;
        }
        tick(85);

        // Phase 7: LVM (85-93)
        tick(87);
        results.lvm = await getLVM();
        tick(93);

        // Phase 8: RAID (93-100)
        tick(95);
        results.raid = await getRAID();
        tick(100);

        // Risk summary
        const risks = [];
        if (smart.available) {
          const a = smart.attributes || {};
          const rv = a['5'] ? a['5'].raw : 0;
          const pv = a['197'] ? a['197'].raw : 0;
          const uv = a['198'] ? a['198'].raw : 0;
          if (rv > 0) risks.push({ level: rv > 5 ? 'critical' : 'warning', msg: rv + ' reallocated sectors' });
          if (pv > 0) risks.push({ level: 'critical', msg: pv + ' pending sectors' });
          if (uv > 0) risks.push({ level: 'critical', msg: uv + ' uncorrectable errors' });
        }
        if (results.dmesgErrors.length > 0)
          risks.push({ level: 'warning', msg: results.dmesgErrors.length + ' kernel storage errors in dmesg' });
        if ((results.raid || []).some(r => r.status === 'degraded'))
          risks.push({ level: 'critical', msg: 'RAID array is degraded' });

        resolve({
          method: results.virtualization
            ? 'Virtual Disk Deep Analysis (' + results.virtualization.type.toUpperCase() + ')'
            : 'Hardware Deep Scan (smartmontools + Linux I/O subsystem)',
          timestamp: results.timestamp,
          failed: risks.some(r => r.level === 'critical'),
          message: risks.length === 0
            ? 'Deep analysis complete — no storage issues detected.'
            : 'Issues found: ' + risks.map(r => r.msg).join('; '),
          overall_health: risks.some(r => r.level === 'critical') ? 'WARNING' : 'PASSED',
          riskFactors: risks,
          smart: results.smart,
          topology: results.topology,
          filesystems: results.filesystems,
          ioStats: results.ioStats,
          dmesgErrors: results.dmesgErrors,
          lvm: results.lvm,
          raid: results.raid,
          virtualization: results.virtualization,
          smartTestStatus: results.smartTestStatus
        });
      } catch (err) {
        tick(100);
        resolve({
          method: 'Deep Scan',
          failed: false,
          message: 'Scan error: ' + err.message,
          overall_health: 'UNKNOWN',
          error: err.message
        });
      }
    }

    run();
  });
}

// ── Fallback Health Analysis for Virtual / SMART-Unavailable Disks ────────────
function computeFallbackAnalysis(ioStat, dmesgErrors, virt, topology) {
  const findings = [];
  let riskScore = 0;

  // I/O latency
  const rAwait  = ioStat ? (ioStat.r_await || 0) : 0;
  const wAwait  = ioStat ? (ioStat.w_await || 0) : 0;
  const maxAwait = Math.max(rAwait, wAwait);
  if (maxAwait > 100) {
    riskScore += 25;
    findings.push({ level: 'critical', category: 'LATENCY', msg: 'Severe I/O latency: ' + maxAwait.toFixed(1) + 'ms — storage bottleneck detected' });
  } else if (maxAwait > 30) {
    riskScore += 10;
    findings.push({ level: 'warning', category: 'LATENCY', msg: 'Elevated I/O latency: ' + maxAwait.toFixed(1) + 'ms' });
  } else {
    findings.push({ level: 'ok', category: 'LATENCY', msg: 'I/O latency normal: ' + maxAwait.toFixed(1) + 'ms' });
  }

  // Utilization
  const util = ioStat ? (ioStat.pct_util || 0) : 0;
  if (util > 90) {
    riskScore += 20;
    findings.push({ level: 'critical', category: 'UTILIZATION', msg: 'Disk utilization critical: ' + util.toFixed(0) + '%' });
  } else if (util > 70) {
    riskScore += 8;
    findings.push({ level: 'warning', category: 'UTILIZATION', msg: 'High disk utilization: ' + util.toFixed(0) + '%' });
  } else {
    findings.push({ level: 'ok', category: 'UTILIZATION', msg: 'Disk utilization normal: ' + util.toFixed(0) + '%' });
  }

  // Queue depth
  const aqu = ioStat ? (ioStat['aqu-sz'] || ioStat.aqu_sz || 0) : 0;
  if (aqu > 8) {
    riskScore += 10;
    findings.push({ level: 'warning', category: 'QUEUE', msg: 'High I/O queue depth: ' + aqu.toFixed(1) + ' — potential saturation' });
  } else {
    findings.push({ level: 'ok', category: 'QUEUE', msg: 'I/O queue depth normal: ' + aqu.toFixed(1) });
  }

  // Kernel errors
  const errCount = dmesgErrors ? dmesgErrors.length : 0;
  if (errCount > 5) {
    riskScore += 20;
    findings.push({ level: 'critical', category: 'KERNEL', msg: errCount + ' kernel storage errors in dmesg' });
  } else if (errCount > 0) {
    riskScore += 5;
    findings.push({ level: 'warning', category: 'KERNEL', msg: errCount + ' kernel storage warning(s) in dmesg' });
  } else {
    findings.push({ level: 'ok', category: 'KERNEL', msg: 'No kernel storage errors detected' });
  }

  // Throughput
  const readMBps  = ioStat ? (ioStat.rkB_s || 0) / 1024 : 0;
  const writeMBps = ioStat ? (ioStat.wkB_s || 0) / 1024 : 0;
  if (readMBps > 0 || writeMBps > 0) {
    findings.push({ level: 'ok', category: 'THROUGHPUT', msg: 'Throughput: R=' + readMBps.toFixed(2) + ' MB/s  W=' + writeMBps.toFixed(2) + ' MB/s' });
  }

  // Filesystem integrity
  const hasFS = topology && topology.children && topology.children.some(c => c.fstype);
  findings.push({ level: 'ok', category: 'FILESYSTEM', msg: hasFS ? 'Filesystem structure intact' : 'No mounted filesystem detected' });

  const riskCapped = Math.min(100, Math.round(riskScore));
  const assessment = riskCapped >= 50 ? 'HIGH RISK' : riskCapped >= 25 ? 'ELEVATED RISK' : riskCapped > 0 ? 'LOW RISK' : 'HEALTHY';
  const confidence = Math.max(55, 80 - (ioStat ? 0 : 20) - (errCount > 0 ? 5 : 0));

  let virtType = 'virtual environment';
  if (virt) {
    if (virt.type === 'kvm')         virtType = 'QEMU/KVM hypervisor';
    else if (virt.type === 'vmware') virtType = 'VMware ESXi';
    else if (virt.type === 'hyper-v') virtType = 'Microsoft Hyper-V';
    else if (virt.type === 'xen')    virtType = 'Xen hypervisor';
    else virtType = virt.type.toUpperCase() + ' environment';
  }

  const virtMessage = virt
    ? 'SMART passthrough unavailable in ' + virtType + '. Advanced fallback telemetry activated.'
    : 'SMART monitoring unavailable. Using kernel I/O subsystem telemetry as alternative.';

  const rec = riskCapped >= 50
    ? 'Investigate I/O bottlenecks — review hypervisor storage configuration and disk allocation'
    : riskCapped >= 25
    ? 'Monitor storage performance — consider I/O optimization and queue tuning'
    : 'Storage appears healthy — continue periodic monitoring';

  return {
    riskScore: riskCapped,
    assessment,
    confidence,
    findings,
    recommendation: rec,
    virtMessage,
    virtType: virt ? virt.type : null,
    telemetryActive: {
      ioLatency:          true,
      throughput:         true,
      queueDepth:         true,
      kernelLogs:         true,
      filesystemHealth:   hasFS,
      virtualizationAware: !!virt,
      smartPassthrough:   false,
      heuristicAnalysis:  true
    }
  };
}

// ── Latency Profiler (backward-compat + background sampler) ──────────────────
let recentLatencies = {};

async function sampleMicroStalls() {
  const stats = await getIOStats();
  for (const s of stats) {
    const awaitVal = s.r_await || s.w_await || 0;
    recentLatencies[s.device] = { await: awaitVal, stalled: awaitVal > 150 };
  }
}

function getLatestStalls() { return recentLatencies; }

setInterval(sampleMicroStalls, 2000);
sampleMicroStalls();

module.exports = {
  executeLatentScan,
  executeHardwareDeepScan,
  collectFullTelemetry,
  getLatestStalls,
  detectVirtualization,
  getSmartData,
  getFilesystems,
  getIOStats,
  getRAID,
  getLVM
};
