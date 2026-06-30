const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const config = {
  host: '172.12.26.127',
  port: 22,
  username: 'ubuntu',
  password: 'root',
  readyTimeout: 20000
};

const localArchive = path.join(__dirname, '..', 'nova-deploy.tar.gz');
const remoteArchive = '/home/ubuntu/nova-deploy.tar.gz';
const targetDir = '/opt/nova';

const conn = new Client();

const execRemote = (cmd) => {
  return new Promise((resolve, reject) => {
    console.log(`[EXEC] ${cmd}`);
    conn.exec(cmd, { pty: true }, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', (code, signal) => {
        console.log(`[EXIT ${code}] ${cmd}`);
        if (code !== 0) return reject(new Error(`Command failed with code ${code}: ${out}`));
        resolve(out);
      }).on('data', (data) => {
        out += data;
        process.stdout.write(data);
      }).stderr.on('data', (data) => {
        out += data;
        process.stderr.write(data);
      });
      // automatically answer sudo prompts if any
      stream.write(config.password + '\n');
    });
  });
};

const deploy = async () => {
  try {
    console.log('Connecting via SSH...');
    await new Promise((resolve, reject) => {
      conn.on('ready', resolve).on('error', reject).connect(config);
    });
    console.log('Connected!');

    console.log('Uploading archive...');
    await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(localArchive, remoteArchive, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
    console.log('Upload complete.');

    console.log('Provisioning Server...');
    await execRemote(`echo ${config.password} | sudo -S mkdir -p ${targetDir}`);
    await execRemote(`echo ${config.password} | sudo -S chown ubuntu:ubuntu ${targetDir}`);
    await execRemote(`tar -xzf ${remoteArchive} -C ${targetDir}`);
    
    // Install Node.js if missing
    console.log('Checking Node.js...');
    try {
      await execRemote('node -v');
    } catch(e) {
      console.log('Installing Node.js 20.x...');
      await execRemote(`echo ${config.password} | sudo -S curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -`);
      await execRemote(`echo ${config.password} | sudo -S apt-get install -y nodejs`);
    }

    // Install PM2
    try {
      await execRemote('pm2 -v');
    } catch(e) {
      console.log('Installing PM2...');
      await execRemote(`echo ${config.password} | sudo -S npm install -g pm2`);
    }

    // Build Backend
    console.log('Installing NPM dependencies...');
    await execRemote(`cd ${targetDir}/backend && npm install --production`);

    // Setup PM2
    console.log('Starting Nova Backend...');
    try {
      await execRemote(`pm2 delete nova-noc`);
    } catch(e){}
    await execRemote(`cd ${targetDir}/backend && pm2 start index.js --name "nova-noc"`);
    await execRemote(`pm2 save`);
    await execRemote(`echo ${config.password} | sudo -S env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu`);

    // Setup Nginx & SSL
    console.log('Setting up Nginx & SSL...');
    await execRemote(`echo ${config.password} | sudo -S apt-get update`);
    await execRemote(`echo ${config.password} | sudo -S apt-get install -y nginx openssl`);

    // Generate Self-Signed Cert
    await execRemote(`echo ${config.password} | sudo -S mkdir -p /etc/nginx/ssl`);
    await execRemote(`echo ${config.password} | sudo -S openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/nginx/ssl/nova.key -out /etc/nginx/ssl/nova.crt -subj "/C=US/ST=State/L=City/O=Nova/CN=172.12.26.127"`);

    const nginxConf = `
server {
    listen 80;
    server_name 172.12.26.127;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name 172.12.26.127;

    ssl_certificate /etc/nginx/ssl/nova.crt;
    ssl_certificate_key /etc/nginx/ssl/nova.key;

    location / {
        proxy_pass http://localhost:5010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
    `;
    await execRemote(`echo "${nginxConf.replace(/"/g, '\\"').replace(/\$/g, '\\$')}" | sudo tee /etc/nginx/sites-available/nova`);
    await execRemote(`echo ${config.password} | sudo -S ln -sf /etc/nginx/sites-available/nova /etc/nginx/sites-enabled/`);
    await execRemote(`echo ${config.password} | sudo -S rm -f /etc/nginx/sites-enabled/default`);
    await execRemote(`echo ${config.password} | sudo -S systemctl restart nginx`);

    // Firewall setup
    await execRemote(`echo ${config.password} | sudo -S ufw allow 80/tcp`);
    await execRemote(`echo ${config.password} | sudo -S ufw allow 443/tcp`);
    await execRemote(`echo ${config.password} | sudo -S ufw allow 5010/tcp`);

    console.log('Deployment Complete! Visit https://172.12.26.127');
    conn.end();
  } catch(err) {
    console.error('DEPLOYMENT FAILED:', err);
    conn.end();
  }
};

deploy();
