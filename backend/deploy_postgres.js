const { Client } = require('ssh2');
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

    console.log('Uploading archive with PostgreSQL updates...');
    await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(localArchive, remoteArchive, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
    
    // Install Postgres
    console.log('Installing PostgreSQL...');
    await execRemote(`echo ${config.password} | sudo -S apt-get update`);
    await execRemote(`echo ${config.password} | sudo -S DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib`);
    
    // Setup Database
    console.log('Configuring Database...');
    try {
      await execRemote(`echo ${config.password} | sudo -S -u postgres psql -c "CREATE USER nova WITH PASSWORD 'nova_password';"`);
      await execRemote(`echo ${config.password} | sudo -S -u postgres psql -c "CREATE DATABASE nova_telemetry OWNER nova;"`);
    } catch(e) {
      console.log('DB might already exist. Continuing...');
    }

    // Deploy code
    await execRemote(`tar -xzf ${remoteArchive} -C ${targetDir}`);
    await execRemote(`echo "DATABASE_URL=postgres://nova:nova_password@127.0.0.1:5432/nova_telemetry" >> ${targetDir}/backend/.env`);
    
    console.log('Installing updated NPM dependencies (pg)...');
    await execRemote(`cd ${targetDir}/backend && npm install --production`);

    console.log('Restarting Backend...');
    await execRemote(`pm2 restart nova-noc`);

    console.log('PostgreSQL Migration & Deployment Complete!');
    conn.end();
  } catch(err) {
    console.error('DEPLOYMENT FAILED:', err);
    conn.end();
  }
};

deploy();
