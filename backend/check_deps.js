try {
  require('ssh2');
  console.log('ssh2 OK');
} catch(e) {
  console.log('ssh2 MISSING:', e.message);
}

try {
  require('node-pty');
  console.log('node-pty OK');
} catch(e) {
  console.log('node-pty MISSING:', e.message);
}

// Check if sshConfigs gets loaded
const dotenv = require('dotenv');
dotenv.config();
const db = require('./database');

setTimeout(async () => {
  try {
    const hosts = await db.getSshHosts();
    console.log('SSH HOSTS COUNT:', hosts.length);
    hosts.forEach(h => {
      console.log('  -', h.host, h.name, 'user:', h.user, 'pass:', h.pass ? '***' : 'EMPTY');
    });
  } catch(e) {
    console.log('DB ERROR:', e.message);
  }
  process.exit(0);
}, 3000);
