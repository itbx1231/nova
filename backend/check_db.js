const db = require('./database');
(async () => {
  try {
    const result = await db.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'');
    console.log('Tables:', result.rows.map(r => r.table_name).join(', '));
  } catch(e) { console.log('Error:', e.message); }
})();
