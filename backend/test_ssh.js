const { Client } = require('ssh2');

console.log('Testing SSH to 172.12.26.47...');

const conn = new Client();

conn.on('ready', () => {
  console.log('? SSH Connected successfully!');
  conn.end();
  process.exit(0);
});

conn.on('error', (err) => {
  console.log('? SSH Error:', err.message);
  process.exit(1);
});

conn.connect({
  host: '172.12.26.47',
  port: 22,
  username: 'root',
  password: 'Scammer@con',
  readyTimeout: 10000
});

setTimeout(() => {
  console.log('? Connection timeout');
  conn.end();
  process.exit(1);
}, 8000);
