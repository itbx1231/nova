const cp = require('child_process');
const util = require('util');
const exec = util.promisify(cp.exec);

let recentLatencies = {};

async function sampleMicroStalls() {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      // Very basic windows disk latency (using wmic, measuring AvgDiskSecPerRead)
      const { stdout } = await exec(`wmic path Win32_PerfFormattedData_PerfDisk_PhysicalDisk get Name,AvgDisksecPerRead /format:csv`);
      const lines = stdout.split('\\n').filter(l => l.trim().length > 0 && l.includes(','));
      
      lines.slice(1).forEach(l => {
        const parts = l.split(',');
        const label = parts[1].trim(); // e.g. "0 C:"
        const avg = parseInt(parts[2].trim() || '0', 10);
        // On windows this value might be artificially low or scaled unless using powershell Get-Counter.
        // We will simulate a bottleneck check for demonstration if it's super high
        if (label !== '_Total') {
          recentLatencies[label] = { await: avg, stalled: avg > 150 };
        }
      });
    } else {
      // Linux iostat
      const { stdout } = await exec('iostat -dx 1 1');
      const lines = stdout.split('\\n');
      
      let headerPassed = false;
      lines.forEach(l => {
        const parts = l.trim().split(/\\s+/);
        if (parts[0] === 'Device') { headerPassed = true; return; }
        if (headerPassed && parts.length > 2) {
          const dev = parts[0];
          const awaitTime = parseFloat(parts[parts.length - 2] || '0.0'); // usually 'await' is second to last
          recentLatencies[dev] = { await: awaitTime, stalled: awaitTime > 150 };
        }
      });
    }
  } catch (err) {
    console.error('[Latency Profiler] Error reading I/O throughput:', err.message);
  }
}

function getLatestStalls() {
  return recentLatencies;
}

// Start continuous background profiling
setInterval(sampleMicroStalls, 2000);

module.exports = { getLatestStalls };
