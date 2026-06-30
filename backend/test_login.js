const bcrypt = require('bcryptjs');
const db = require('./database');

async function test() {
  const user = await db.getUser('root');
  if (!user) { console.log('No user found'); return; }
  
  // Test password 'root'
  const valid = await bcrypt.compare('root', user.password_hash);
  console.log('Password  root valid:', valid);
  
  // Test password 'root' again
  const valid2 = await bcrypt.compare('root', user.password_hash);
  console.log('Password root (2nd try):', valid2);
}
test();
