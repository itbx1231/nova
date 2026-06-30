const db = require('./database');
db.getUsers().then(u => {
  console.log('Users:', JSON.stringify(u, null, 2));
  process.exit(0);
}).catch(e => console.log('Error:', e.message));
