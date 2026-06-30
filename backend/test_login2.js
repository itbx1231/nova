const db = require('./database');
const bcrypt = require('bcryptjs');

(async () => {
  try {
    const user = await db.getUser('root');
    console.log('User found:', user ? 'yes' : 'no');
    if (user) {
      const valid = await bcrypt.compare('root', user.password_hash);
      console.log('Password valid:', valid);
    }
  } catch(e) {
    console.log('Error:', e.message);
  }
})();
