require('dotenv').config();
const db = require('./database');

const hosts = [
  { host: '172.12.26.73', name: 'Zabbix 7.0 Server', user: 'sysadmin', pass: 'MMjknnkjm248756##@', port: 22, remotePath: '/opt/nova-agent', hubIp: '172.12.26.127' },
  { host: '192.168.2.33', name: '192.168.2.33', user: 'ubuntu', pass: 'root', port: 22, remotePath: '/opt/hdd-monitor', hubIp: 'localhost' },
  { host: '172.12.26.127', name: 'openzit', user: 'ubuntu', pass: 'root', port: 22, remotePath: '/opt/hdd-monitor', hubIp: 'localhost' },
  { host: '192.168.2.8', name: '192.168.2.8', user: 'ubuntu', pass: 'root', port: 22, remotePath: '/opt/hdd-monitor', hubIp: 'localhost' },
  { host: '172.12.26.47', name: 'zabbix-47', user: 'root', pass: 'Scammer@con', port: 22, remotePath: '/opt/hdd-monitor', hubIp: 'localhost' }
];

setTimeout(async () => {
  try {
    for (const h of hosts) {
      await db.saveSshHost(h);
      console.log('Added:', h.host, h.name);
    }
    const all = await db.getSshHosts();
    console.log('Total SSH hosts:', all.length);
  } catch(e) {
    console.error('ERROR:', e.message);
  }
  process.exit(0);
}, 3000);
