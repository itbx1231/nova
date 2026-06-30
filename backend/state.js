// In-memory global state

const hosts = {
  'localhost': {
    name: 'Local Server',
    connectionType: 'local',
    status: 'online',
    disks: [],
    partitions: [],
    history: [],
    smartData: [],
    perfData: [],
    cpu: 0,
    mem: 0,
    network: { in: 0, out: 0, history: [] },
    networkInterfaces: [],
    os: 'Unknown',
    uptime: 0
  }
};

let currentDisks = [];
let eventLog = [];
let initialized = false;
let bandwidthHistory = [];
let networkDevices = {};
let sshConfigs = {};
let alertThresholds = { cpu: 90, mem: 90, disk: 90, temp: 70 };

const sshConnections = {};
const terminalStreams = {};
const activeScans = {};

module.exports = {
  hosts,
  currentDisks,
  eventLog,
  initialized,
  bandwidthHistory,
  networkDevices,
  sshConfigs,
  alertThresholds,
  sshConnections,
  terminalStreams,
  activeScans
};
