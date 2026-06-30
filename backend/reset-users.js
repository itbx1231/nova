const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./telemetry.db', (err) => {
    if (err) console.error(err);
});

db.run('DELETE FROM users', function(err) {
    if (err) console.error(err);
    else console.log('Users table wiped. Removed users:', this.changes);
    db.close();
});
