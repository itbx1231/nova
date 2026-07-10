import React, { useState, useEffect } from 'react';

function App() {
  const [sysInfo, setSysInfo] = useState({
    cpu: 12,
    memory: { used: 4.2, total: 16.0 },
    disk: { used: 45, total: 100 },
    status: 'online'
  });

  const [netbirdPeers, setNetbirdPeers] = useState([
    { id: '100.64.0.1', name: 'Nova-Core', status: 'Connected', rx: '1.2 GB', tx: '850 MB' },
    { id: '100.64.0.2', name: 'MacBook-Admin', status: 'Connected', rx: '450 MB', tx: '120 MB' }
  ]);

  // In the future, we will fetch from actual APIs here
  // useEffect(() => { ...fetch('/api/sysinfo')... }, []);

  return (
    <div className="dashboard-container">
      <header>
        <div>
          <h1>Nova Dashboard</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            System Infrastructure & Zero-Trust Network
          </p>
        </div>
        <div className="glass-card" style={{ padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center' }}>
          <span className={`status-indicator ${sysInfo.status}`}></span>
          <span style={{ fontWeight: 600, textTransform: 'uppercase' }}>System {sysInfo.status}</span>
        </div>
      </header>

      <div className="section-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect>
          <rect x="9" y="9" width="6" height="6"></rect>
          <line x1="9" y1="1" x2="9" y2="4"></line>
          <line x1="15" y1="1" x2="15" y2="4"></line>
          <line x1="9" y1="20" x2="9" y2="23"></line>
          <line x1="15" y1="20" x2="15" y2="23"></line>
          <line x1="20" y1="9" x2="23" y2="9"></line>
          <line x1="20" y1="14" x2="23" y2="14"></line>
          <line x1="1" y1="9" x2="4" y2="9"></line>
          <line x1="1" y1="14" x2="4" y2="14"></line>
        </svg>
        Hardware Metrics
      </div>
      
      <div className="grid-metrics">
        <div className="glass-card metric-card">
          <span className="metric-title">CPU Usage</span>
          <span className={`metric-value ${sysInfo.cpu > 80 ? 'danger' : 'success'}`}>
            {sysInfo.cpu}%
          </span>
          <div style={{ background: 'rgba(255,255,255,0.1)', height: '4px', borderRadius: '2px', marginTop: 'auto' }}>
            <div style={{ background: 'var(--accent-color)', width: `${sysInfo.cpu}%`, height: '100%', borderRadius: '2px' }}></div>
          </div>
        </div>

        <div className="glass-card metric-card">
          <span className="metric-title">Memory Allocation</span>
          <span className={`metric-value ${sysInfo.memory.used / sysInfo.memory.total > 0.8 ? 'warning' : 'success'}`}>
            {sysInfo.memory.used} <span style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>/ {sysInfo.memory.total} GB</span>
          </span>
          <div style={{ background: 'rgba(255,255,255,0.1)', height: '4px', borderRadius: '2px', marginTop: 'auto' }}>
            <div style={{ background: 'var(--success-color)', width: `${(sysInfo.memory.used / sysInfo.memory.total) * 100}%`, height: '100%', borderRadius: '2px' }}></div>
          </div>
        </div>

        <div className="glass-card metric-card">
          <span className="metric-title">Disk Storage</span>
          <span className={`metric-value ${sysInfo.disk.used / sysInfo.disk.total > 0.9 ? 'danger' : 'success'}`}>
            {sysInfo.disk.used} <span style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>/ {sysInfo.disk.total} GB</span>
          </span>
          <div style={{ background: 'rgba(255,255,255,0.1)', height: '4px', borderRadius: '2px', marginTop: 'auto' }}>
            <div style={{ background: 'var(--warning-color)', width: `${(sysInfo.disk.used / sysInfo.disk.total) * 100}%`, height: '100%', borderRadius: '2px' }}></div>
          </div>
        </div>
      </div>

      <div className="section-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
        NetBird ZTNA Network
      </div>

      <div className="glass-card">
        <div className="netbird-list">
          {netbirdPeers.map(peer => (
            <div className="netbird-peer" key={peer.id}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>{peer.name}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.25rem' }}>{peer.id}</div>
              </div>
              <div style={{ display: 'flex', gap: '2rem', textAlign: 'right' }}>
                <div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase' }}>Traffic</div>
                  <div style={{ fontSize: '0.9rem' }}>↓ {peer.rx} &nbsp; ↑ {peer.tx}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className={`status-indicator ${peer.status === 'Connected' ? 'online' : 'offline'}`} style={{ animation: 'none' }}></span>
                  {peer.status}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
