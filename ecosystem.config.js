// PM2 Ecosystem Configuration - Disk Monitoring System GUI
// Usage: pm2 start ecosystem.config.js
// Auto-restart: pm2 startup  (register as system service)

module.exports = {
  apps: [
    {
      name: 'dms-backend',
      cwd: './backend',
      script: 'index.js',
      watch: false,
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
        JWT_SECRET: 'CHANGE_ME_IN_PRODUCTION_USE_STRONG_SECRET',
      },
      error_file: './backend/backend_err.log',
      out_file:   './backend/backend.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },
    {
      name: 'dms-frontend',
      cwd: './frontend',
      script: 'npx',
      args: 'vite preview --host 0.0.0.0 --port 3000',
      watch: false,
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
      },
    }
  ]
};
