const db = require('./database');
db.getSshHosts().then(hosts => {
  console.log('SSH Hosts count:', hosts.length);
  hosts.forEach(h => console.log('-', h.name, h.host, h.lastconnected ? 'connected' : 'never'));
  process.exit(0);
}).catch(e => console.log('Error:', e.message));
