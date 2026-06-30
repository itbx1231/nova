;(function(){

// Global runtime error protection
window.addEventListener('error', e => {
   console.error('[NOVA Runtime]', e.error);
});
window.addEventListener('unhandledrejection', e => {
   console.error('[NOVA Runtime] Unhandled rejection:', e.reason);
});

'use strict';
/* ═══════════════════════════════════════════════════════════════
   NOVA SCAN CENTER  v3  —  Enterprise Cyber Operations Console
   Pure DOM overlay · Zero React modifications
   ═══════════════════════════════════════════════════════════════ */

var S={
  host:'localhost',mode:'deep',status:'idle',
  progress:0,steps:[],logs:[],report:null,
  hosts:{},connected:false,socket:null,jobId:null,
  portResults:[],portProgress:0,portStatus:'idle',portLogs:[],
  portTarget:'',portMode:'quick',activeTab:'setup',
  scanStart:0,elapsed:0,elapsedTimer:null,_hangTimer:null,_scanLock:false,
  history:null,historyAlert:null,historyLoading:false,
  termPaused:false,termQuery:'',
  modeFilter:'all',modeSearch:'',selectedModes:{},lastScore:null,lastHealth:null,scanQueue:[],_cancelled:false,
  opened:false,     // panel opens ONLY when the user clicks a scan entry button
  findFilter:'all', findArea:'all', soundOn:true, cmpSel:{}, schedule:null, _schedLoaded:false,
  fleetStatus:'idle', fleetMode:'deep', fleetHosts:[], fleetResults:{}, fleetSummary:null, fleetId:null
};
// Category mapping for the SETUP filter tabs (deep/full are cross-cutting → 'All')
var MODE_CAT={security:'Security',kernel:'Performance',filesystem:'Storage',services:'Performance',
  logs:'Performance',network:'Network',docker:'Performance',database:'Database',deep:'All',full:'All'};
var MODE_CATS=['All','Security','Performance','Network','Storage','Database'];
var _vis=false,_hooked=false,_layoutTimer=null,_ownSocket=null,_ioLoading=false;
var INFRA={
  status:'idle',target:'',mode:'quick',results:[],progress:0,logs:[],completeData:null
};
var _psState={
  target:'',mode:'quick',status:'idle',results:[],progress:0,logs:[],completeData:null,
  scanned:0,total:0,openCount:0,elapsed:0,logPaused:false,customPorts:''
};
// _updatePSUI - base definition (overridden later for port scanner phases)
function _updatePSUI() {};

function tok(){return localStorage.getItem('dms_token')||'';}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmt(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60);return m>0?m+'m '+(s%60)+'s':s+'s';}

/* ─── Layout ──────────────────────────────────────────────────────
   Robustly align the overlay to the host app's REAL sidebar + topbar.
   The previous version grabbed the first nav/aside (often the wrong
   element) and clamped width to 180px → overlap under a wider sidebar.
   Now we score candidates and align to the sidebar's right edge and
   the topbar's bottom edge, so any width/offset is handled exactly. */
function _rect(elm){ try{return elm.getBoundingClientRect();}catch(e){return null;} }
function findSidebar(){
  var vh=window.innerHeight, best=null, bestRight=-1;
  // PRIMARY — geometric, class-agnostic. Probe the far-left strip at several heights
  // and, for each hit, climb to the OUTERMOST left-docked tall-ish container (the rail).
  try{
    var ys=[0.2,0.35,0.5,0.65,0.8];
    for(var k=0;k<ys.length;k++){
      var node=document.elementFromPoint(3,Math.round(vh*ys[k])), chosen=null;
      while(node&&node!==document.body&&node.nodeType===1){
        if(node.id==='_nsc'||(node.closest&&node.closest('#_nsc'))){chosen=null;break;}
        var r=_rect(node);
        if(r&&r.left<=4&&r.width>=30&&r.width<=520&&r.height>=vh*0.5) chosen=node; // keep climbing → outermost match
        node=node.parentElement;
      }
      if(chosen){var rr=_rect(chosen); if(rr.right>bestRight){bestRight=rr.right;best=chosen;}}
    }
    if(best) return best;
  }catch(e){}
  // FALLBACK — class/tag heuristic (widest left-docked tall element).
  var cands=document.querySelectorAll('nav,aside,[class*="sidebar"],[class*="Sidebar"],[class*="side-nav"],[class*="SideNav"],[class*="rail"],[class*="Rail"],[class*="drawer"],[class*="menu"]');
  for(var i=0;i<cands.length;i++){
    var c=cands[i]; if(c.closest&&c.closest('#_nsc')) continue;
    var cr=_rect(c); if(!cr) continue;
    if(cr.left>8||cr.width<30||cr.width>520||cr.height<vh*0.5) continue;
    if(cr.right>bestRight){bestRight=cr.right;best=c;}
  }
  return best;
}
function findTopbar(){
  var vw=window.innerWidth, best=null, bestScore=-1;
  var cands=document.querySelectorAll('header,[class*="topbar"],[class*="Topbar"],[class*="top-bar"],[class*="navbar"],[class*="Navbar"],[class*="app-header"],[class*="AppHeader"]');
  for(var i=0;i<cands.length;i++){
    var c=cands[i]; if(c.closest&&c.closest('#_nsc')) continue;
    var r=_rect(c); if(!r) continue;
    if(r.top>12) continue;             // pinned to the top
    if(r.width<vw*0.5) continue;       // spans most of the width
    if(r.height<28||r.height>140) continue; // header-ish height
    if(r.width>bestScore){bestScore=r.width;best=c;}
  }
  return best;
}
// Right edge of the WHOLE left navigation region (narrow rail + the sections panel
// with Servers / Scan Center / Storage ...). Probes several x positions across the
// left zone and takes the farthest right edge of a nav-style column, so the integrated
// window starts AFTER the section bar and keeps it visible.
function findNavRight(){
  var vh=window.innerHeight, maxRight=0, xs=[4,80,160,240,320,400,460];
  for(var i=0;i<xs.length;i++){
    var node=document.elementFromPoint(xs[i],Math.round(vh*0.5)), chosen=null;
    while(node&&node!==document.body&&node.nodeType===1){
      if(node.id==='_nsc'||(node.closest&&node.closest('#_nsc'))){chosen=null;break;}
      var r=_rect(node);
      if(r&&r.left<480&&r.width>=40&&r.width<=360&&r.height>=vh*0.55) chosen=node; // a nav column
      node=node.parentElement;
    }
    if(chosen){var rr=Math.round(_rect(chosen).right); if(rr>maxRight&&rr<600) maxRight=rr;}
  }
  return maxRight;
}
function layout(){
  var el=document.getElementById('_nsc');if(!el)return;
  // ONE integrated workspace window that starts AFTER the host's left section bar
  // (so Servers / Scan Center / ... stay visible) and fills the rest of the screen.
  var hdr=findTopbar();
  var top=hdr?Math.max(0,Math.round(_rect(hdr).bottom)):48;
  el.style.top=top+'px';
  el.style.right='0px';
  el.style.width='auto';
  if(window.innerWidth<=1100){ el.style.left='0px'; return; }
  var navR=findNavRight();
  el.style.left=(navR>0?(navR+16):0)+'px';
}
function relayoutSoon(){ [0,250,600,1200].forEach(function(d){ setTimeout(function(){layout();},d); }); }

/* ─── SVG Icons ───────────────────────────────────────────────── */
var ICO={
  scan:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v3l2 2"/></svg>',
  cpu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
  shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  kernel:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>',
  storage:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9"/><path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4"/></svg>',
  network:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="9" y="16" width="6" height="6" rx="1"/><path d="M5 8v3h14V8M12 11v5"/></svg>',
  forensic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  full:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  server:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>',
  terminal:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  ai:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a5 5 0 0 1 5 5v1a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5z"/><path d="M3 20a9 9 0 0 1 18 0"/><circle cx="12" cy="8" r="1" fill="currentColor"/></svg>',
  alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
  port:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M7 8h.01M11 8h.01M15 8h.01"/></svg>',
  pulse:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
};
function ico(k,sz,col){sz=sz||16;col=col||'currentColor';
  return'<span style="display:inline-flex;align-items:center;justify-content:center;width:'+sz+'px;height:'+sz+'px;color:'+col+';flex-shrink:0">'+ICO[k]+'</span>';}

/* ─── Scan modes ──────────────────────────────────────────────── */
var MODES=[
  {id:'security',  ico:'shield',  t:'Security Audit',       d:'Threat detection, auth & malware indicators',   dur:'~1 min', risk:'low',  depth:'Security', checks:14, perms:'SSH read-only · sudo: sshd -T, iptables -L',
   caps:['SSH hardening (root login, password auth)','SSH failures & brute force','Firewall & Fail2Ban status','Sudo abuse & priv escalation','Exposed ports & dangerous services','SUID & world-writable files','Suspicious processes & /tmp executables','Cron & startup persistence']},
  {id:'kernel',    ico:'kernel',  t:'Kernel Analysis',      d:'dmesg, panics, OOM, drivers, MCE faults',       dur:'~30s',   risk:'low',  depth:'Kernel', checks:9, perms:'sudo: dmesg, journalctl -k',
   caps:['Kernel ring buffer & panics','OOM killer events','Hardware MCE / EDAC errors','Hung tasks & D-state procs','Driver / module failures','Thermal throttling']},
  {id:'filesystem',ico:'storage', t:'Filesystem Intel',     d:'Mounts, inodes, SMART, corruption indicators',  dur:'~45s',   risk:'low',  depth:'Storage', checks:11, perms:'sudo: smartctl, lsof',
   caps:['Mount saturation & inode usage','SMART disk health','Filesystem corruption (ext4/xfs)','ZFS pool health','Deleted-open file leaks','RAID / LVM status']},
  {id:'services',  ico:'pulse',   t:'Service Analysis',     d:'systemd units, PM2, restart loops, deps',       dur:'~30s',   risk:'low',  depth:'Services', checks:8, perms:'SSH read-only',
   caps:['systemd failed & activating units','PM2 process states','Restart-loop detection','Running unit count','Dependency failures']},
  {id:'logs',      ico:'scan',    t:'Log Intelligence',     d:'Aggregate journals, syslog, app logs',           dur:'~1 min', risk:'low',  depth:'Logs', checks:10, perms:'sudo: journalctl',
   caps:['journalctl error aggregation','auth.log brute force','nginx / database log scan','Top recurring error patterns','Segfault / core-dump / timeout counters']},
  {id:'network',   ico:'full',    t:'Network Diagnostics',  d:'Routing, DNS, latency, connection storms',      dur:'~30s',   risk:'low',  depth:'Network', checks:11, perms:'SSH read-only',
   caps:['Gateway reachability & ICMP loss','DNS resolution health','Listening ports & sockets','Established TCP map','TLS certificate expiry','Interface error/drop counters']},
  {id:'docker',    ico:'pulse',   t:'Docker & Containers',  d:'Container runtime, health, restart loops',       dur:'~30s',   risk:'low',  depth:'Docker', checks:8, perms:'docker group / sudo',
   caps:['docker ps & health states','Unhealthy + restart loops','docker stats CPU / memory','Images, volumes, networks','Engine version & driver']},
  {id:'database',  ico:'scan',    t:'Database Analysis',    d:'Postgres / MySQL / Redis / MongoDB',             dur:'~45s',   risk:'low',  depth:'DB', checks:10, perms:'sudo: -u postgres psql',
   caps:['Engine detection & version','Connections vs max & slow queries','Lock contention (PG)','Cache hit ratio (PG)','Replication state','Redis BGSAVE & memory']},
  {id:'deep',      ico:'pulse',   t:'Deep Analysis',        d:'All subsystems with AI correlation',            dur:'~3 min', risk:'med',  depth:'Full', checks:32, perms:'sudo for SMART/sshd/iptables/journal',
   caps:['Every focused mode combined','Multi-signal AI correlation','Root-cause inference','Weighted health scoring','Remediation playbooks']},
  {id:'full',      ico:'full',    t:'Full Investigation',   d:'Maximum-depth forensic audit',                  dur:'~5 min', risk:'med',  depth:'Maximum', checks:50, perms:'sudo for all privileged probes',
   caps:['Deep mode + extended sweeps','SUID inventory & app logs','Connection storm detection','DB log forensics','All evidence packed']}
];

var STEP_ICONS={system:'cpu',kernel:'kernel',filesystem:'storage',logs:'terminal',services:'server',network:'network',security:'shield',docker:'pulse',database:'scan',correlation:'ai',rootcause:'alert',report:'forensic'};
var STEP_META_DEFAULT=[
  {id:'system',     n:'System Snapshot',     i:'cpu'    },
  {id:'kernel',     n:'Kernel Analysis',     i:'kernel' },
  {id:'filesystem', n:'Filesystem',          i:'storage'},
  {id:'logs',       n:'Log Aggregation',     i:'terminal'},
  {id:'services',   n:'Service Check',       i:'server' },
  {id:'network',    n:'Network',             i:'network'},
  {id:'security',   n:'Security Scan',       i:'shield' },
  {id:'docker',     n:'Containers',          i:'pulse'  },
  {id:'database',   n:'Databases',           i:'scan'   },
  {id:'correlation',n:'AI Correlation',      i:'ai'     },
  {id:'rootcause',  n:'Root Cause',          i:'alert'  },
  {id:'report',     n:'Report',              i:'forensic'}
];
var STEP_META=STEP_META_DEFAULT.slice();

/* ─── CSS ─────────────────────────────────────────────────────── */
var CSS=`
@keyframes _nsc_pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes _nsc_spin{to{transform:rotate(360deg)}}
@keyframes _nsc_glow{0%,100%{box-shadow:0 0 8px rgba(34,211,238,.2)}50%{box-shadow:0 0 18px rgba(34,211,238,.5)}}
@keyframes _nsc_scan{0%{transform:translateY(0);opacity:.8}100%{transform:translateY(100%);opacity:0}}
@keyframes _nsc_fadein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

#_nsc{
  position:fixed;left:0;right:0;top:48px;bottom:0;z-index:2147483000;
  background:linear-gradient(160deg,#05040d 0%,#080714 40%,#060511 100%);
  display:none;flex-direction:column;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif;
  color:#e4e4e7;
}
@media (max-width:1100px){#_nsc{left:0;top:0}}
#_nsc,#_nsc *{box-sizing:border-box}
#_nsc.vis{display:flex;animation:_nsc_panelin .32s cubic-bezier(.4,0,.2,1)}
#_nsc.vis._closing{animation:_nsc_panelout .22s cubic-bezier(.4,0,.2,1) forwards}
@keyframes _nsc_panelin{from{opacity:0;transform:translateY(10px) scale(.994)}to{opacity:1;transform:none}}
@keyframes _nsc_panelout{from{opacity:1;transform:none}to{opacity:0;transform:translateY(8px) scale(.994)}}
._sndbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;
  cursor:pointer;background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.3);color:#22d3ee;transition:all .15s}
._sndbtn:hover{background:rgba(34,211,238,.2)}
._sndbtn.off{background:rgba(82,82,91,.12);border-color:rgba(82,82,91,.3);color:#52525b}
._sndbtn:focus-visible{outline:2px solid #22d3ee;outline-offset:2px}
._ffbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:10px}
._ffchip{font-size:10px;font-weight:700;padding:5px 11px;border-radius:7px;cursor:pointer;
  background:transparent;border:1px solid rgba(255,255,255,.08);color:#8b9bb4;transition:all .15s}
._ffchip:hover{border-color:rgba(34,211,238,.3);color:#cbd5e1}
._ffchip.on{background:rgba(34,211,238,.12);border-color:rgba(34,211,238,.4);color:#22d3ee}
._ffchip b{font-weight:800}
._ffarea{margin-left:auto;background:#0d1420;border:1px solid #1c2738;border-radius:7px;padding:5px 9px;
  color:#e2e8f0;font-size:10px;font-family:inherit;outline:none;cursor:pointer}
._resact{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
._actbtn{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;padding:12px 14px;border-radius:10px;
  cursor:pointer;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.1);color:#8b9bb4;transition:all .15s;white-space:nowrap}
._actbtn:hover{color:#e2e8f0;border-color:rgba(34,211,238,.35);background:rgba(34,211,238,.06)}
._actbtn svg{flex:0 0 auto}
._xbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;
  cursor:pointer;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#f87171;
  font-size:15px;font-weight:700;line-height:1;transition:all .15s}
._xbtn:hover{background:rgba(239,68,68,.22);box-shadow:0 0 12px rgba(239,68,68,.25)}
._xbtn:focus-visible{outline:2px solid #f87171;outline-offset:2px}

/* ── Header ── */
._nh{
  display:flex;align-items:center;gap:14px;
  padding:0 22px;height:52px;flex-shrink:0;
  background:rgba(0,0,0,.6);backdrop-filter:blur(20px);
  border-bottom:1px solid rgba(34,211,238,.1);
  position:relative;overflow:hidden;
}
._nh::after{
  content:'';position:absolute;bottom:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(34,211,238,.4),transparent);
}
._nhl{display:flex;align-items:center;gap:10px}
._nht{font-size:11px;font-weight:800;letter-spacing:.16em;color:#22d3ee;text-transform:uppercase}
._nhs{font-size:10px;color:#3f3f46;letter-spacing:.04em}
._nhr{display:flex;align-items:center;gap:12px;margin-left:auto}
._homebtn{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:800;
  letter-spacing:.06em;text-transform:uppercase;padding:7px 13px;border-radius:9px;cursor:pointer;
  background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.35);color:#22d3ee;transition:all .15s}
._homebtn:hover{background:rgba(34,211,238,.2);box-shadow:0 0 14px rgba(34,211,238,.2)}
._homebtn:focus-visible{outline:2px solid #22d3ee;outline-offset:2px}
._homebtn svg{flex:0 0 auto}
._nhstat{display:flex;align-items:center;gap:5px;font-size:10px}
._nhstatv{font-weight:700}
._dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:all .4s}
._dot.on{background:#4ade80;box-shadow:0 0 8px #4ade8060;animation:_nsc_glow 2s infinite}
._dot.off{background:#ef4444}
._dot.pulsing{background:#f59e0b;animation:_nsc_pulse 1s infinite}

/* ── Tabs ── */
._ntbar{
  display:flex;border-bottom:1px solid rgba(255,255,255,.05);
  background:rgba(0,0,0,.35);flex-shrink:0;padding:0 8px;
  gap:2px;
}
._nt{
  display:flex;align-items:center;gap:6px;
  padding:0 16px;height:38px;font-size:10px;font-weight:600;
  letter-spacing:.06em;text-transform:uppercase;cursor:pointer;
  border:none;background:transparent;color:#52525b;
  border-bottom:2px solid transparent;
  transition:color .15s,border-color .15s;outline:none;white-space:nowrap;
}
._nt svg{width:13px;height:13px;opacity:.6;transition:opacity .15s}
._nt.on{color:#22d3ee;border-bottom-color:#22d3ee}
._nt.on svg{opacity:1}
._nt.alert-tab.on{color:#f97316;border-bottom-color:#f97316}

/* ── Body ── */
._nb{flex:1;overflow:hidden;position:relative}
._nv{display:none;position:absolute;inset:0;overflow-y:auto;padding:20px 28px 28px}
._progright{display:flex;align-items:center;gap:14px}
._stopbtn{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.04em;
  padding:7px 14px;border-radius:9px;cursor:pointer;background:rgba(220,38,38,.12);
  border:1px solid rgba(220,38,38,.4);color:#f87171;transition:all .15s}
._stopbtn:hover{background:rgba(220,38,38,.2);box-shadow:0 0 14px rgba(220,38,38,.2)}
._stopbtn:focus-visible{outline:2px solid #f87171;outline-offset:2px}
._stopbtn svg{flex:0 0 auto}
._nv.on{display:block;animation:_nsc_fadein .2s ease}
._nv::-webkit-scrollbar{width:5px}
._nv::-webkit-scrollbar-track{background:rgba(255,255,255,.02)}
._nv::-webkit-scrollbar-thumb{background:rgba(34,211,238,.2);border-radius:3px}
._nv::-webkit-scrollbar-thumb:hover{background:rgba(34,211,238,.35)}

/* ── Section heading ── */
._sh{
  display:flex;align-items:center;gap:10px;
  font-size:9px;font-weight:800;letter-spacing:.14em;
  color:#3f3f46;text-transform:uppercase;margin:18px 0 10px;
}
._sh:first-child{margin-top:0}
._sh::before{content:'◈';color:#22d3ee;font-size:9px}
._sh::after{content:'';flex:1;height:1px;background:rgba(255,255,255,.04)}

/* ── Setup: compact server bar ── */
._setwrap{display:flex;flex-direction:column;gap:16px;min-height:100%}
._setsh{display:flex;align-items:center;gap:7px;font-size:9px;font-weight:800;letter-spacing:.14em;
  color:#52525b;text-transform:uppercase;margin-bottom:9px}
._setsh svg{flex:0 0 auto}
._svbar{display:flex;gap:9px;overflow-x:auto;padding-bottom:4px}
._svbar::-webkit-scrollbar{height:3px}._svbar::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1)}
._svchip{display:flex;align-items:center;gap:11px;cursor:pointer;flex-shrink:0;
  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:11px;
  padding:10px 15px;transition:all .18s;text-align:left;color:inherit;font:inherit}
._svchip:hover{border-color:rgba(34,211,238,.25);background:rgba(34,211,238,.03)}
._svchip.on{border-color:rgba(34,211,238,.5);background:rgba(34,211,238,.07);box-shadow:0 0 20px rgba(34,211,238,.08)}
._svdot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
._svdot.on{background:#4ade80;box-shadow:0 0 7px #4ade8070}
._svdot.off{background:#ef4444}._svdot.unk{background:#71717a}
._svmeta{display:flex;flex-direction:column;min-width:0}
._svn{font-size:12px;font-weight:700;color:#f4f4f5;white-space:nowrap}
._sva{font-size:9.5px;color:#52525b;font-family:'JetBrains Mono',monospace;white-space:nowrap}
._svmetrics{display:flex;gap:13px;border-left:1px solid rgba(255,255,255,.07);padding-left:13px;margin-left:2px}
._svm{display:flex;flex-direction:column;align-items:center}
._svml{font-size:8px;color:#52525b;letter-spacing:.08em}
._svmv{font-size:12px;font-weight:800;font-family:'JetBrains Mono',monospace}
/* ── Daily auto-scan scheduler ── */
._schbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  background:rgba(0,0,0,.25);border:1px solid #1c2738;border-radius:11px;padding:10px 14px;margin-bottom:2px}
._schbar svg{flex:0 0 auto}
._schl{font-size:11px;font-weight:700;color:#cbd5e1}
._schtog{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:10px;color:#8b9bb4;font-weight:700}
._schtog input{width:14px;height:14px;cursor:pointer;accent-color:#22c55e}
._schat{font-size:10px;color:#52525b}
._schtime{width:46px;background:#0d1420;border:1px solid #1c2738;border-radius:6px;padding:4px 6px;
  color:#e2e8f0;font-size:12px;font-family:ui-monospace,monospace;text-align:center;outline:none}
._schtime:focus{border-color:rgba(34,211,238,.4)}
._schsave{font-size:10px;font-weight:700;padding:6px 13px;border-radius:7px;cursor:pointer;
  background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.3);color:#22d3ee;transition:all .15s}
._schsave:hover{background:rgba(34,211,238,.2)}
._schmsg{font-size:10px;font-weight:700;margin-left:4px}

/* ── Setup body: grid + details ── */
._setbody{display:flex;gap:16px;align-items:flex-start}
._setleft{flex:1;min-width:0}
._setright{width:320px;flex-shrink:0}
@media (max-width:1000px){._setbody{flex-direction:column}._setright{width:100%}}
._setfoot{margin-top:auto;padding-top:2px}

/* ── Compact mode grid ── */
._mg{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
._mc{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);
  border-radius:12px;padding:13px;cursor:pointer;transition:all .18s;text-align:left;
  color:inherit;font:inherit;display:flex;flex-direction:column;position:relative;overflow:hidden}
._mc:hover{border-color:rgba(255,255,255,.16);transform:translateY(-2px)}
._mc:hover ._mcico{box-shadow:0 0 14px rgba(34,211,238,.3)}
._mc.on{border-color:rgba(34,211,238,.5);background:rgba(34,211,238,.06);box-shadow:0 0 20px rgba(34,211,238,.1)}
._mctop{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
._mcico{width:34px;height:34px;border-radius:9px;background:rgba(34,211,238,.08);
  border:1px solid rgba(34,211,238,.15);display:flex;align-items:center;justify-content:center;
  color:#22d3ee;transition:box-shadow .2s}
._mcrisk{font-size:8px;font-weight:800;padding:2px 7px;border-radius:20px;letter-spacing:.05em}
._mct{font-size:12px;font-weight:700;color:#f4f4f5;margin-bottom:3px;line-height:1.2}
._mcd{font-size:9.5px;color:#71717a;line-height:1.4;margin-bottom:10px;flex:1}
._mcfoot{display:flex;align-items:center;justify-content:space-between;
  border-top:1px solid rgba(255,255,255,.05);padding-top:8px}
._mcchk{font-size:9.5px;font-weight:700;color:#22d3ee}
._mcdur{font-size:9.5px;color:#52525b;display:flex;align-items:center;gap:3px}
._mcdur svg{flex:0 0 auto}
.mb-lo{background:rgba(74,222,128,.1);color:#4ade80}
.mb-me{background:rgba(234,179,8,.1);color:#eab308}
.mb-hi{background:rgba(239,68,68,.12);color:#ef4444}

/* ── Mode details panel ── */
._mdpanel{background:rgba(0,0,0,.3);border:1px solid rgba(34,211,238,.12);border-radius:14px;
  padding:18px;animation:_nsc_fadein .25s ease}
._mdhead{display:flex;align-items:center;gap:12px;margin-bottom:12px}
._mdico{width:42px;height:42px;border-radius:11px;background:rgba(34,211,238,.08);
  border:1px solid rgba(34,211,238,.2);display:flex;align-items:center;justify-content:center;flex-shrink:0}
._mdt{font-size:15px;font-weight:800;color:#f4f4f5}
._mdsub{font-size:9.5px;color:#52525b;text-transform:uppercase;letter-spacing:.07em}
._mdd{font-size:11px;color:#a1a1aa;line-height:1.55;margin-bottom:14px}
._mdstats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
._mdstat{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05);
  border-radius:9px;padding:9px 6px;text-align:center}
._mdsv{font-size:17px;font-weight:800;color:#22d3ee;line-height:1.1}
._mdsl{font-size:8px;color:#52525b;text-transform:uppercase;letter-spacing:.07em;margin-top:3px}
._mdsh{font-size:9px;font-weight:800;letter-spacing:.12em;color:#52525b;text-transform:uppercase;margin-bottom:9px}
._mdcaps{list-style:none;padding:0;margin:0 0 14px}
._mdcaps li{display:flex;align-items:flex-start;gap:8px;font-size:11px;color:#c4c4c8;padding:5px 0;line-height:1.4}
._mdcaps li svg{flex:0 0 auto;margin-top:2px}
._mdperm{display:flex;align-items:center;gap:7px;font-size:10px;color:#818cf8;
  background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.15);border-radius:8px;padding:8px 11px}
._mdperm svg{flex:0 0 auto}

/* ── Setup summary: health ring + live badge ── */
._setsummary{display:flex;align-items:center;justify-content:space-between;gap:14px;
  background:linear-gradient(135deg,rgba(34,211,238,.05),transparent 60%),#111824;
  border:1px solid #1c2738;border-radius:14px;padding:12px 18px;margin-bottom:2px}
._hsring{display:flex;align-items:center;gap:13px}
._hsmeta{display:flex;flex-direction:column}
._hslbl{font-size:9px;font-weight:800;letter-spacing:.12em;color:#64748b;text-transform:uppercase}
._hsval{font-size:13px;font-weight:800;margin-top:2px}
._livebadge{display:inline-flex;align-items:center;gap:8px;font-size:10px;font-weight:800;
  letter-spacing:.1em;padding:7px 14px;border-radius:20px;font-family:ui-monospace,monospace}
._livebadge._lbdot,._livebadge ._lbdot{width:8px;height:8px;border-radius:50%}
._livebadge.idle{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:#22c55e}
._livebadge.idle ._lbdot{background:#22c55e;animation:_nsc_pulse 2.4s infinite}
._livebadge.live{background:rgba(34,211,238,.12);border:1px solid rgba(34,211,238,.35);color:#22d3ee}
._livebadge.live ._lbdot{background:#22d3ee;box-shadow:0 0 8px #22d3ee;animation:_nsc_pulse 1s infinite}

/* ── Server chip gauges + pulsing dot ── */
._svdot.on{animation:_nsc_pulse 2.2s infinite}
._svgauges{display:flex;gap:10px;border-left:1px solid rgba(255,255,255,.07);padding-left:12px;margin-left:2px}
._svg{display:flex;flex-direction:column;align-items:center;gap:2px}
._svgl{font-size:8px;font-weight:700;letter-spacing:.08em;color:#64748b}
._svup{display:flex;align-items:center;gap:4px;font-size:9px;color:#64748b;font-family:ui-monospace,monospace;margin-top:2px}
._svup svg{flex:0 0 auto}

/* ── Category tabs + search toolbar ── */
._settoolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:6px 0 4px}
._catfs{display:flex;gap:4px;flex-wrap:wrap}
._catf{font-size:10px;font-weight:700;letter-spacing:.04em;padding:6px 13px;border-radius:8px;cursor:pointer;
  background:transparent;border:1px solid rgba(255,255,255,.07);color:#8b9bb4;transition:all .15s}
._catf:hover{border-color:rgba(34,211,238,.3);color:#cbd5e1}
._catf.on{background:rgba(34,211,238,.12);border-color:rgba(34,211,238,.4);color:#22d3ee}
._catf:focus-visible{outline:2px solid #22d3ee;outline-offset:2px}
._setsearch{display:flex;align-items:center;gap:7px;background:#0d1420;border:1px solid #1c2738;
  border-radius:9px;padding:6px 11px;min-width:200px;flex:0 1 240px}
._setsearch svg{flex:0 0 auto}
._setsearch input{flex:1;background:transparent;border:none;outline:none;color:#e2e8f0;font-size:11px;font-family:inherit}
._setsearch input::placeholder{color:#475569}
._nomatch{grid-column:1/-1;text-align:center;padding:36px 20px;color:#475569;font-size:11px}
._nomatch svg{width:30px;height:30px;opacity:.4;margin-bottom:8px}

/* ── Mode card: checkbox, refined pill, glow, entrance, focus ── */
._mc{animation:_nsc_fadein .35s ease backwards}
._mc:nth-child(1){animation-delay:.02s}._mc:nth-child(2){animation-delay:.06s}
._mc:nth-child(3){animation-delay:.1s}._mc:nth-child(4){animation-delay:.14s}
._mc:nth-child(5){animation-delay:.18s}._mc:nth-child(6){animation-delay:.22s}
._mc:nth-child(7){animation-delay:.26s}._mc:nth-child(8){animation-delay:.3s}
._mc:focus-visible{outline:2px solid #22d3ee;outline-offset:2px}
._mc.fx-me{border-color:rgba(245,158,11,.28)}
._mc.fx-me:hover,._mc.fx-me.on{box-shadow:0 0 18px rgba(245,158,11,.14)}
._mc.fx-hi{border-color:rgba(239,68,68,.3)}
._mc.fx-hi:hover,._mc.fx-hi.on{box-shadow:0 0 18px rgba(239,68,68,.16)}
._mc.sel{border-color:rgba(34,211,238,.45);background:rgba(34,211,238,.04)}
._mcchkbox{position:absolute;top:9px;right:9px;z-index:2;display:flex;cursor:pointer}
._mcchkbox input{width:15px;height:15px;cursor:pointer;accent-color:#22d3ee}
._mcrisk{display:inline-flex;align-items:center;gap:5px}
._rdot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
.mb-lo{background:rgba(34,197,94,.1);color:#22c55e}
.mb-me{background:rgba(245,158,11,.12);color:#f59e0b}
.mb-hi{background:rgba(239,68,68,.14);color:#ef4444}

/* ── Sticky detail panel ── */
._setright{position:sticky;top:8px;align-self:flex-start}

/* ── Bulk action buttons ── */
._setfoot{display:flex;align-items:center;gap:10px}
._bulk{display:flex;gap:8px;flex-shrink:0}
._bbtn{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;
  padding:11px 15px;border-radius:10px;cursor:pointer;white-space:nowrap;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.1);color:#8b9bb4;transition:all .15s}
._bbtn:hover:not(:disabled){color:#e2e8f0;border-color:rgba(255,255,255,.2)}
._bbtn.active{border-color:rgba(34,211,238,.4);color:#22d3ee;background:rgba(34,211,238,.08)}
._bbtn:disabled{opacity:.4;cursor:not-allowed}
._bbtn svg{flex:0 0 auto}
._setfoot ._launch{flex:1;margin-top:0}
@media (max-width:760px){._setfoot{flex-wrap:wrap}._bulk{width:100%}._bbtn{flex:1}}

/* ── Launch button ── */
._launch{
  width:100%;padding:14px;border-radius:10px;border:none;cursor:pointer;
  font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  transition:all .25s;margin-top:4px;position:relative;overflow:hidden;
  display:flex;align-items:center;justify-content:center;gap:10px;
}
._launch.go{
  background:linear-gradient(90deg,#0c4a6e 0%,#1e1b4b 50%,#0c4a6e 100%);
  background-size:200% 100%;
  border:1px solid rgba(34,211,238,.35);
  color:#22d3ee;
  box-shadow:0 0 30px rgba(34,211,238,.12),inset 0 1px 0 rgba(255,255,255,.08);
  animation:_nsc_pulse 3s infinite;
}
._launch.go:hover{
  background-position:right center;
  box-shadow:0 0 40px rgba(34,211,238,.25),inset 0 1px 0 rgba(255,255,255,.1);
  transform:translateY(-2px);animation:none;
}
._launch.go:active{transform:translateY(0)}
._launch.running{
  background:linear-gradient(90deg,#1e3a2e,#1a1040,#1e3a2e);
  border:1px solid rgba(99,102,241,.4);color:#818cf8;
  cursor:not-allowed;animation:none;
}
._launch.dis{
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);
  color:#3f3f46;cursor:not-allowed;animation:none;
}

/* ── Progress view ── */
._progwrap{animation:_nsc_fadein .3s ease}
._proghead{
  background:rgba(0,0,0,.5);border:1px solid rgba(34,211,238,.12);
  border-radius:12px;padding:16px 18px;margin-bottom:14px;
  position:relative;overflow:hidden;
}
._proghead::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(34,211,238,.5),transparent);
}
._progtop{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
._progtarget{font-size:14px;font-weight:700;color:#f4f4f5;display:flex;align-items:center;gap:8px}
._progpct{font-size:28px;font-weight:900;color:#22d3ee;letter-spacing:-.02em;line-height:1}
._progbar{height:6px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden;margin-bottom:8px}
._progfill{height:100%;border-radius:3px;transition:width .6s ease;
  background:linear-gradient(90deg,#0891b2,#6366f1,#8b5cf6)}
._progmeta{display:flex;gap:20px}
._progm{font-size:10px;color:#52525b;display:flex;align-items:center;gap:5px}
._progm span{color:#a1a1aa;font-weight:600}

._stepgrid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(160px,1fr));
  gap:6px;margin-bottom:14px;
}
._step{
  background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);
  border-radius:8px;padding:9px 11px;
  display:flex;align-items:center;gap:9px;transition:all .3s;
}
._step.done{border-color:rgba(34,211,238,.2);background:rgba(34,211,238,.04)}
._step.run{
  border-color:rgba(99,102,241,.35);background:rgba(99,102,241,.05);
  box-shadow:0 0 14px rgba(99,102,241,.1);
}
._step.err{border-color:rgba(239,68,68,.2);background:rgba(239,68,68,.03)}
._stepico{
  width:24px;height:24px;border-radius:6px;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;
  background:rgba(255,255,255,.04);color:#3f3f46;
}
._stepico svg{width:12px;height:12px}
._step.done ._stepico{background:rgba(34,211,238,.08);color:#22d3ee}
._step.run ._stepico{background:rgba(99,102,241,.1);color:#818cf8;animation:_nsc_pulse 1s infinite}
._step.err ._stepico{background:rgba(239,68,68,.08);color:#f87171}
._stepname{font-size:10px;color:#52525b;font-weight:500}
._step.done ._stepname{color:#a1a1aa}
._step.run ._stepname{color:#818cf8;font-weight:600}

/* ── Terminal ── */
._term{
  background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.06);
  border-radius:10px;overflow:hidden;
}
._termhead{
  display:flex;align-items:center;gap:8px;
  padding:8px 12px;background:rgba(0,0,0,.4);
  border-bottom:1px solid rgba(255,255,255,.05);
}
._termdots{display:flex;gap:5px}
._termdot{width:10px;height:10px;border-radius:50%}
._termtitle{font-size:10px;color:#52525b;margin-left:4px;white-space:nowrap}
._termsearch{margin-left:auto;width:170px;background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08);
  border-radius:6px;padding:4px 9px;color:#d4d4d8;font-size:10px;font-family:inherit;outline:none;transition:border-color .15s}
._termsearch:focus{border-color:rgba(34,211,238,.4)}
._termsearch::placeholder{color:#3f3f46}
._termbtn{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.08);color:#71717a;font-size:9.5px;font-weight:700;
  padding:4px 9px;border-radius:6px;cursor:pointer;transition:all .15s;white-space:nowrap}
._termbtn:hover{color:#d4d4d8;border-color:rgba(255,255,255,.18)}
._termbtn.on{background:rgba(129,140,248,.12);border-color:rgba(129,140,248,.3);color:#a5b4fc}
._termbtn svg{flex:0 0 auto}
._termlive{font-size:10px;color:#3f3f46;white-space:nowrap}
._termbody{
  padding:10px 14px;height:280px;overflow-y:auto;
  font-family:'JetBrains Mono','Fira Code','Cascadia Code',Consolas,monospace;
  font-size:11px;line-height:1.7;
}
._termbody::-webkit-scrollbar{width:4px}
._termbody::-webkit-scrollbar-thumb{background:rgba(34,211,238,.2);border-radius:2px}
._tl{white-space:pre-wrap;word-break:break-all;padding:0}
._tl.ok{color:#4ade80}
._tl.er{color:#f87171}
._tl.wn{color:#fbbf24}
._tl.in{color:#60a5fa}
._tl.hi{color:#22d3ee}
._tl.mute{color:#3f3f46}
._tl.dim{color:#52525b}
._tl._line{display:flex;align-items:baseline;gap:7px;padding:1.5px 0;white-space:normal;word-break:break-word}
._lgt{color:#3f3f46;font-size:9.5px;flex-shrink:0;font-variant-numeric:tabular-nums}
._lgtag{font-size:8px;font-weight:800;letter-spacing:.05em;padding:1px 6px;border-radius:5px;
  border:1px solid;flex-shrink:0;text-transform:uppercase;line-height:1.5}
._lgmsg{color:#9ca3af;flex:1}
._lger{color:#fca5a5;font-weight:600;flex:1}
._lgwn{color:#fcd34d;font-weight:500;flex:1}
._lgok{color:#86efac;flex:1}
._cursor{display:inline-block;width:8px;height:14px;background:#22d3ee;
  vertical-align:middle;animation:_nsc_pulse .8s infinite}

/* ── Results ── */
._rkc{
  background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.06);
  border-radius:12px;padding:14px 12px;text-align:center;
  position:relative;overflow:hidden;
}
._rkc::before{
  content:'';position:absolute;inset:0;
  background:radial-gradient(circle at 50% 0%,rgba(34,211,238,.05),transparent 60%);
}
._rkcv{font-size:26px;font-weight:900;line-height:1;margin-bottom:4px;
  background:linear-gradient(135deg,#22d3ee,#818cf8);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
._rkcl{font-size:9px;color:#3f3f46;text-transform:uppercase;letter-spacing:.1em}

._rsub{
  background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);
  border-radius:10px;padding:11px 13px;
}
._rsubh{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
._rsubn{font-size:10px;color:#a1a1aa;font-weight:600}
._rsubsc{font-size:13px;font-weight:800}
._rsubv{font-size:9px;color:#52525b;margin-bottom:6px}
._rsubb{height:3px;background:rgba(255,255,255,.04);border-radius:2px}
._rsubbf{height:100%;border-radius:2px;transition:width 1.2s ease}

/* ── Dashboard hero ── */
._dashhero{display:flex;gap:20px;align-items:center;margin-bottom:18px;
  background:radial-gradient(circle at 18% 30%,rgba(34,211,238,.06),transparent 55%),rgba(0,0,0,.35);
  border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:20px 22px;flex-wrap:wrap}
._herogauge{display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0}
._gauge{display:block;filter:drop-shadow(0 0 8px rgba(0,0,0,.4))}
._gvbig{font:900 42px/1 'JetBrains Mono',ui-monospace,monospace}
._gvsm{font:800 20px/1 'JetBrains Mono',ui-monospace,monospace}
._herohealth{font-size:15px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;margin-top:2px}
._herosub{font-size:9px;color:#52525b;letter-spacing:.08em;text-transform:uppercase}
._herostats{flex:1;min-width:240px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
._stile{display:flex;align-items:center;gap:13px;background:rgba(255,255,255,.02);
  border:1px solid rgba(255,255,255,.05);border-radius:12px;padding:13px 15px}
._stico{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
._stmeta{min-width:0}
._stv{font-size:21px;font-weight:800;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
._stl{font-size:9px;color:#52525b;text-transform:uppercase;letter-spacing:.1em;margin-top:2px}

/* ── Subsystem mini-gauges ── */
._msggrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:12px;margin-bottom:16px}
._msg{display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;
  background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);border-radius:13px;padding:14px 8px 12px}
._msg:hover{border-color:rgba(34,211,238,.2);background:rgba(34,211,238,.03)}
._msgn{font-size:10px;font-weight:700;color:#d4d4d8}
._msgv{font-size:9px;color:#52525b;line-height:1.3}

._raibox{
  background:linear-gradient(135deg,rgba(99,102,241,.08) 0%,rgba(139,92,246,.05) 100%);
  border:1px solid rgba(99,102,241,.2);border-radius:12px;
  padding:15px 17px;margin-bottom:14px;position:relative;overflow:hidden;
}
._raibox::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(99,102,241,.5),transparent);
}
._raith{display:flex;align-items:center;gap:8px;margin-bottom:8px}
._raitt{font-size:10px;font-weight:800;color:#818cf8;text-transform:uppercase;letter-spacing:.1em}
._raic{font-size:11px;color:#c7d2fe;line-height:1.6}
._raicf{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:10px;color:#6366f1}
._cfb{flex:1;height:2px;background:rgba(99,102,241,.15);border-radius:1px;max-width:100px}
._cfbf{height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);border-radius:1px;transition:width 1s}

._rfind{margin-bottom:14px}
._rfi{
  padding:9px 12px;border-radius:9px;margin-bottom:5px;
  display:flex;align-items:flex-start;gap:10px;
  animation:_nsc_fadein .3s ease;
}
._rfi.cr{background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.17)}
._rfi.wa{background:rgba(234,179,8,.04);border:1px solid rgba(234,179,8,.12)}
._rfi.ok{background:rgba(34,211,238,.03);border:1px solid rgba(34,211,238,.1)}
._rfsev{
  font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;
  white-space:nowrap;flex-shrink:0;letter-spacing:.04em;margin-top:1px;
}
._rfi.cr ._rfsev{background:rgba(239,68,68,.18);color:#f87171}
._rfi.wa ._rfsev{background:rgba(234,179,8,.12);color:#fbbf24}
._rfi.ok ._rfsev{background:rgba(34,211,238,.1);color:#22d3ee}
._rftx{font-size:11px;color:#a1a1aa;line-height:1.5;flex:1;min-width:0}
._rfic{flex-shrink:0;display:flex;align-items:center;justify-content:center;margin-top:1px}
._rfhd{display:flex;align-items:center;gap:8px;margin-bottom:3px}
._rfhd strong{font-size:11px;color:#e4e4e7;font-weight:700}
._rfmsg{font-size:11px;color:#a1a1aa;line-height:1.5}
._rfev{display:flex;align-items:center;gap:5px;margin-top:6px;padding:5px 8px;background:rgba(82,82,91,.08);border:1px solid rgba(63,63,70,.4);border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#71717a}
._rfev svg{flex:0 0 auto}
._corrwrap{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
._corri{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:rgba(129,140,248,.04);border:1px solid rgba(129,140,248,.12);border-radius:6px;font-size:11px;color:#c7d2fe;line-height:1.5}
._corri svg{flex:0 0 auto;margin-top:1px}
._dwrap,._dbwrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:14px}
._di,._dbi{padding:10px 12px;border-radius:6px;background:rgba(24,24,27,.5);border:1px solid rgba(63,63,70,.4)}
._di.ok,._dbi.ok{border-color:rgba(34,211,238,.18)}
._di.wa,._dbi.wa{border-color:rgba(234,179,8,.22)}
._di.cr,._dbi.cr{border-color:rgba(239,68,68,.25);background:rgba(239,68,68,.04)}
._dih,._dbh{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
._dn,._dbn{font-size:12px;font-weight:600;color:#e4e4e7}
._dst,._dbst{font-size:9px;padding:2px 6px;border-radius:3px;font-weight:700;letter-spacing:.5px;background:rgba(82,82,91,.2);color:#a1a1aa}
._di.ok ._dst,._dbi.ok ._dbst{background:rgba(34,211,238,.12);color:#22d3ee}
._di.wa ._dst,._dbi.wa ._dbst{background:rgba(234,179,8,.12);color:#fbbf24}
._di.cr ._dst,._dbi.cr ._dbst{background:rgba(239,68,68,.15);color:#f87171}
._dv,._dbv{font-size:10px;color:#71717a;font-family:'JetBrains Mono',monospace;word-break:break-all}
._dm,._dbm{font-size:10px;color:#a1a1aa;margin-top:4px;font-family:'JetBrains Mono',monospace}
._rftx strong{color:#d4d4d8}

._rrec{
  padding:10px 13px;border-radius:9px;
  border:1px solid rgba(255,255,255,.05);
  background:rgba(0,0,0,.3);margin-bottom:6px;
}
._rrp{font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;margin-right:6px}
.rpCR{background:rgba(239,68,68,.18);color:#f87171}
.rpHI{background:rgba(249,115,22,.13);color:#fb923c}
.rpME{background:rgba(234,179,8,.1);color:#fbbf24}
.rpLO{background:rgba(74,222,128,.1);color:#4ade80}
._rrcmd{
  font-family:'JetBrains Mono','Fira Code',monospace;font-size:10px;
  color:#71717a;background:rgba(0,0,0,.6);border-radius:5px;
  padding:5px 9px;margin-top:6px;display:block;word-break:break-all;
  user-select:all;cursor:text;border:1px solid rgba(255,255,255,.05);
  line-height:1.5;
}

/* ── Port scanner ── */
._phead{display:flex;gap:8px;margin-bottom:14px;align-items:stretch;flex-wrap:wrap}
._pinp{
  flex:1;min-width:200px;background:#0d0d14;
  border:1px solid rgba(255,255,255,.08);color:#e4e4e7;
  border-radius:8px;padding:9px 13px;font-size:12px;
  font-family:'JetBrains Mono',monospace;
  outline:none;transition:border-color .2s;
}
._pinp:focus{border-color:rgba(34,211,238,.4);box-shadow:0 0 0 3px rgba(34,211,238,.06)}
._psel{
  background:#0d0d14;border:1px solid rgba(255,255,255,.08);
  color:#e4e4e7;border-radius:8px;padding:9px 12px;
  font-size:11px;outline:none;cursor:pointer;
}
._pbtn{
  background:linear-gradient(90deg,#0891b2,#6366f1);color:#fff;
  border:none;border-radius:8px;padding:9px 20px;
  font-size:11px;font-weight:800;cursor:pointer;white-space:nowrap;
  letter-spacing:.06em;transition:opacity .2s,transform .1s;
  display:flex;align-items:center;gap:6px;
}
._pbtn:hover{opacity:.88;transform:translateY(-1px)}
._pbtn.dis{background:rgba(255,255,255,.05);color:#3f3f46;cursor:not-allowed;transform:none}
._psumm{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
._psk{
  background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.06);
  border-radius:10px;padding:12px;text-align:center;
}
._psv{font-size:22px;font-weight:900;color:#22d3ee;line-height:1}
._psl{font-size:9px;color:#3f3f46;text-transform:uppercase;letter-spacing:.08em;margin-top:3px}
._ptbl{width:100%;border-collapse:collapse;font-size:11px}
._ptbl th{
  text-align:left;padding:7px 10px;color:#3f3f46;font-size:9px;
  font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap;
  position:sticky;top:0;background:#080714;
}
._ptbl td{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.03);color:#a1a1aa}
._ptbl tr:hover td{background:rgba(255,255,255,.018)}
._ptbl td:first-child{font-family:'JetBrains Mono',monospace;font-weight:700;color:#22d3ee}
._rc td:first-child{color:#f87171}._rh td:first-child{color:#fb923c}
._rm td:first-child{color:#fbbf24}._rl td:first-child{color:#4ade80}
._prtag{font-size:9px;padding:2px 6px;border-radius:20px;font-weight:700;white-space:nowrap}
._prtag.rc{background:rgba(239,68,68,.15);color:#f87171}
._prtag.rh{background:rgba(249,115,22,.12);color:#fb923c}
._prtag.rm{background:rgba(234,179,8,.1);color:#fbbf24}
._prtag.rl{background:rgba(74,222,128,.1);color:#4ade80}

/* ── Misc ── */
._empty{text-align:center;padding:48px 20px;color:#3f3f46;font-size:11px}

/* ── History tab ── */
._histtop{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
._hbtn{display:inline-flex;align-items:center;gap:6px;background:rgba(34,211,238,.08);
  border:1px solid rgba(34,211,238,.25);color:#22d3ee;font-size:10px;font-weight:700;
  padding:5px 11px;border-radius:7px;cursor:pointer}
._hbtn:hover{background:rgba(34,211,238,.16)}
._hbtn.active{background:rgba(34,211,238,.18);border-color:rgba(34,211,238,.5)}
._hbtn:disabled{opacity:.4;cursor:not-allowed}
._sel{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);color:#e4e4e7;
  font-size:10px;font-weight:700;padding:5px 9px;border-radius:7px;cursor:pointer}
._sel:disabled{opacity:.5;cursor:not-allowed}
/* Fleet */
._flsumm{display:flex;gap:16px;align-items:center;background:rgba(255,255,255,.02);
  border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:14px 16px;margin:10px 0 14px}
._flgauge{position:relative;display:flex;flex-direction:column;align-items:center;flex-shrink:0}
._flgl{font-size:9px;color:#71717a;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
._fltiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;flex:1}
._flgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;margin-top:4px}
._flcard{display:flex;justify-content:space-between;align-items:center;gap:10px;
  background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.07);border-radius:11px;
  padding:12px 13px;transition:border-color .2s,transform .1s}
._flcard:hover{transform:translateY(-1px)}
._flcl{display:flex;align-items:center;gap:9px;min-width:0}
._fldot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
._fldot._run{animation:_nsc_pulse 1s infinite}
._fldot._pend{opacity:.4}
._flnm{min-width:0}
._flhn{font-size:12px;font-weight:700;color:#e4e4e7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
._flhid{font-size:9px;color:#52525b;font-family:ui-monospace,monospace}
._flcr{text-align:right;flex-shrink:0}
._flscore{font-size:22px;font-weight:900;line-height:1}._flscore span{font-size:10px;color:#52525b;font-weight:600}
._flbad{font-size:10px;font-weight:700;display:flex;align-items:center;gap:4px;justify-content:flex-end}
._flpw{display:flex;align-items:center;gap:6px}._flpw span{font-size:9px;color:#71717a}
._flpbar{width:70px;height:5px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
._flpf{height:100%;background:linear-gradient(90deg,#22d3ee,#818cf8);border-radius:3px;transition:width .3s}
._flpend{font-size:9px;color:#52525b;text-transform:uppercase;letter-spacing:.06em}
._flsub{font-size:9px;color:#71717a;margin-top:3px}
._flcnt{display:flex;gap:6px;justify-content:flex-end;margin-top:3px}
._flc{font-size:9px;color:#fca5a5;font-weight:700}._flw{font-size:9px;color:#fbbf24;font-weight:700}
/* Remediation */
._remoff{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.02);
  border:1px dashed rgba(255,255,255,.12);border-radius:9px;padding:11px 13px;
  font-size:10px;color:#71717a;margin-bottom:6px}
._remoff code{background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px;color:#a1a1aa;font-size:9px}
._remgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:6px}
._rembtn{display:flex;align-items:center;gap:8px;text-align:left;background:rgba(0,0,0,.3);
  border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:10px 12px;cursor:pointer;transition:transform .1s,background .15s}
._rembtn:hover{transform:translateY(-1px);background:rgba(255,255,255,.04)}
._remrisk{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:2px 6px;border-radius:5px;flex-shrink:0}
._remlbl{font-size:11px;color:#e4e4e7;font-weight:600}
._histalert{display:flex;align-items:flex-start;gap:10px;background:rgba(239,68,68,.08);
  border:1px solid rgba(239,68,68,.3);border-radius:9px;padding:11px 13px;margin-bottom:14px}
._haln{font-size:12px;font-weight:700;color:#fca5a5}
._halr{font-size:10px;color:#a1a1aa;margin-top:2px}
._spark{display:flex;align-items:flex-end;gap:3px;height:60px;padding:8px 4px;
  background:rgba(255,255,255,.02);border-radius:8px;margin-bottom:8px}
._spb{flex:1;height:100%;display:flex;align-items:flex-end;min-width:3px}
._spbf{width:100%;border-radius:2px 2px 0 0;transition:height .3s}
._histtbl{border:1px solid rgba(255,255,255,.05);border-radius:9px;overflow:hidden}
._htr{display:grid;grid-template-columns:26px 1.6fr .9fr .6fr 1fr .5fr .5fr;align-items:center;
  gap:8px;padding:9px 13px;font-size:11px;border-bottom:1px solid rgba(255,255,255,.03)}
._htchk{display:flex}._htchk input{width:14px;height:14px;cursor:pointer;accent-color:#22d3ee}
._htr:last-child{border-bottom:none}
._hth{font-size:8px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  color:#52525b;background:rgba(255,255,255,.02)}
._histrow{cursor:pointer;transition:background .15s}
._histrow:hover{background:rgba(34,211,238,.06)}
._htts{color:#a1a1aa;font-family:ui-monospace,monospace;font-size:10px}
._htmd{color:#71717a;text-transform:uppercase;font-size:9px;font-weight:700}
/* ── Compare view ── */
._cmpkpis{display:flex;align-items:center;gap:14px;margin:8px 0 6px}
._cmpkpi{flex:1;text-align:center;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:14px}
._cmpts{font-size:9px;color:#52525b;font-family:ui-monospace,monospace;margin-bottom:4px}
._cmpsc{font-size:34px;font-weight:900;line-height:1;font-family:ui-monospace,monospace}
._cmplb{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-top:3px}
._cmparrow{text-align:center;flex-shrink:0}
._cmptbl{border:1px solid rgba(255,255,255,.05);border-radius:9px;overflow:hidden;margin-bottom:14px}
._cmprow{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;padding:8px 13px;font-size:11px;border-bottom:1px solid rgba(255,255,255,.03);text-align:center}
._cmprow span:first-child{text-align:left}
._cmprow:last-child{border-bottom:none}
._cmph{font-size:8px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#52525b;background:rgba(255,255,255,.02)}
._cmpn{color:#d4d4d8;font-weight:600}
._cmpdiff{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
._diffi{display:flex;align-items:flex-start;gap:8px;font-size:11px;padding:7px 11px;border-radius:7px;line-height:1.4}
._diffi.add{background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.18);color:#fca5a5}
._diffi.rem{background:rgba(74,222,128,.06);border:1px solid rgba(74,222,128,.18);color:#86efac}
._diffi svg{flex:0 0 auto;margin-top:1px}
._cmpnochange{text-align:center;color:#52525b;font-size:11px;padding:20px}
._ndot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#ef4444;
  margin-left:6px;box-shadow:0 0 6px #ef4444}
._empty svg{width:40px;height:40px;margin:0 auto 12px;display:block;opacity:.3}
._newbtn{
  display:flex;align-items:center;justify-content:center;gap:8px;
  width:100%;padding:12px;border-radius:10px;border:none;cursor:pointer;
  font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  background:rgba(34,211,238,.08);border:1px solid rgba(34,211,238,.2);
  color:#22d3ee;transition:all .2s;margin-top:14px;
}
._newbtn:hover{background:rgba(34,211,238,.12);box-shadow:0 0 20px rgba(34,211,238,.1)}
._rawbox{
  background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.05);
  border-radius:8px;padding:10px 14px;margin-bottom:12px;
  max-height:140px;overflow-y:auto;
  font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.65;
}
._rawbox::-webkit-scrollbar{width:3px}
._rawbox::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1)}

/* ── Recommendations (cards) ── */
._recwrap{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
._recc{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);
  border-left:3px solid #4ade80;border-radius:10px;padding:12px 14px}
._recch{display:flex;align-items:center;gap:10px}
._recp{font-size:9px;font-weight:800;letter-spacing:.06em;padding:3px 9px;border-radius:20px;flex-shrink:0}
._reca{font-size:12px;color:#e4e4e7;font-weight:600;line-height:1.4}
._reccmd{display:flex;align-items:center;gap:8px;margin-top:9px;
  background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.06);border-radius:7px;padding:7px 10px}
._reccmd code{flex:1;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;
  color:#8bdcff;word-break:break-all;line-height:1.5}
._reccmd code::before{content:'$ ';color:#52525b}
._copybtn{position:relative;flex-shrink:0;width:26px;height:26px;border-radius:6px;cursor:pointer;
  background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.25);
  display:flex;align-items:center;justify-content:center;transition:all .15s}
._copybtn:hover{background:rgba(34,211,238,.2)}
._copybtn._ok{background:rgba(74,222,128,.2);border-color:rgba(74,222,128,.4)}
._copybtn._ok::after{content:'✓';color:#4ade80;font-size:13px;font-weight:800;position:absolute}
._copybtn._ok svg{display:none}

/* ── Log rows ── */
._logwrap{display:flex;flex-direction:column;gap:4px;margin-bottom:14px;max-height:260px;overflow-y:auto;padding-right:2px}
._logwrap::-webkit-scrollbar{width:3px}
._logwrap::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1)}
._logr{background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.04);
  border-left:3px solid #fbbf24;border-radius:7px;padding:8px 11px}
._logmeta{display:flex;align-items:center;gap:10px;margin-bottom:3px;flex-wrap:wrap}
._logt{font-family:'JetBrains Mono',monospace;font-size:9.5px;color:#52525b}
._logsrc{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
._logm{font-size:11px;color:#a1a1aa;line-height:1.5;word-break:break-word}

/* ── Exposed ports (cards) ── */
._pgl{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:700;
  letter-spacing:.05em;text-transform:uppercase;margin:6px 0 9px}
._pgl.pub{color:#f87171}
._pgl.loc{color:#4ade80}
._portgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:10px;margin-bottom:14px}
._portc{background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.06);
  border-radius:12px;padding:13px 11px;text-align:center;position:relative;overflow:hidden}
._portc.cr{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.05)}
._portc.wa{border-color:rgba(234,179,8,.28);background:rgba(234,179,8,.04)}
._portc.ok{border-color:rgba(74,222,128,.18)}
._portnum{font-size:24px;font-weight:900;color:#e4e4e7;line-height:1;font-family:'JetBrains Mono',monospace}
._portsvc{font-size:10px;color:#a1a1aa;font-weight:600;margin:4px 0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
._portb{display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:5px}
._portexp{font-size:8px;font-weight:800;letter-spacing:.05em;padding:2px 6px;border-radius:5px}
._portexp.pub{background:rgba(239,68,68,.16);color:#f87171}
._portexp.loc{background:rgba(74,222,128,.14);color:#4ade80}
._portrisk{font-size:8.5px;font-weight:800;letter-spacing:.04em}
._portbind{font-size:8.5px;color:#52525b;font-family:'JetBrains Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── Posture chips ── */
._pchips{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px;margin-bottom:12px}
._pchip{display:flex;align-items:center;justify-content:space-between;gap:10px;
  background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:11px 13px}
._pcl{font-size:9px;color:#71717a;text-transform:uppercase;letter-spacing:.07em;font-weight:700}
._pcv{font-size:12px;font-weight:800}
._seclist{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
._secli{display:flex;align-items:center;gap:8px;font-size:10.5px;color:#a1a1aa;
  background:rgba(234,179,8,.04);border:1px solid rgba(234,179,8,.14);border-radius:6px;padding:6px 10px;
  font-family:'JetBrains Mono',monospace;word-break:break-all}
._secli svg{flex:0 0 auto}

/* ── Frequency bars ── */
._freqwrap{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
._freqr{position:relative;display:flex;align-items:center;gap:9px;padding:7px 11px;
  background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);border-radius:7px;overflow:hidden}
._freqbar{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,rgba(248,113,113,.18),rgba(248,113,113,.05));z-index:0}
._freqc{position:relative;z-index:1;font-size:11px;font-weight:800;color:#fca5a5;min-width:34px;font-family:'JetBrains Mono',monospace}
._freqp{position:relative;z-index:1;font-size:10.5px;color:#a1a1aa;font-family:'JetBrains Mono',monospace;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ─── Port Scan (Enhanced) ── */
._ps-hero{background:linear-gradient(135deg,rgba(34,211,238,.08) 0%,rgba(139,92,246,.08) 100%);border:1px solid rgba(34,211,238,.12);border-radius:16px;padding:20px 24px;margin-bottom:16px}
._ps-hero h2{margin:0 0 4px;font-size:13px;font-weight:700;color:#22d3ee;letter-spacing:.06em;text-transform:uppercase}
._ps-hero p{margin:0;font-size:11px;color:#71717a}
._ps-form{display:flex;gap:10px;align-items:stretch;margin-top:14px;flex-wrap:wrap}
._ps-input{flex:1;min-width:180px;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 14px;color:#e4e4e7;font:500 13px ui-monospace,monospace;outline:none;transition:border .2s}
._ps-input:focus{border-color:#22d3ee;box-shadow:0 0 0 3px rgba(34,211,238,.12)}
._ps-input::placeholder{color:#52525b}
._ps-select{background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;color:#e4e4e7;font:500 12px ui-sans-serif,sans-serif;outline:none;cursor:pointer;min-width:140px;transition:border .2s}
._ps-select:focus{border-color:#22d3ee}
._ps-btn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,rgba(34,211,238,.2) 0%,rgba(139,92,246,.2) 100%);border:1px solid rgba(34,211,238,.25);border-radius:10px;padding:10px 20px;color:#e4e4e7;font:600 12px ui-sans-serif,sans-serif;cursor:pointer;transition:all .2s;white-space:nowrap}
._ps-btn:hover{background:linear-gradient(135deg,rgba(34,211,238,.3) 0%,rgba(139,92,246,.3) 100%);border-color:#22d3ee;color:#fff}
._ps-btn.disabled{opacity:.4;cursor:not-allowed}
._ps-btn._scanning{animation:_ps-pulse 1.5s ease-in-out infinite}
@keyframes _ps-pulse{0%,100%{box-shadow:0 0 0 0 rgba(34,211,238,0)}50%{box-shadow:0 0 0 8px rgba(34,211,238,.15)}}

._ps-dash{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
._ps-stat{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:14px 16px;text-align:center}
._ps-stat ._ps-num{font:800 22px ui-monospace,monospace;line-height:1.2}
._ps-stat ._ps-lbl{font-size:10px;color:#71717a;margin-top:2px;letter-spacing:.04em;text-transform:uppercase}

._ps-ports{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-bottom:16px}
._ps-card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:12px;text-align:center;transition:all .2s;animation:_ps-pop .35s ease-out}
._ps-card:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,.3)}
._ps-card._cr{border-color:rgba(239,68,68,.35)}._ps-card._hi{border-color:rgba(249,115,22,.3)}._ps-card._me{border-color:rgba(234,179,8,.2)}._ps-card._lo{border-color:rgba(74,222,128,.15)}
@keyframes _ps-pop{0%{transform:scale(.8);opacity:0}70%{transform:scale(1.05)}100%{transform:scale(1);opacity:1}}

._ps-term{background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.06);border-radius:12px;margin-bottom:16px;overflow:hidden}
._ps-termhead{display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(0,0,0,.25);border-bottom:1px solid rgba(255,255,255,.04)}
._ps-termdots{display:flex;gap:5px}
._ps-termdot{width:8px;height:8px;border-radius:50%}
._ps-termtitle{font:500 10px ui-monospace,monospace;color:#52525b;margin-left:4px}
._ps-termbody{height:180px;overflow-y:auto;padding:8px 14px;font:500 11px/1.6 ui-monospace,monospace;color:#a1a1aa}
._ps-termbody ._tl{padding:1px 0}. _ps-termbody ._tl.er{color:#f87171}._ps-termbody ._tl.wn{color:#fb923c}._ps-termbody ._tl.ok{color:#4ade80}._ps-termbody ._tl.in{color:#22d3ee}

._ps-section{margin-bottom:14px}
._ps-section-title{font-size:11px;font-weight:700;color:#a1a1aa;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,.05)}

._ps-findings{display:flex;flex-direction:column;gap:6px}
._ps-fi{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;background:rgba(0,0,0,.2);border-radius:8px;border-left:3px solid}
._ps-fi._cr{border-color:#ef4444}._ps-fi._hi{border-color:#fb923c}._ps-fi._me{border-color:#eab308}._ps-fi._in{border-color:#22d3ee}
._ps-fi ._ps-fisev{font:700 9px ui-sans-serif;letter-spacing:.04em;white-space:nowrap;padding:1px 5px;border-radius:4px}
._ps-fi._cr ._ps-fisev{background:rgba(239,68,68,.15);color:#f87171}
._ps-fi._hi ._ps-fisev{background:rgba(249,115,22,.15);color:#fb923c}
._ps-fi._me ._ps-fisev{background:rgba(234,179,8,.15);color:#eab308}
._ps-fi._in ._ps-fisev{background:rgba(34,211,238,.12);color:#22d3ee}
._ps-fi ._ps-fimsg{font:500 11px ui-sans-serif;color:#d4d4d8}

._ps-rec{display:flex;flex-direction:column;gap:6px}
._ps-rc{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(0,0,0,.2);border-radius:8px}
._ps-rc ._ps-rcpri{font:700 9px;padding:2px 6px;border-radius:4px;white-space:nowrap}
._ps-rc ._ps-rcact{font:500 11px;color:#d4d4d8;flex:1}
._ps-rc ._ps-rccmd{font:500 10px ui-monospace;color:#6366f1;background:rgba(99,102,241,.1);padding:3px 8px;border-radius:6px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

._ps-history{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
._ps-hc{background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:8px 12px;font:500 10px ui-monospace;color:#71717a;cursor:pointer;transition:all .15s}
._ps-hc:hover{border-color:rgba(34,211,238,.2);color:#e4e4e7}

/* ─── Infrastructure Port Scanner ── */
._ips-hero{background:linear-gradient(135deg,rgba(59,130,246,.1) 0%,rgba(34,211,238,.08) 100%);border:1px solid rgba(59,130,246,.15);border-radius:14px;padding:16px 20px;margin-bottom:12px}
._ips-hero h3{margin:0 0 2px;font-size:12px;font-weight:700;color:#60a5fa;letter-spacing:.05em}
._ips-hero p{margin:0;font-size:10px;color:#71717a}
._ips-bar{background:rgba(0,0,0,.4);border-radius:8px;height:16px;overflow:hidden;margin:8px 0;border:1px solid rgba(255,255,255,.05)}
._ips-fill{height:100%;border-radius:8px;background:linear-gradient(90deg,#3b82f6,#22d3ee);transition:width .3s ease;min-width:0}
._ips-term{background:#000;border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px;max-height:180px;overflow-y:auto;font:500 10px/1.6 ui-monospace,monospace;margin-top:10px}
._ips-term ._tl{padding:1px 0}
/* ─── Infrastructure ── */
._infra-hero{background:linear-gradient(135deg,rgba(139,92,246,.1) 0%,rgba(34,211,238,.08) 100%);border:1px solid rgba(139,92,246,.15);border-radius:16px;padding:20px 24px;margin-bottom:16px}
._infra-hero h2{margin:0 0 4px;font-size:13px;font-weight:700;color:#a78bfa;letter-spacing:.06em;text-transform:uppercase}
._infra-hero p{margin:0;font-size:11px;color:#71717a}
._infra-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
._infra-card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:16px;text-align:center;cursor:pointer;transition:all .2s}
._infra-card:hover{background:rgba(0,0,0,.45);border-color:rgba(139,92,246,.25);transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,.3)}
._infra-card ._icn{margin-bottom:8px}
._infra-card ._ilbl{font-size:11px;font-weight:600;color:#e4e4e7;letter-spacing:.02em}
._infra-card ._idesc{font-size:10px;color:#71717a;margin-top:4px}
._infra-card ._istat{font-size:9px;font-weight:700;color:#22d3ee;margin-top:6px;padding:2px 8px;border-radius:4px;display:inline-block;background:rgba(34,211,238,.1)}

/* ─── Port Scanner Dashboard View ── */
._psDwrap{flex:1;display:flex;flex-direction:column;padding:20px 24px;overflow:hidden;background:#000}
._psDhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-shrink:0}
._psDheadL{display:flex;align-items:center;gap:10px}
._psDtitle{margin:0;font-size:16px;font-weight:800;color:#fca5a5;letter-spacing:.02em}
._psDsub{margin:2px 0 0;font-size:11px;color:#a1a1aa}
._psDbadge{font-size:10px;font-weight:700;padding:3px 12px;border-radius:5px;color:#fca5a5;background:rgba(239,68,68,.1);flex-shrink:0}
._psDbar{flex-shrink:0;margin-bottom:12px}
._psDctrl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:linear-gradient(135deg,rgba(239,68,68,.03),rgba(127,29,29,.08));border:1px solid rgba(239,68,68,.12);border-radius:10px;padding:12px}
._psDinput{padding:8px 12px;border-radius:6px;border:1px solid rgba(239,68,68,.18);background:rgba(0,0,0,.45);color:#e4e4e7;font-size:12px;outline:none;transition:border-color .15s}
._psDinput:focus{border-color:#ef4444}
._psDselect{padding:8px 10px;border-radius:6px;border:1px solid rgba(239,68,68,.18);background:rgba(0,0,0,.45);color:#e4e4e7;font-size:11px;font-weight:600;outline:none;cursor:pointer;appearance:auto}
._psDgo{display:inline-flex;align-items:center;gap:5px;padding:8px 18px;border-radius:6px;border:none;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;font-size:11px;font-weight:700;cursor:pointer;transition:all .2s}
._psDgo:hover{background:linear-gradient(135deg,#ef4444,#dc2626);transform:translateY(-1px)}
._psDstop{display:inline-flex;align-items:center;gap:5px;padding:8px 18px;border-radius:6px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.1);color:#fca5a5;font-size:11px;font-weight:700;cursor:pointer}
._psDstop:hover{background:rgba(239,68,68,.2)}
._psDtoggle{display:flex;justify-content:flex-end;margin-top:4px}
._psDlink{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:none;background:transparent;color:#a1a1aa;font-size:10px;font-weight:600;cursor:pointer;border-radius:4px;transition:all .15s}
._psDlink:hover{background:rgba(255,255,255,.04);color:#e4e4e7}
._psDlink.on{color:#fca5a5;background:rgba(239,68,68,.08)}
._psDadv{background:rgba(0,0,0,.3);border:1px solid rgba(239,68,68,.08);border-radius:8px;padding:12px;margin-bottom:8px;flex-shrink:0}
._psDadvR{display:flex;align-items:center;gap:10px;margin-bottom:6px}
._psDadvR:last-child{margin-bottom:0}
._psDlbl{font-size:10px;font-weight:600;color:#a1a1aa;min-width:72px}
._psDrange{flex:1;height:4px;cursor:pointer;-webkit-appearance:none;appearance:none;background:rgba(239,68,68,.15);border-radius:2px;outline:none}
._psDrange::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#ef4444;cursor:pointer;border:2px solid #7f1d1d}
._psDrv{font-size:11px;font-weight:700;color:#fca5a5;min-width:32px;text-align:right}
._psDprog{flex-shrink:0;margin-bottom:8px}
._psDprogBar{background:rgba(0,0,0,.45);border-radius:6px;height:16px;overflow:hidden;border:1px solid rgba(239,68,68,.12)}
._psDprogFill{height:100%;border-radius:6px;background:linear-gradient(90deg,#dc2626,#ef4444,#fca5a5);transition:width .3s ease;width:0%}
._psDstats{display:flex;gap:16px;margin-top:4px;font-size:10px;color:#71717a;justify-content:center}
._psDstats b{color:#a1a1aa}
._psDdash{flex-shrink:0;margin-bottom:8px}
._psDdashG{display:flex;gap:6px;flex-wrap:wrap}
._psDmetric{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:8px 12px;text-align:center;min-width:60px;flex:1}
._psDmetric._cr{border-color:rgba(239,68,68,.2);background:rgba(239,68,68,.04)}
._psDmetric._hi{border-color:rgba(251,146,60,.2);background:rgba(251,146,60,.04)}
._psDmetric._me{border-color:rgba(234,179,8,.2);background:rgba(234,179,8,.04)}
._psDmetric._lo{border-color:rgba(74,222,128,.2);background:rgba(74,222,128,.04)}
._psDmVal{display:block;font:800 20px/1 ui-monospace,monospace;color:#e4e4e7}
._psDmetric._cr ._psDmVal{color:#ef4444}
._psDmetric._hi ._psDmVal{color:#fb923c}
._psDmetric._me ._psDmVal{color:#eab308}
._psDmetric._lo ._psDmVal{color:#4ade80}
._psDmLbl{display:block;font-size:8px;color:#71717a;font-weight:600;margin-top:2px;letter-spacing:.04em}
._psDfindings{background:rgba(0,0,0,.3);border:1px solid rgba(239,68,68,.1);border-radius:8px;padding:8px;margin-top:6px;max-height:100px;overflow-y:auto}
._psDfind{display:flex;align-items:flex-start;gap:4px;padding:3px 0;font-size:10px;line-height:1.4;border-bottom:1px solid rgba(255,255,255,.03)}
._psDfind:last-child{border-bottom:none}
._psDgridToolbar{display:none;align-items:center;gap:4px;flex-shrink:0;padding:4px 0}
._psDfilterLbl{font-size:10px;color:#52525b;font-weight:600;margin-right:4px}
._psDfilter{padding:2px 8px;border:1px solid rgba(255,255,255,.06);border-radius:4px;cursor:pointer;font-size:9px;font-weight:700;color:#71717a;background:transparent;transition:all .15s}
._psDfilter:hover{border-color:rgba(239,68,68,.2);color:#a1a1aa}
._psDfilter.on{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.25);color:#fca5a5}
._psDgrid{flex:1;display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px;overflow-y:auto;padding:4px 0;min-height:60px}
._psDcard{border:1px solid;border-radius:8px;padding:8px 10px;min-width:82px;text-align:center;transition:all .15s}
._psDcard:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}
._psDcardP{font:800 15px ui-monospace,monospace;margin-bottom:2px}
._psDcardS{font-size:9px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a1a1aa}
._psDcardV{font-size:8px;color:#52525b;margin-bottom:3px}
._psDcardRisk{display:inline-block;font:700 7px;padding:1px 6px;border-radius:3px;margin-top:2px}
._psDcardLat{font:500 8px ui-monospace;color:#52525b;margin-top:1px}
._psDtermH{display:flex;align-items:center;gap:6px;flex-shrink:0;padding:4px 0 2px}
._psDtermTitle{font-size:10px;font-weight:600;color:#71717a;display:flex;align-items:center;gap:4px;flex:1}
._psDterm{flex-shrink:0;background:rgba(0,0,0,.45);border:1px solid rgba(239,68,68,.08);border-radius:8px;padding:10px 12px;max-height:140px;overflow-y:auto;font:500 11px/1.5 ui-monospace,monospace;color:#a1a1aa;margin-top:2px}
._psDler{color:#ef4444}
._psDlw{color:#fb923c}
._psDlok{color:#4ade80}
._psDlhi{color:#38bdf8}
._psDl{padding:1px 0}

._psPhaseSteps{display:flex;flex-direction:column;gap:4px;margin:8px 0;padding:8px;background:rgba(0,0,0,.3);border:1px solid rgba(239,68,68,.08);border-radius:6px}
._psPhaseStep{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;font-size:11px;transition:all .2s}
._psPhaseStep.pending{color:#52525b;background:rgba(255,255,255,.02)}
._psPhaseStep.running{color:#38bdf8;background:rgba(56,189,248,.1)}
._psPhaseStep.done{color:#4ade80;background:rgba(74,222,128,.1)}
._psPhaseStep.error{color:#ef4444;background:rgba(239,68,68,.1)}
._psPhaseIcon{font-size:12px;min-width:16px;text-align:center}
._psPhaseLabel{flex:1}
._psPhaseProg{font-size:9px;color:#71717a}

/* ═══ Port Scanner v2 Styles ═══ */
@keyframes _psv2-glow{0%,100%{box-shadow:0 0 8px rgba(34,211,238,.15)}50%{box-shadow:0 0 20px rgba(34,211,238,.35)}}
@keyframes _psv2-pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes _psv2-count{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
@keyframes _psv2-shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
._psv2-wrap{padding:4px 0}
._psv2-header{margin-bottom:16px}
._psv2-title-row{display:flex;align-items:center;gap:10px;margin-bottom:4px}
._psv2-title-row h2{margin:0;font-size:16px;font-weight:800;color:#22d3ee;letter-spacing:.02em}
._psv2-title-row p{margin:2px 0 0;font-size:11px;color:#71717a}
._psv2-glass{background:rgba(0,0,0,.4);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.06);border-radius:12px}
._psv2-input-section{padding:16px 18px;margin-bottom:14px}
._psv2-input-row{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}
._psv2-target-input{flex:2;min-width:200px;background:rgba(0,0,0,.45);border:1px solid rgba(34,211,238,.15);border-radius:8px;padding:10px 14px;color:#e4e4e7;font:500 13px 'JetBrains Mono',ui-monospace,monospace;outline:none;transition:border-color .2s}
._psv2-target-input:focus{border-color:#22d3ee;box-shadow:0 0 0 3px rgba(34,211,238,.08)}
._psv2-target-input::placeholder{color:#52525b;font-family:inherit}
._psv2-ports-input{flex:1;min-width:140px;background:rgba(0,0,0,.45);border:1px solid rgba(34,211,238,.1);border-radius:8px;padding:10px 14px;color:#e4e4e7;font:500 12px 'JetBrains Mono',ui-monospace,monospace;outline:none;transition:border-color .2s}
._psv2-ports-input:focus{border-color:rgba(34,211,238,.4)}
._psv2-ports-input::placeholder{color:#52525b;font-family:inherit}
._psv2-mode-select{background:rgba(0,0,0,.45);border:1px solid rgba(34,211,238,.1);border-radius:8px;padding:10px 12px;color:#e4e4e7;font:600 12px inherit;outline:none;cursor:pointer;min-width:150px;transition:border-color .2s}
._psv2-mode-select:focus{border-color:rgba(34,211,238,.4)}
._psv2-scan-btn{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,rgba(34,211,238,.2),rgba(99,102,241,.2));border:1px solid rgba(34,211,238,.3);border-radius:8px;padding:10px 22px;color:#e4e4e7;font:700 12px inherit;cursor:pointer;transition:all .2s;white-space:nowrap}
._psv2-scan-btn:hover{background:linear-gradient(135deg,rgba(34,211,238,.35),rgba(99,102,241,.35));border-color:#22d3ee;color:#fff;transform:translateY(-1px);box-shadow:0 4px 16px rgba(34,211,238,.15)}
._psv2-scan-btn.running{background:linear-gradient(135deg,rgba(239,68,68,.15),rgba(239,68,68,.1));border-color:rgba(239,68,68,.3);color:#fca5a5;animation:_psv2-pulse 1.5s infinite}
._psv2-scan-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
._psv2-advanced-toggle{display:flex;justify-content:flex-end;margin-top:6px}
._psv2-adv-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:none;background:transparent;color:#71717a;font-size:10px;font-weight:600;cursor:pointer;border-radius:4px;transition:all .15s}
._psv2-adv-btn:hover{background:rgba(255,255,255,.04);color:#a1a1aa}
._psv2-advanced-panel{margin-top:8px;padding:12px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.04);border-radius:8px}
._psv2-adv-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
._psv2-adv-row label{display:flex;align-items:center;gap:8px;font-size:10px;color:#a1a1aa;font-weight:600}
._psv2-adv-row input[type=range]{flex:1;min-width:100px;height:4px;cursor:pointer;-webkit-appearance:none;appearance:none;background:rgba(34,211,238,.15);border-radius:2px;outline:none}
._psv2-adv-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#22d3ee;cursor:pointer;border:2px solid #0e7490}
._psv2-adv-row span{font-size:11px;font-weight:700;color:#22d3ee;min-width:40px;text-align:right}
._psv2-progress-section{margin-bottom:14px}
._psv2-progress-bar{background:rgba(0,0,0,.45);border-radius:6px;height:8px;overflow:hidden;border:1px solid rgba(34,211,238,.1)}
._psv2-progress-fill{height:100%;border-radius:6px;background:linear-gradient(90deg,#0891b2,#22d3ee,#6366f1);transition:width .3s ease;width:0%}
._psv2-progress-stats{display:flex;gap:16px;margin-top:6px;font-size:10px;color:#71717a;justify-content:center;flex-wrap:wrap}
._psv2-progress-stats b{color:#a1a1aa;font-weight:700}
._psv2-dashboard{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px}
._psv2-dash-card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:14px;text-align:center;transition:all .2s}
._psv2-dash-card:hover{border-color:rgba(34,211,238,.15)}
._psv2-dash-val{display:block;font:800 24px/1 'JetBrains Mono',ui-monospace,monospace;animation:_psv2-count .3s ease}
._psv2-dash-lbl{display:block;font-size:9px;color:#71717a;margin-top:4px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
._psv2-tabs{display:flex;gap:2px;border-bottom:1px solid rgba(255,255,255,.05);margin-bottom:14px;overflow-x:auto;padding-bottom:1px}
._psv2-tab{display:flex;align-items:center;gap:5px;padding:8px 14px;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;border:none;background:transparent;color:#52525b;cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;outline:none}
._psv2-tab:hover{color:#a1a1aa}
._psv2-tab.active{color:#22d3ee;border-bottom-color:#22d3ee}
._psv2-tab-content{min-height:200px}
._psv2-table-wrap{overflow-x:auto;border:1px solid rgba(255,255,255,.05);border-radius:10px;margin-bottom:14px}
._psv2-table{width:100%;border-collapse:collapse;font-size:11px}
._psv2-table th{text-align:left;padding:8px 12px;color:#52525b;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap;background:rgba(0,0,0,.3);position:sticky;top:0;cursor:pointer;transition:color .15s;user-select:none}
._psv2-table th:hover{color:#a1a1aa}
._psv2-table th.sorted{color:#22d3ee}
._psv2-table td{padding:7px 12px;border-bottom:1px solid rgba(255,255,255,.03);color:#a1a1aa}
._psv2-table tr:hover td{background:rgba(34,211,238,.03)}
._psv2-table td:first-child{font-family:'JetBrains Mono',monospace;font-weight:700;color:#22d3ee}
._psv2-risk-critical{font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(239,68,68,.12);color:#f87171;white-space:nowrap}
._psv2-risk-high{font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(251,146,60,.1);color:#fb923c;white-space:nowrap}
._psv2-risk-med{font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(234,179,8,.1);color:#eab308;white-space:nowrap}
._psv2-risk-low{font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(74,222,128,.1);color:#4ade80;white-space:nowrap}
._psv2-finding{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;background:rgba(0,0,0,.2);border-radius:8px;margin-bottom:6px;border-left:3px solid;transition:background .15s}
._psv2-finding:hover{background:rgba(0,0,0,.3)}
._psv2-finding.critical{border-color:#f87171}
._psv2-finding.high{border-color:#fb923c}
._psv2-finding.medium{border-color:#eab308}
._psv2-finding.low{border-color:#4ade80}
._psv2-finding.info{border-color:#22d3ee}
._psv2-finding-sev{font:700 9px inherit;padding:2px 8px;border-radius:4px;white-space:nowrap;flex-shrink:0;letter-spacing:.03em}
._psv2-finding-text{font-size:11px;color:#c4c4c8;line-height:1.5;flex:1}
._psv2-finding-desc{font-size:10px;color:#71717a;margin-top:2px}
._psv2-export-bar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
._psv2-export-btn{display:inline-flex;align-items:center;gap:6px;background:rgba(34,211,238,.06);border:1px solid rgba(34,211,238,.15);border-radius:8px;padding:7px 14px;color:#71717a;font-size:10px;font-weight:700;cursor:pointer;transition:all .15s}
._psv2-export-btn:hover{background:rgba(34,211,238,.12);border-color:rgba(34,211,238,.3);color:#22d3ee}
._psv2-search{display:flex;align-items:center;gap:7px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:6px 11px;margin-bottom:12px}
._psv2-search svg{flex:0 0 auto;color:#52525b}
._psv2-search input{flex:1;background:transparent;border:none;outline:none;color:#e2e8f0;font-size:11px;font-family:inherit}
._psv2-search input::placeholder{color:#475569}
._psv2-overview-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:14px}
._psv2-overview-card{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:14px;text-align:center}
._psv2-overview-val{font:800 28px/1 'JetBrains Mono',ui-monospace,monospace;margin-bottom:4px}
._psv2-overview-lbl{font-size:9px;color:#52525b;text-transform:uppercase;letter-spacing:.06em}
._psv2-service-group{margin-bottom:12px}
._psv2-service-header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.04);border-radius:8px;cursor:pointer;transition:background .15s}
._psv2-service-header:hover{background:rgba(0,0,0,.35)}
._psv2-service-name{font-size:12px;font-weight:700;color:#e4e4e7;flex:1}
._psv2-service-count{font-size:10px;color:#71717a}
._psv2-service-body{padding:6px 0 0 16px}
._psv2-surface-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:14px}
._psv2-surface-card{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:14px;position:relative;overflow:hidden}
._psv2-surface-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px}
._psv2-surface-card.external::before{background:linear-gradient(90deg,#ef4444,#f97316)}
._psv2-surface-card.management::before{background:linear-gradient(90deg,#f97316,#eab308)}
._psv2-surface-card.database::before{background:linear-gradient(90deg,#eab308,#22d3ee)}
._psv2-surface-card.web::before{background:linear-gradient(90deg,#22d3ee,#6366f1)}
._psv2-surface-card.internal::before{background:linear-gradient(90deg,#6366f1,#4ade80)}
._psv2-surface-name{font-size:11px;font-weight:700;color:#a1a1aa;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
._psv2-surface-score{font:800 22px/1 'JetBrains Mono',ui-monospace,monospace;margin-bottom:4px}
._psv2-surface-bar{height:4px;background:rgba(255,255,255,.05);border-radius:2px;overflow:hidden;margin-top:6px}
._psv2-surface-bar-fill{height:100%;border-radius:2px;transition:width .8s ease}
._psv2-timeline{position:relative;padding-left:20px;margin-bottom:14px}
._psv2-timeline::before{content:'';position:absolute;left:6px;top:0;bottom:0;width:1px;background:rgba(255,255,255,.08)}
._psv2-timeline-item{position:relative;padding:8px 0 8px 16px;font-size:11px;color:#a1a1aa}
._psv2-timeline-item::before{content:'';position:absolute;left:-17px;top:12px;width:8px;height:8px;border-radius:50%;background:#22d3ee;border:2px solid #080714}
._psv2-timeline-item.error::before{background:#f87171}
._psv2-timeline-item.success::before{background:#4ade80}
._psv2-timeline-item.warning::before{background:#eab308}
._psv2-timeline-time{font-size:9px;color:#52525b;font-family:'JetBrains Mono',monospace;margin-bottom:2px}
._psv2-raw-box{background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:12px;max-height:400px;overflow:auto;font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.6;color:#a1a1aa;white-space:pre-wrap;word-break:break-all}
._psv2-empty{text-align:center;padding:40px 20px;color:#52525b;font-size:11px}
._psv2-empty svg{width:40px;height:40px;margin:0 auto 12px;display:block;opacity:.3}
._psv2-terminal{background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.06);border-radius:10px;overflow:hidden;margin-top:14px}
._psv2-term-header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(0,0,0,.3);border-bottom:1px solid rgba(255,255,255,.04)}
._psv2-term-title{font-size:10px;font-weight:600;color:#71717a;flex:1;display:flex;align-items:center;gap:6px}
._psv2-term-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid rgba(255,255,255,.06);background:transparent;color:#71717a;font-size:9px;font-weight:700;border-radius:4px;cursor:pointer;transition:all .15s}
._psv2-term-btn:hover{color:#a1a1aa;border-color:rgba(255,255,255,.15)}
._psv2-term-btn.active{color:#22d3ee;background:rgba(34,211,238,.08);border-color:rgba(34,211,238,.2)}
._psv2-term-body{height:160px;overflow-y:auto;padding:8px 12px;font:500 11px/1.6 'JetBrains Mono',ui-monospace,monospace;color:#a1a1aa}
._psv2-term-body::-webkit-scrollbar{width:4px}
._psv2-term-body::-webkit-scrollbar-thumb{background:rgba(34,211,238,.2);border-radius:2px}

`;

/* ─── Load-colored mini radial gauge (CPU/MEM: green→amber→red by load) ── */
function loadGauge(pct,label){
  pct=Math.max(0,Math.min(100,Math.round(pct||0)));
  var size=42,stroke=5,r=(size-stroke)/2,cx=size/2,c=2*Math.PI*r,off=c*(1-pct/100);
  var col=pct>85?'#ef4444':pct>65?'#f59e0b':'#22c55e';
  return'<span class="_svg"><svg width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'" aria-hidden="true">'
    +'<circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="'+stroke+'"/>'
    +'<circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="'+col+'" stroke-width="'+stroke+'" stroke-linecap="round" '
    +'stroke-dasharray="'+c.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'" transform="rotate(-90 '+cx+' '+cx+')" style="transition:stroke-dashoffset .8s ease"/>'
    +'<text x="'+cx+'" y="'+cx+'" text-anchor="middle" dominant-baseline="central" style="font:800 11px ui-monospace,monospace;fill:'+col+'">'+pct+'</text></svg>'
    +'<span class="_svgl">'+label+'</span></span>';
}

/* ─── Compact server chip (radial CPU/MEM gauges, pulsing dot) ── */
function mkSrvChip(id,h){
  var st=h.status==='online'?'on':h.status&&h.status!=='deploying'&&h.status!=='unknown'?'off':'unk';
  var stTxt=st==='on'?'online':st==='off'?'offline':'unknown';
  var addr=h.host||h.hostname||(id==='localhost'?'127.0.0.1':id);
  var cpu=h.cpu!=null?Math.round(h.cpu):null;
  var mem=h.mem!=null?Math.round(h.mem):null;
  var gauges=(cpu!=null||mem!=null)?'<span class="_svgauges">'+(cpu!=null?loadGauge(cpu,'CPU'):'')+(mem!=null?loadGauge(mem,'MEM'):'')+'</span>':'';
  var up=h.uptime?'<span class="_svup">'+ico('clock',9,'#64748b')+esc(String(h.uptime).replace(/^up\s*/i,'').slice(0,18))+'</span>':'';
  return'<button class="_svchip'+(S.host===id?' on':'')+'" data-srv="'+id+'" aria-pressed="'+(S.host===id)+'" aria-label="Target '+esc(h.name||id)+' '+addr+' '+stTxt+'">'
    +'<span class="_svdot '+st+'"></span>'
    +'<span class="_svmeta"><span class="_svn">'+esc(h.name||id)+'</span>'
    +'<span class="_sva">'+esc(addr)+'</span>'+up+'</span>'
    +gauges
    +'</button>';
}

/* ─── Compact mode card (checkbox, refined risk pill, a11y) ───── */
function mkModeCard(m){
  var rc=m.risk==='high'?'mb-hi':m.risk==='med'?'mb-me':'mb-lo';
  var fx=m.risk==='high'?' fx-hi':m.risk==='med'?' fx-me':'';
  var rt=m.risk==='high'?'HIGH':m.risk==='med'?'MED':'LOW';
  var active=S.mode===m.id, checked=!!S.selectedModes[m.id];
  return'<div class="_mc'+(active?' on':'')+fx+(checked?' sel':'')+'" data-mode="'+m.id+'" role="button" tabindex="0" aria-pressed="'+active+'" aria-label="'+esc(m.t)+', '+m.checks+' checks, '+rt+' risk. Enter to select.">'
    +'<label class="_mcchkbox" title="Select for batch run"><input type="checkbox" class="_mcsel" data-mode="'+m.id+'"'+(checked?' checked':'')+' aria-label="Add '+esc(m.t)+' to batch"></label>'
    +'<div class="_mctop"><span class="_mcico">'+ico(m.ico,18,'#22d3ee')+'</span>'
    +'<span class="_mcrisk '+rc+'"><span class="_rdot"></span>'+rt+'</span></div>'
    +'<div class="_mct">'+m.t+'</div>'
    +'<div class="_mcd">'+m.d+'</div>'
    +'<div class="_mcfoot"><span class="_mcchk">'+m.checks+(m.id==='full'?'+':'')+' checks</span>'
    +'<span class="_mcdur">'+ico('clock',10,'#64748b')+m.dur+'</span></div>'
    +'</div>';
}

/* ─── Health Score ring (idle '—' until a real scan completes) ── */
function vHealthRing(){
  var sc=S.lastScore, idle=(sc==null);
  var size=68,stroke=7,r=(size-stroke)/2,cx=size/2,c=2*Math.PI*r;
  var pct=idle?0:Math.max(0,Math.min(100,sc));
  var col=idle?'#475569':(pct>=80?'#22c55e':pct>=50?'#f59e0b':'#ef4444');
  var off=c*(1-pct/100);
  return'<div class="_hsring" role="img" aria-label="Overall health score '+(idle?'not yet measured':sc+' out of 100, '+(S.lastHealth||''))+'">'
    +'<svg width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'">'
    +'<circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="'+stroke+'"/>'
    +'<circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="'+col+'" stroke-width="'+stroke+'" stroke-linecap="round" '
    +'stroke-dasharray="'+c.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'" transform="rotate(-90 '+cx+' '+cx+')" style="transition:stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)"/>'
    +'<text id="_hsnum" x="'+cx+'" y="'+cx+'" text-anchor="middle" dominant-baseline="central" style="font:900 19px ui-monospace,monospace;fill:'+col+'">'+(idle?'—':sc)+'</text></svg>'
    +'<div class="_hsmeta"><div class="_hslbl">Health Score</div>'
    +'<div class="_hsval" style="color:'+col+'">'+(idle?'Run a scan':esc(S.lastHealth||''))+'</div></div></div>';
}

/* ─── Scan details panel (selected mode) ──────────────────────── */
function vModeDetails(m){
  if(!m) return'';
  var rt=m.risk==='high'?'HIGH RISK':m.risk==='med'?'MEDIUM RISK':'LOW RISK';
  var rcol=m.risk==='high'?'#f87171':m.risk==='med'?'#fbbf24':'#4ade80';
  return'<div class="_mdpanel">'
    +'<div class="_mdhead"><span class="_mdico">'+ico(m.ico,20,'#22d3ee')+'</span>'
    +'<div><div class="_mdt">'+m.t+'</div><div class="_mdsub">'+m.depth+' depth investigation</div></div></div>'
    +'<div class="_mdd">'+m.d+'</div>'
    +'<div class="_mdstats">'
    +'<div class="_mdstat"><div class="_mdsv">'+m.checks+(m.id==='full'?'+':'')+'</div><div class="_mdsl">Checks</div></div>'
    +'<div class="_mdstat"><div class="_mdsv">'+m.dur+'</div><div class="_mdsl">Est. Runtime</div></div>'
    +'<div class="_mdstat"><div class="_mdsv" style="color:'+rcol+';font-size:13px">'+rt+'</div><div class="_mdsl">Risk Level</div></div>'
    +'</div>'
    +'<div class="_mdsh">What will be scanned</div>'
    +'<ul class="_mdcaps">'+m.caps.map(function(c){return'<li>'+ico('check',11,'#4ade80')+'<span>'+esc(c)+'</span></li>';}).join('')+'</ul>'
    +'<div class="_mdperm">'+ico('shield',11,'#818cf8')+'<span>Permissions: '+esc(m.perms||'SSH read-only')+'</span></div>'
    +'</div>';
}

/* ─── Views ───────────────────────────────────────────────────── */
function vSetup(){
  var busy=S.status==='running';
  // Summary row: health ring + live/idle badge
  var summary='<div class="_setsummary">'+vHealthRing()
    +'<div class="_livebadge '+(busy?'live':'idle')+'">'+(busy
      ?'<span class="_lbdot"></span>SCANNING · '+Math.round(S.progress)+'%'
      :'<span class="_lbdot"></span>'+(S.connected?'CONNECTED':'IDLE'))+'</div>'
    +'</div>';

  // Compact server bar
  var chips=mkSrvChip('localhost',Object.assign({name:'Local Server',status:'online',host:'127.0.0.1'},S.hosts.localhost||{}));
  Object.keys(S.hosts).forEach(function(k){ if(k!=='localhost') chips+=mkSrvChip(k,S.hosts[k]||{}); });
  var srvbar='<div class="_setsh">'+ico('server',12,'#22d3ee')+'<span>Target Server</span></div><div class="_svbar">'+chips+'</div>';

  // Daily auto-scan scheduler
  var sch=S.schedule||{enabled:false,hour:3,minute:30};
  var hh=('0'+(sch.hour!=null?sch.hour:3)).slice(-2), mm=('0'+(sch.minute!=null?sch.minute:30)).slice(-2);
  var schbar='<div class="_schbar">'+ico('clock',13,sch.enabled?'#22c55e':'#52525b')
    +'<span class="_schl">Daily auto-scan</span>'
    +'<label class="_schtog"><input type="checkbox" id="_schen"'+(sch.enabled?' checked':'')+'><span>'+(sch.enabled?'Enabled':'Disabled')+'</span></label>'
    +'<span class="_schat">at</span>'
    +'<input type="number" id="_schh" min="0" max="23" value="'+hh+'" class="_schtime"> : '
    +'<input type="number" id="_schm" min="0" max="59" value="'+mm+'" class="_schtime">'
    +'<button id="_schsave" class="_schsave">Save</button>'
    +'<span id="_schmsg" class="_schmsg"></span></div>';

  // Category filter tabs + live search
  var tabs=MODE_CATS.map(function(cat){
    var on=(S.modeFilter==='all'&&cat==='All')||S.modeFilter===cat;
    return'<button class="_catf'+(on?' on':'')+'" data-cat="'+cat+'" role="tab" aria-selected="'+on+'">'+cat+'</button>';
  }).join('');
  var toolbar='<div class="_settoolbar"><div class="_catfs" role="tablist" aria-label="Scan category filter">'+tabs+'</div>'
    +'<div class="_setsearch">'+ico('scan',12,'#64748b')
    +'<input id="_modesearch" type="search" placeholder="Search scan modes…" value="'+esc(S.modeSearch)+'" aria-label="Search scan modes"></div></div>';

  // Filtered grid
  var q=(S.modeSearch||'').toLowerCase();
  var visible=MODES.filter(function(m){
    var catOk=S.modeFilter==='all'||MODE_CAT[m.id]===S.modeFilter||MODE_CAT[m.id]==='All';
    var sOk=!q||(m.t+' '+m.d+' '+m.caps.join(' ')).toLowerCase().indexOf(q)>=0;
    return catOk&&sOk;
  });
  var grid=visible.length
    ? visible.map(mkModeCard).join('')
    : '<div class="_nomatch">'+ICO.scan+'<div>No scan modes match your filter</div></div>';
  var panelOpen=!!MODES.find(function(m){return m.id===S.mode;});
  var sel=MODES.find(function(m){return m.id===S.mode;});
  var body='<div class="_setbody'+(panelOpen?'':' nopanel')+'">'
    +'<div class="_setleft"><div class="_mg" role="group" aria-label="Scan modes">'+grid+'</div></div>'
    +'<div class="_setright">'+vModeDetails(sel)+'</div>'
    +'</div>';

  // Footer: bulk actions + launch
  var selCount=Object.keys(S.selectedModes).filter(function(k){return S.selectedModes[k];}).length;
  var btn=busy
    ?'<button class="_launch running" disabled>'+ico('pulse',16,'#818cf8')+'<span>Scanning '+esc(S.host)+' — '+Math.round(S.progress)+'%</span></button>'
    :'<button class="_launch go" id="_nscgo" aria-label="Launch '+(sel?esc(sel.t):'scan')+'">'+ico('scan',16,'#22d3ee')+'<span>Launch '+(sel?sel.t:'Scan')+'</span></button>';
  var bulk='<div class="_bulk">'
    +'<button class="_bbtn" id="_quickscan"'+(busy?' disabled':'')+' title="Run full Deep Analysis (all low-risk subsystems)">'+ico('pulse',13,'#22c55e')+'Quick Scan</button>'
    +'<button class="_bbtn'+(selCount?' active':'')+'" id="_runsel"'+(busy||!selCount?' disabled':'')+' title="Run selected modes sequentially">'+ico('forensic',13,'currentColor')+'Run Selected'+(selCount?' ('+selCount+')':'')+'</button>'
    +'</div>';

  return'<div class="_setwrap">'+summary+srvbar+schbar+toolbar+body
    +'<div class="_setfoot">'+bulk+btn+'</div></div>';
}

function vProgress(){
  var pct=Math.round(S.progress);
  var done=S.steps.filter(function(x){return x==='done';}).length;
  var elapsed=S.scanStart>0?fmt(Date.now()-S.scanStart):'—';
  var tName=(S.hosts[S.host]&&S.hosts[S.host].name)||S.host;
  var modeMeta=MODES.find(function(m){return m.id===S.mode;})||{t:'Scan'};
  var stHtml=STEP_META.map(function(sm,i){
    var st=S.steps[i]||'pend';
    var cls=st==='done'?'done':st==='running'?'run':st==='error'?'err':'';
    return'<div class="_step '+cls+'"><div class="_stepico">'+ICO[sm.i]+'</div>'
      +'<span class="_stepname">'+sm.n+'</span></div>';
  }).join('');
  var logs=S.logs.slice(-200).map(function(l){
    return'<div class="_tl _line">'+fmtLogLine(l)+'</div>';
  }).join('');
  return'<div class="_progwrap">'
    +'<div class="_proghead">'
    +'<div class="_progtop">'
    +'<div class="_progtarget">'+ico('server',16,'#22d3ee')+'<span>'+esc(tName)+'</span>'
    +'<span style="font-size:10px;color:#52525b;font-weight:400">— '+modeMeta.t+'</span></div>'
    +'<div class="_progright">'
    +(S.status==='running'?'<button class="_stopbtn" id="_nscstop" aria-label="Stop scan">'+ico('alert',13,'currentColor')+'Stop</button>':'')
    +'<div class="_progpct">'+pct+'<span style="font-size:14px;color:#52525b">%</span></div></div>'
    +'</div>'
    +'<div class="_progbar"><div class="_progfill" id="_npf" style="width:'+pct+'%"></div></div>'
    +'<div class="_progmeta">'
    +'<span class="_progm">'+ico('check',12,'#22d3ee')+'<span>'+done+'/'+STEP_META.length+' steps</span></span>'
    +'<span class="_progm">'+ico('clock',12,'#52525b')+'<span>'+elapsed+'</span></span>'
    +'<span class="_progm" style="margin-left:auto;color:'+(S.status==='complete'?'#4ade80':S.status==='error'?'#ef4444':'#6366f1')+'">'
    +S.status.toUpperCase()+'</span>'
    +'</div>'
    +'</div>'
    +'<div class="_sh">Investigation Steps</div>'
    +'<div class="_stepgrid">'+stHtml+'</div>'
    +'<div class="_sh">Live Terminal</div>'
    +'<div class="_term"><div class="_termhead">'
    +'<div class="_termdots"><div class="_termdot" style="background:#ef4444"></div>'
    +'<div class="_termdot" style="background:#eab308"></div>'
    +'<div class="_termdot" style="background:#4ade80"></div></div>'
    +'<span class="_termtitle">nova-scan@'+esc(tName)+'</span>'
    +'<input id="_termsearch" class="_termsearch" placeholder="filter / search logs…" value="'+esc(S.termQuery)+'">'
    +'<button id="_termpause" class="_termbtn'+(S.termPaused?' on':'')+'">'+ico(S.termPaused?'clock':'pulse',11,'currentColor')+(S.termPaused?'Resume':'Pause')+'</button>'
    +'<button id="_termclear" class="_termbtn">'+ico('terminal',11,'currentColor')+'Clear</button>'
    +'<span class="_termlive">'+(S.status==='running'?'<span style="color:#4ade80">● LIVE</span>':S.status.toUpperCase())+'</span>'
    +'</div>'
    +'<div class="_termbody" id="_nterm">'+logs
    +(S.status==='running'?'<span class="_cursor"></span>':'')
    +'</div></div>'
    +'</div>';
}

/* ── Dashboard visual helpers ── */
function scoreColor(sc){return sc>=80?'#4ade80':sc>=60?'#eab308':'#ef4444';}
function arcGauge(sc,size,stroke,vCls){
  size=size||150;stroke=stroke||13;vCls=vCls||'_gv';
  sc=Math.max(0,Math.min(100,Math.round(sc||0)));
  var r=(size-stroke)/2,cx=size/2,c=2*Math.PI*r,off=c*(1-sc/100),col=scoreColor(sc);
  return'<svg width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'" class="_gauge">'
    +'<circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="'+stroke+'"/>'
    +'<circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="'+col+'" stroke-width="'+stroke+'" '
      +'stroke-linecap="round" stroke-dasharray="'+c.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'" '
      +'transform="rotate(-90 '+cx+' '+cx+')" style="transition:stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)"/>'
    +'<text x="'+cx+'" y="'+cx+'" text-anchor="middle" dominant-baseline="central" class="'+vCls+'" fill="'+col+'">'+sc+'</text>'
    +'</svg>';
}
function statTile(label,val,col,icn){
  return'<div class="_stile"><div class="_stico" style="background:'+col+'1a;color:'+col+'">'+ico(icn,18,col)+'</div>'
    +'<div class="_stmeta"><div class="_stv" style="color:'+col+'">'+esc(String(val))+'</div>'
    +'<div class="_stl">'+esc(label)+'</div></div></div>';
}
function escA(s){return esc(s).replace(/"/g,'&quot;');}
var PORTSVC={
  '20':['FTP-Data','HIGH'],'21':['FTP','HIGH'],'22':['SSH','MED'],'23':['Telnet','CRIT'],
  '25':['SMTP','MED'],'53':['DNS','LOW'],'80':['HTTP','MED'],'110':['POP3','MED'],'143':['IMAP','MED'],
  '389':['LDAP','HIGH'],'443':['HTTPS','LOW'],'445':['SMB','CRIT'],'465':['SMTPS','LOW'],'587':['SMTP','LOW'],
  '993':['IMAPS','LOW'],'995':['POP3S','LOW'],'1433':['MSSQL','HIGH'],'1521':['Oracle','HIGH'],
  '2049':['NFS','HIGH'],'2375':['Docker-API','CRIT'],'2376':['Docker-TLS','HIGH'],'3000':['Node/Dev','MED'],
  '3001':['Node/Dev','MED'],'3306':['MySQL','HIGH'],'3389':['RDP','HIGH'],'5000':['Flask/Dev','MED'],
  '5010':['App / API','LOW'],'5432':['PostgreSQL','HIGH'],'5900':['VNC','HIGH'],'6379':['Redis','CRIT'],
  '6443':['K8s-API','HIGH'],'8000':['HTTP-Alt','MED'],'8080':['HTTP-Alt','MED'],'8443':['HTTPS-Alt','LOW'],
  '9000':['App','MED'],'9090':['Prometheus','MED'],'9200':['Elasticsearch','HIGH'],'11211':['Memcached','HIGH'],
  '27017':['MongoDB','HIGH']
};
function portInfo(entry){
  var s=String(entry||'').trim();
  var idx=s.lastIndexOf(':');
  var bind=idx>=0?s.slice(0,idx):s, port=idx>=0?s.slice(idx+1):s;
  bind=bind.replace(/[\[\]]/g,'').replace(/%.*$/,'');
  var pub=(bind===''||bind==='0.0.0.0'||bind==='::'||bind==='*');
  var local=/^127\.|^::1$/.test(bind);
  var svc=PORTSVC[port]||['Port '+port,'LOW'];
  return{port:port,bind:bind||'*',svc:svc[0],risk:svc[1],pub:pub&&!local};
}
function riskColor(r){return r==='CRIT'?'#ef4444':r==='HIGH'?'#f97316':r==='MED'?'#eab308':'#4ade80';}
function logRow(line,sev){
  var col=sev==='er'?'#f87171':'#fbbf24';
  var m=String(line).match(/^(\w{3}\s+\d+\s+[\d:]+)\s+(\S+)\s+([^:[]+)(?:\[\d+\])?:\s*([\s\S]*)$/);
  if(m){
    return'<div class="_logr" style="border-left-color:'+col+'">'
      +'<div class="_logmeta"><span class="_logt">'+esc(m[1])+'</span>'
      +'<span class="_logsrc" style="color:'+col+'">'+esc(m[3].trim())+'</span></div>'
      +'<div class="_logm">'+esc(m[4])+'</div></div>';
  }
  return'<div class="_logr" style="border-left-color:'+col+'"><div class="_logm">'+esc(line)+'</div></div>';
}

function vResults(){
  if(!S.report){
    return'<div class="_empty">'+ICO.scan+'<div>No results yet</div><div style="font-size:10px;margin-top:4px">Run a scan to see the full intelligence report</div></div>';
  }
  var r=S.report;
  if(r.error) return'<div class="_rfi cr" style="font-size:12px"><span class="_rfsev">ERROR</span><div>'+esc(r.error)+'</div></div>';
  var sc=r.overallScore||0;
  var hc=sc>=80?'#4ade80':sc>=60?'#eab308':'#ef4444';
  var crits=((r.findings&&r.findings.critical)||[]).length;
  var warns=((r.findings&&r.findings.warnings)||[]).length;
  var tName=(S.hosts[S.host]&&S.hosts[S.host].name)||S.host;

  var subCount=r.subsystems?Object.keys(r.subsystems).length:0;
  var modeLabel=(r.mode||'scan').toUpperCase();
  // Hero dashboard: big score gauge + status banner + stat tiles
  var kpi='<div class="_dashhero">'
    +'<div class="_herogauge">'+arcGauge(sc,154,14,'_gvbig')
      +'<div class="_herohealth" style="color:'+hc+'">'+esc(r.health||'—')+'</div>'
      +'<div class="_herosub">'+esc(modeLabel)+' · '+esc(tName)+'</div></div>'
    +'<div class="_herostats">'
      +statTile('Critical Findings',crits,crits>0?'#f87171':'#4ade80','alert')
      +statTile('Warnings',warns,warns>0?'#fbbf24':'#a1a1aa','clock')
      +statTile('Subsystems',subCount,'#818cf8','cpu')
      +statTile('Health Score',sc+' / 100',hc,'pulse')
    +'</div>'
    +'</div>';

  var sub='';
  if(r.subsystems){
    sub='<div class="_sh">Subsystem Health</div><div class="_msggrid">';
    Object.values(r.subsystems).forEach(function(ss){
      sub+='<div class="_msg">'+arcGauge(ss.score,76,8,'_gvsm')
        +'<div class="_msgn">'+esc(ss.label)+'</div>'
        +'<div class="_msgv">'+esc(ss.value)+'</div>'
        +'</div>';
    });
    sub+='</div>';
  }

  var ai='';
  if(r.rootCause){
    var cf=r.rootCause.confidence||0;
    ai='<div class="_sh">AI Root Cause Analysis</div>'
      +'<div class="_raibox">'
      +'<div class="_raith">'+ico('ai',16,'#818cf8')+'<span class="_raitt">Intelligence Engine — '+esc(tName)+'</span></div>'
      +'<div class="_raic">'+esc(r.rootCause.summary||'No critical issues correlated.')+'</div>'
      +(cf?'<div class="_raicf"><span>Confidence: '+cf+'%</span><div class="_cfb"><div class="_cfbf" style="width:'+cf+'%"></div></div></div>':'')
      +'</div>';
  }

  // Correlation patterns panel
  var corr='';
  if(r.correlations&&r.correlations.length){
    corr='<div class="_sh">Correlation Patterns ('+r.correlations.length+')</div><div class="_corrwrap">';
    r.correlations.forEach(function(c){
      corr+='<div class="_corri">'+ico('ai',12,'#818cf8')+'<span>'+esc(c)+'</span></div>';
    });
    corr+='</div>';
  }

  // Containers panel
  var dock='';
  if(r.raw&&r.raw.containers&&r.raw.containers.length){
    dock='<div class="_sh">Containers ('+r.raw.containers.length+')</div><div class="_dwrap">';
    r.raw.containers.forEach(function(c){
      var stCls=c.unhealthy?'cr':c.restarting?'wa':c.exited?'wa':'ok';
      var stLabel=c.unhealthy?'UNHEALTHY':c.restarting?'RESTART':c.exited?'EXITED':'OK';
      dock+='<div class="_di '+stCls+'"><div class="_dih"><span class="_dn">'+esc(c.name||'?')+'</span>'
        +'<span class="_dst">'+stLabel+'</span></div>'
        +'<div class="_dv">'+esc((c.image||'').slice(0,60))+'</div>'
        +(c.cpu||c.memPct?'<div class="_dm">cpu '+esc(c.cpu||'-')+' · mem '+esc(c.memPct||'-')+'</div>':'')
        +'</div>';
    });
    dock+='</div>';
  }

  // Databases panel
  var dbp='';
  if(r.raw&&r.raw.databases&&Object.keys(r.raw.databases).length){
    dbp='<div class="_sh">Databases</div><div class="_dbwrap">';
    Object.entries(r.raw.databases).forEach(function(kv){
      var k=kv[0], v=kv[1];
      var label={postgres:'PostgreSQL',mysql:'MySQL / MariaDB',redis:'Redis',mongodb:'MongoDB'}[k]||k;
      var st=v.status||'unknown';
      var stCls=/active|running|ok/i.test(st)?'ok':'cr';
      dbp+='<div class="_dbi '+stCls+'"><div class="_dbh"><span class="_dbn">'+esc(label)+'</span>'
        +'<span class="_dbst">'+esc(st)+'</span></div>'
        +'<div class="_dbv">v'+esc(v.version||'?')+'</div>';
      var stats=[];
      if(v.connections!=null) stats.push(v.connections+' conn');
      if(v.slowQueries!=null) stats.push(v.slowQueries+' slow');
      if(v.waitingLocks!=null&&v.waitingLocks>0) stats.push(v.waitingLocks+' lock-wait');
      if(v.memory) stats.push('mem '+v.memory);
      if(v.keys!=null) stats.push(v.keys+' keys');
      if(stats.length) dbp+='<div class="_dbm">'+esc(stats.join(' · '))+'</div>';
      dbp+='</div>';
    });
    dbp+='</div>';
  }

  var allF=[].concat(
    (r.findings&&r.findings.critical||[]).map(function(f){return{cls:'cr',sev:'CRITICAL',a:f.area,m:f.msg,e:f.evidence||''};}),
    (r.findings&&r.findings.warnings||[]).map(function(f){return{cls:'wa',sev:'WARNING',a:f.area,m:f.msg,e:f.evidence||''};})
  );
  var finds='<div class="_sh">Findings ('+(allF.length||0)+')</div>';
  if(allF.length){
    // Filter chips (severity) + subsystem dropdown
    var critN=allF.filter(function(f){return f.cls==='cr';}).length;
    var warnN=allF.length-critN;
    var areas=[]; allF.forEach(function(f){ if(areas.indexOf(f.a)<0) areas.push(f.a); });
    var fsev=S.findFilter||'all', farea=S.findArea||'all';
    var chip=function(id,label,n){return'<button class="_ffchip'+(fsev===id?' on':'')+'" data-fsev="'+id+'">'+label+(n!=null?' <b>'+n+'</b>':'')+'</button>';};
    finds+='<div class="_ffbar">'
      +chip('all','All',allF.length)+chip('critical','Critical',critN)+chip('warning','Warning',warnN)
      +'<select class="_ffarea" id="_ffarea"><option value="all">All subsystems</option>'
      +areas.map(function(a){return'<option value="'+esc(a)+'"'+(farea===a?' selected':'')+'>'+esc(a)+'</option>';}).join('')
      +'</select></div>';
    var shown=allF.filter(function(f){
      var sevOk=fsev==='all'||(fsev==='critical'?f.cls==='cr':f.cls==='wa');
      var areaOk=farea==='all'||f.a===farea;
      return sevOk&&areaOk;
    });
    // sort: critical first, then by subsystem name
    shown.sort(function(a,b){ if(a.cls!==b.cls) return a.cls==='cr'?-1:1; return a.a<b.a?-1:a.a>b.a?1:0; });
    finds+= shown.length? shown.map(function(f){
      var ic=f.cls==='cr'?'alert':'clock';
      var icol=f.cls==='cr'?'#f87171':'#fbbf24';
      return'<div class="_rfi '+f.cls+'"><span class="_rfic" style="color:'+icol+'">'+ico(ic,15,icol)+'</span>'
        +'<div class="_rftx"><div class="_rfhd"><span class="_rfsev">'+f.sev+'</span><strong>'+esc(f.a)+'</strong></div>'
        +'<div class="_rfmsg">'+esc(f.m)+'</div>'
        +(f.e?'<div class="_rfev">'+ico('terminal',10,'#52525b')+'<span>Evidence: '+esc(f.e)+'</span></div>':'')
        +'</div></div>';
    }).join('') : '<div class="_rfi" style="opacity:.6"><div class="_rftx"><div class="_rfmsg">No findings match this filter.</div></div></div>';
  } else {
    finds+='<div class="_rfi ok"><span class="_rfic" style="color:#4ade80">'+ico('check',15,'#4ade80')+'</span>'
      +'<div class="_rftx"><div class="_rfhd"><span class="_rfsev">HEALTHY</span><strong>All Clear</strong></div>'
      +'<div class="_rfmsg">No significant issues detected across all subsystems.</div></div></div>';
  }

  var recs='';
  if(r.recommendations&&r.recommendations.length){
    recs='<div class="_sh">Remediation Recommendations ('+r.recommendations.length+')</div><div class="_recwrap">'
      +r.recommendations.map(function(rec){
        var p=rec.priority||'LOW';
        var pcol=p==='CRITICAL'?'#ef4444':p==='HIGH'?'#f97316':p==='MEDIUM'?'#eab308':'#4ade80';
        return'<div class="_recc" style="border-left-color:'+pcol+'">'
          +'<div class="_recch"><span class="_recp" style="background:'+pcol+'24;color:'+pcol+'">'+esc(p)+'</span>'
          +'<span class="_reca">'+esc(rec.action)+'</span></div>'
          +(rec.cmd?'<div class="_reccmd"><code>'+esc(rec.cmd)+'</code>'
            +'<button class="_copybtn" data-cmd="'+escA(rec.cmd)+'" title="Copy command">'+ico('terminal',12,'#22d3ee')+'</button></div>':'')
          +'</div>';
      }).join('')+'</div>';
  }

  var rawbox='';
  if(r.raw){
    if((r.raw.kernelErrors||[]).length)
      rawbox+='<div class="_sh">Kernel Error Log ('+r.raw.kernelErrors.length+')</div><div class="_logwrap">'
        +r.raw.kernelErrors.map(function(l){return logRow(l,'er');}).join('')+'</div>';
    if((r.raw.recentLogs||[]).length)
      rawbox+='<div class="_sh">System Error Log ('+r.raw.recentLogs.length+')</div><div class="_logwrap">'
        +r.raw.recentLogs.map(function(l){return logRow(l,'wn');}).join('')+'</div>';
    if((r.raw.openPorts||[]).length){
      var ports=r.raw.openPorts.map(portInfo);
      var pubP=ports.filter(function(p){return p.pub;}), locP=ports.filter(function(p){return !p.pub;});
      var portCards=function(list){
        return'<div class="_portgrid">'+list.map(function(p){
          var rcol=riskColor(p.risk);
          var cls=p.pub?((p.risk==='CRIT'||p.risk==='HIGH')?'cr':'wa'):'ok';
          return'<div class="_portc '+cls+'">'
            +'<div class="_portnum">'+esc(p.port)+'</div>'
            +'<div class="_portsvc">'+esc(p.svc)+'</div>'
            +'<div class="_portb"><span class="_portexp '+(p.pub?'pub':'loc')+'">'+(p.pub?'PUBLIC':'LOCAL')+'</span>'
            +'<span class="_portrisk" style="color:'+rcol+'">'+esc(p.risk)+'</span></div>'
            +'<div class="_portbind">'+esc(p.bind)+'</div></div>';
        }).join('')+'</div>';
      };
      rawbox+='<div class="_sh">Exposed Ports ('+ports.length+')</div>';
      if(pubP.length) rawbox+='<div class="_pgl pub">'+ico('alert',11,'#f87171')+'<span>Public-facing · '+pubP.length+'</span></div>'+portCards(pubP);
      if(locP.length) rawbox+='<div class="_pgl loc">'+ico('shield',11,'#4ade80')+'<span>Localhost-only · '+locP.length+'</span></div>'+portCards(locP);
    }
  }

  // Security Posture + Network Health chips
  var chip=function(label,val,good){
    var c=good?'#4ade80':'#f87171';
    return'<div class="_pchip" style="border-color:'+c+'40"><span class="_pcl">'+esc(label)+'</span>'
      +'<span class="_pcv" style="color:'+c+'">'+esc(val)+'</span></div>';
  };
  var secp='';
  if(r.raw&&r.raw.security){
    var sx=r.raw.security;
    secp='<div class="_sh">Security Posture</div><div class="_pchips">'
      +chip('Firewall',sx.firewallActive?(sx.firewallType||'active'):'OFF',!!sx.firewallActive)
      +chip('Fail2Ban',sx.fail2ban?'active':'inactive',!!sx.fail2ban)
      +chip('SSH root-login',sx.sshRootLogin||'?',!/^(yes|prohibit-password|without-password)$/.test(sx.sshRootLogin||''))
      +chip('SSH password-auth',sx.sshPassAuth||'?',sx.sshPassAuth!=='yes')
      +(sx.harden?chip('rkhunter',sx.harden.rkhunter==='not installed'?'n/a':((sx.harden.rkhunterWarnings||0)+' warn'),(sx.harden.rkhunterWarnings||0)===0):'')
      +(sx.harden?chip('auditd',(sx.harden.auditd||'n/a').replace('not installed','n/a'),/active/.test(sx.harden.auditd||'')):'')
      +'</div>';
    var sl=(sx.worldWritable||[]).map(function(f){return{i:'alert',t:'world-writable: '+f};})
      .concat((sx.suspiciousSuid||[]).map(function(f){return{i:'shield',t:'SUID: '+f};}))
      .concat((sx.sudoNopasswd||[]).map(function(f){return{i:'terminal',t:'NOPASSWD sudo: '+f};}));
    if(sl.length){secp+='<div class="_seclist">'+sl.map(function(x){
      return'<div class="_secli">'+ico(x.i,11,'#fbbf24')+'<span>'+esc(x.t)+'</span></div>';}).join('')+'</div>';}
  }
  var netp='';
  if(r.raw&&r.raw.network&&(r.raw.network.gateway||r.raw.network.dnsOk!=null)){
    var nx=r.raw.network;
    var certs=(nx.tlsCerts&&nx.tlsCerts.length)?nx.tlsCerts:(nx.tlsDays!=null?[{port:443,days:nx.tlsDays}]:[]);
    netp='<div class="_sh">Network Health</div><div class="_pchips">'
      +chip('DNS',nx.dnsOk===false?'failing':'resolving',nx.dnsOk!==false)
      +chip('Gateway',(nx.gateway||'?')+(nx.gatewayReachable===false?' ✕':''),nx.gatewayReachable!==false)
      +certs.map(function(tc){return chip('TLS :'+tc.port,(tc.days!=null?tc.days+'d left':'?'),tc.days==null||tc.days>=21);}).join('')
      +'</div>';
  }
  // Crash signals + top recurring errors
  var errp='';
  if(r.raw){
    var csg=r.raw.crashSignals||{},te=r.raw.topErrors||[];
    if((csg.segfaults||0)||(csg.coreDumps||0)||(csg.timeouts||0)){
      errp+='<div class="_sh">Crash Signals · 24h</div><div class="_herostats" style="grid-template-columns:repeat(3,1fr)">'
        +statTile('Segfaults',csg.segfaults||0,(csg.segfaults>0?'#f87171':'#4ade80'),'alert')
        +statTile('Core Dumps',csg.coreDumps||0,(csg.coreDumps>0?'#fbbf24':'#4ade80'),'forensic')
        +statTile('Timeouts',csg.timeouts||0,(csg.timeouts>0?'#fbbf24':'#a1a1aa'),'clock')+'</div>';
    }
    if(te.length){
      var maxc=Math.max.apply(null,te.map(function(x){return x.count||0;}))||1;
      errp+='<div class="_sh">Top Recurring Errors · 24h</div><div class="_freqwrap">'
        +te.map(function(x){
          var w=Math.max(6,Math.round((x.count||0)/maxc*100));
          return'<div class="_freqr"><div class="_freqbar" style="width:'+w+'%"></div>'
            +'<span class="_freqc">'+(x.count||0)+'×</span><span class="_freqp">'+esc(x.pattern||'')+'</span></div>';
        }).join('')+'</div>';
    }
  }

  return kpi+sub+ai+corr+secp+netp+dock+dbp+finds+recs+errp+rawbox
    +'<div id="_nremed"></div>'
    +'<div class="_resact">'
    +'<button class="_actbtn" id="_expjson" title="Download report as JSON">'+ico('forensic',13,'currentColor')+'Export JSON</button>'
    +'<button class="_actbtn" id="_expprint" title="Print / Save as PDF">'+ico('terminal',13,'currentColor')+'Print / PDF</button>'
    +'<button class="_newbtn" id="_nscagain" style="flex:1;margin-top:0">'+ico('scan',14,'#22d3ee')+' New Investigation</button>'
    +'</div>';
}

var _psv2={activeTab:'overview',sortCol:'port',sortDir:'asc',searchQuery:'',riskFilter:'all',scanStartTime:0,elapsedTimer:null};
function _psv2CalcRisk(){
  var rc={CRITICAL:0,HIGH:0,MED:0,LOW:0};
  S.portResults.forEach(function(p){
    var r=(p.risk||'LOW').toUpperCase();
    if(rc[r]!=null)rc[r]++;else rc.LOW++;
  });
  var score=Math.min(100,rc.CRITICAL*20+rc.HIGH*8+rc.MED*2);
  return{rc:rc,score:score};
}
function _psv2RiskClass(r){return r==='CRITICAL'?'critical':r==='HIGH'?'high':r==='MED'?'medium':'low';}
function _psv2RiskTag(r){
  var cls=r==='CRITICAL'?'_psv2-risk-critical':r==='HIGH'?'_psv2-risk-high':r==='MED'?'_psv2-risk-med':'_psv2-risk-low';
  return'<span class="'+cls+'">'+esc(r||'LOW')+'</span>';
}
function vPortV2(){
  var busy=S.portStatus==='running';
  var done=S.portStatus==='complete';
  var err=S.portStatus==='error';
  var risk=_psv2CalcRisk();
  var scoreCol=risk.score>=80?'#ef4444':risk.score>=50?'#fb923c':risk.score>=20?'#eab308':'#4ade80';
  var srvName=S.portTarget||(S.hosts&&S.hosts[S.host]?S.hosts[S.host].name:'')||S.host||'';

  var header='<div class="_psv2-header"><div class="_psv2-title-row">'
    +ico('port',20,'#22d3ee')
    +'<div><h2>Advanced Port Intelligence Scanner</h2>'
    +'<p>Deep service detection, security analysis, and attack surface mapping</p></div></div></div>';

  var inputSection='<div class="_psv2-input-section _psv2-glass">'
    +'<div class="_psv2-input-row">'
    +'<input class="_psv2-target-input" id="_psv2Target" type="text" placeholder="Target: IP, hostname, domain, CIDR (10.0.0.0/24), or comma-separated" value="'+esc(S.portTarget)+'" spellcheck="false">'
    +'<input class="_psv2-ports-input" id="_psv2Ports" type="text" placeholder="Ports: 22,80,443 or 1-1024 (optional)" value="'+esc(_psState.customPorts||'')+'">'
    +'<select class="_psv2-mode-select" id="_psv2Mode">'
    +'<option value="quick"'+(S.portMode==='quick'?' selected':'')+'>Quick Discovery</option>'
    +'<option value="standard"'+(S.portMode==='standard'?' selected':'')+'>Standard</option>'
    +'<option value="deep"'+(S.portMode==='deep'?' selected':'')+'>Deep Scan</option>'
    +'<option value="advanced"'+(S.portMode==='advanced'?' selected':'')+'>Advanced Intelligence</option>'
    +'<option value="full"'+(S.portMode==='full'?' selected':'')+'>Full Investigation</option>'
    +'</select>'
    +'<button class="_psv2-scan-btn'+(busy?' running':'')+'" id="_psv2ScanBtn">'
    +(busy?ico('stop',13,'#fca5a5')+' Cancel Scan':ico('port',13,'#22d3ee')+' Scan')
    +'</button></div>'
    +'<div class="_psv2-advanced-toggle"><button class="_psv2-adv-btn" id="_psv2AdvToggle">'+ico('settings',10,'#71717a')+' Advanced Settings &#9662;</button></div>'
    +'<div class="_psv2-advanced-panel" id="_psv2AdvPanel" style="display:none">'
    +'<div class="_psv2-adv-row"><label>Threads: <input type="range" min="10" max="200" value="120" id="_psv2Threads"> <span id="_psv2ThreadsV">120</span></label>'
    +'<label>Timeout: <input type="range" min="200" max="5000" step="100" value="2000" id="_psv2Timeout"> <span id="_psv2TimeoutV">2000ms</span></label></div></div></div>';

  var progressSection='';
  if(busy||S.portProgress>0){
    progressSection='<div class="_psv2-progress-section">'
      +'<div class="_psv2-progress-bar"><div class="_psv2-progress-fill" id="_psv2ProgFill" style="width:'+S.portProgress+'%"></div></div>'
      +'<div class="_psv2-progress-stats">'
      +'<span>Scanned: <b id="_psv2Scanned">'+(_psState.scanned||0)+'</b>/'+(_psState.total||0)+'</span>'
      +'<span>Open: <b id="_psv2OpenCount">'+S.portResults.length+'</b></span>'
      +'<span>Speed: <b id="_psv2Speed">0</b> ports/s</span>'
      +'<span>Elapsed: <b id="_psv2Elapsed">0s</b></span>'
      +'<span>ETA: <b id="_psv2ETA">Calculating...</b></span></div></div>';
  }

  var dashSection='';
  if(done||err||S.portResults.length>0){
    dashSection='<div class="_psv2-dashboard">'
      +'<div class="_psv2-dash-card"><span class="_psv2-dash-val" style="color:'+scoreCol+'">'+risk.score+'</span><span class="_psv2-dash-lbl">Risk Score</span></div>'
      +'<div class="_psv2-dash-card"><span class="_psv2-dash-val" style="color:#22d3ee">'+S.portResults.length+'</span><span class="_psv2-dash-lbl">Open Ports</span></div>'
      +'<div class="_psv2-dash-card"><span class="_psv2-dash-val" style="color:#ef4444">'+risk.rc.CRITICAL+'</span><span class="_psv2-dash-lbl">Critical</span></div>'
      +'<div class="_psv2-dash-card"><span class="_psv2-dash-val" style="color:#fb923c">'+risk.rc.HIGH+'</span><span class="_psv2-dash-lbl">High</span></div>'
      +'<div class="_psv2-dash-card"><span class="_psv2-dash-val" style="color:#eab308">'+risk.rc.MED+'</span><span class="_psv2-dash-lbl">Medium</span></div>'
      +'<div class="_psv2-dash-card"><span class="_psv2-dash-val" style="color:#4ade80">'+risk.rc.LOW+'</span><span class="_psv2-dash-lbl">Low</span></div></div>';
  }

  var tabsSection='';
  if(done||err||S.portResults.length>0){
    var tabs=['overview','ports','services','findings','surface','timeline','raw'];
    var tabLabels={overview:'Overview',ports:'Open Ports',services:'Services',findings:'Security Findings',surface:'Attack Surface',timeline:'Timeline',raw:'Raw Data'};
    tabsSection='<div class="_psv2-tabs">'
      +tabs.map(function(t){return'<button class="_psv2-tab'+(_psv2.activeTab===t?' active':'')+'" data-psv2tab="'+t+'">'+tabLabels[t]+'</button>';}).join('')
      +'</div>'
      +'<div class="_psv2-tab-content" id="_psv2TabContent">'+_psv2RenderTab()+'</div>';
  }

  var exportSection='';
  if(done||err||S.portResults.length>0){
    exportSection='<div class="_psv2-export-bar">'
      +'<button class="_psv2-export-btn" id="_psv2ExportJSON">'+ico('download',11,'#71717a')+' Export JSON</button>'
      +'<button class="_psv2-export-btn" id="_psv2ExportCSV">'+ico('download',11,'#71717a')+' Export CSV</button>'
      +'<button class="_psv2-export-btn" id="_psv2ExportMD">'+ico('download',11,'#71717a')+' Export Markdown</button></div>';
  }

  var termSection='<div class="_psv2-terminal">'
    +'<div class="_psv2-term-header">'
    +'<span class="_psv2-term-title">'+ico('terminal',10,'#71717a')+' Scan Log</span>'
    +'<button class="_psv2-term-btn'+(_psState.logPaused?' active':'')+'" id="_psv2TermPause">'+(_psState.logPaused?'Resume':'Pause')+'</button>'
    +'<button class="_psv2-term-btn" id="_psv2TermClear">Clear</button></div>'
    +'<div class="_psv2-term-body" id="_psv2Log">'
    +S.portLogs.slice(-100).map(function(l){
      var c=/error|fail|crit|panic/i.test(l)?'color:#f87171':/warn|alert|HIGH/i.test(l)?'color:#fb923c':/open|COMPLETE|done/i.test(l)?'color:#4ade80':/\[PORT\]|\[INIT\]/i.test(l)?'color:#22d3ee':'color:#a1a1aa';
      return'<div style="'+c+';padding:1px 0">'+esc(l)+'</div>';
    }).join('')
    +(S.status==='running'?'<span style="display:inline-block;width:7px;height:13px;background:#22d3ee;animation:_psv2-pulse .8s infinite;vertical-align:middle"></span>':'')
    +'</div></div>';

  if(S.portStatus==='idle'&&!S.portResults.length){
    return header+inputSection
      +'<div class="_psv2-empty">'+ICO.port+'<div>Enter a target and click Scan to begin</div>'
      +'<div style="font-size:10px;margin-top:4px">Supports IPv4, IPv6, hostname, domain, CIDR ranges, and comma-separated targets</div></div>'
      +termSection;
  }

  return header+inputSection+progressSection+dashSection+tabsSection+exportSection+termSection;
}

function _psv2RenderTab(){
  switch(_psv2.activeTab){
    case 'overview': return renderOverviewTab();
    case 'ports': return renderPortsTab();
    case 'services': return renderServicesTab();
    case 'findings': return renderFindingsTab();
    case 'surface': return renderAttackSurfaceTab();
    case 'timeline': return renderTimelineTab();
    case 'raw': return renderRawDataTab();
    default: return renderOverviewTab();
  }
}

function renderOverviewTab(){
  var risk=_psv2CalcRisk();
  var scoreCol=risk.score>=80?'#ef4444':risk.score>=50?'#fb923c':risk.score>=20?'#eab308':'#4ade80';
  var allF=(S.portCompleteData&&S.portCompleteData.findings)||[];
  var allRecs=(S.portCompleteData&&S.portCompleteData.recommendations)||[];
  var services={};
  S.portResults.forEach(function(p){var s=p.service||'Unknown';services[s]=(services[s]||0)+1;});
  var topSvcs=Object.keys(services).sort(function(a,b){return services[b]-services[a];}).slice(0,6);

  var html='<div class="_psv2-overview-grid">'
    +'<div class="_psv2-overview-card"><div class="_psv2-overview-val" style="color:'+scoreCol+'">'+risk.score+'</div><div class="_psv2-overview-lbl">Risk Score</div></div>'
    +'<div class="_psv2-overview-card"><div class="_psv2-overview-val" style="color:#22d3ee">'+S.portResults.length+'</div><div class="_psv2-overview-lbl">Open Ports</div></div>'
    +'<div class="_psv2-overview-card"><div class="_psv2-overview-val" style="color:#818cf8">'+Object.keys(services).length+'</div><div class="_psv2-overview-lbl">Services</div></div>'
    +'<div class="_psv2-overview-card"><div class="_psv2-overview-val" style="color:#f87171">'+allF.length+'</div><div class="_psv2-overview-lbl">Findings</div></div></div>';

  if(topSvcs.length){
    html+='<div class="_sh">Service Breakdown</div><div class="_psv2-overview-grid">';
    topSvcs.forEach(function(s){
      html+='<div class="_psv2-overview-card"><div class="_psv2-overview-val" style="color:#22d3ee;font-size:18px">'+services[s]+'</div><div class="_psv2-overview-lbl">'+esc(s)+'</div></div>';
    });
    html+='</div>';
  }

  if(allF.length){
    html+='<div class="_sh">Top Findings</div>';
    allF.slice(0,5).forEach(function(f){
      var sev=(f.severity||'INFO').toLowerCase();
      html+='<div class="_psv2-finding '+_psv2RiskClass(f.severity||'LOW')+'">'
        +'<span class="_psv2-finding-sev" style="background:rgba('+(sev==='critical'?'239,68,68':sev==='high'?'251,146,60':'234,179,8')+',.12);color:'+(sev==='critical'?'#f87171':sev==='high'?'#fb923c':'#eab308')+'">'+esc(f.severity||'INFO')+'</span>'
        +'<div class="_psv2-finding-text">'+esc(f.desc||f.type||'')+'</div></div>';
    });
  }
  return html;
}

function renderPortsTab(){
  var filtered=_psv2GetFilteredSorted();
  if(!filtered.length) return'<div class="_psv2-empty">No ports match current filter</div>';
  var html='<div class="_psv2-search">'+ico('search',12,'#52525b')
    +'<input id="_psv2SearchInput" type="text" placeholder="Search ports, services, versions..." value="'+esc(_psv2.searchQuery)+'"></div>'
    +'<div class="_psv2-table-wrap"><table class="_psv2-table"><thead><tr>'
    +'<th data-sort="port" class="'+(_psv2.sortCol==='port'?'sorted':'')+'">Port</th>'
    +'<th data-sort="service" class="'+(_psv2.sortCol==='service'?'sorted':'')+'">Service</th>'
    +'<th>Version</th>'
    +'<th data-sort="risk" class="'+(_psv2.sortCol==='risk'?'sorted':'')+'">Risk</th>'
    +'<th data-sort="latency" class="'+(_psv2.sortCol==='latency'?'sorted':'')+'">Latency</th>'
    +'</tr></thead><tbody>';
  filtered.forEach(function(p){
    var r=p.risk||'LOW';
    html+='<tr><td>'+esc(p.port)+'</td><td>'+esc(p.service||'Unknown')+'</td><td style="color:#71717a">'+esc(p.version||'-')+'</td><td>'+_psv2RiskTag(r)+'</td><td style="color:#71717a;font-family:ui-monospace,monospace">'+(p.latency!=null?p.latency+'ms':'-')+'</td></tr>';
  });
  html+='</tbody></table></div>';
  return html;
}

function renderServicesTab(){
  var services={};
  S.portResults.forEach(function(p){
    var s=p.service||'Unknown';
    if(!services[s])services[s]=[];
    services[s].push(p);
  });
  var keys=Object.keys(services).sort(function(a,b){return services[b].length-services[a].length;});
  if(!keys.length) return'<div class="_psv2-empty">No services detected</div>';
  var html='';
  keys.forEach(function(s){
    var ports=services[s];
    html+='<div class="_psv2-service-group">'
      +'<div class="_psv2-service-header"><span class="_psv2-service-name">'+ico('server',12,'#22d3ee')+' '+esc(s)+'</span>'
      +'<span class="_psv2-service-count">'+ports.length+' port'+(ports.length>1?'s':'')+'</span></div>'
      +'<div class="_psv2-service-body"><div class="_psv2-table-wrap"><table class="_psv2-table"><thead><tr><th>Port</th><th>Version</th><th>Risk</th><th>Latency</th></tr></thead><tbody>';
    ports.forEach(function(p){
      html+='<tr><td>'+esc(p.port)+'</td><td style="color:#71717a">'+esc(p.version||'-')+'</td><td>'+_psv2RiskTag(p.risk||'LOW')+'</td><td style="color:#71717a;font-family:ui-monospace,monospace">'+(p.latency!=null?p.latency+'ms':'-')+'</td></tr>';
    });
    html+='</tbody></table></div></div></div>';
  });
  return html;
}

function renderFindingsTab(){
  var allF=(S.portCompleteData&&S.portCompleteData.findings)||[];
  var risk=_psv2CalcRisk();
  if(!allF.length&&!risk.rc.CRITICAL&&!risk.rc.HIGH) return'<div class="_psv2-empty" style="color:#4ade80">'+ICO.check+'<div>No security findings detected</div></div>';
  var severityOrder={CRITICAL:0,HIGH:1,MED:2,LOW:3,INFO:4};
  var sorted=allF.slice().sort(function(a,b){return (severityOrder[a.severity]||4)-(severityOrder[b.severity]||4);});
  var html='';
  if(!sorted.length){
    html='<div class="_psv2-finding low"><span class="_psv2-finding-sev" style="background:rgba(74,222,128,.12);color:#4ade80">CLEAN</span><div class="_psv2-finding-text">No security findings from this scan</div></div>';
  }
  sorted.forEach(function(f){
    var sev=(f.severity||'INFO').toUpperCase();
    var bg=sev==='CRITICAL'?'rgba(239,68,68,.12)':sev==='HIGH'?'rgba(251,146,60,.1)':sev==='MED'?'rgba(234,179,8,.1)':'rgba(74,222,128,.1)';
    var col=sev==='CRITICAL'?'#f87171':sev==='HIGH'?'#fb923c':sev==='MED'?'#eab308':'#4ade80';
    html+='<div class="_psv2-finding '+_psv2RiskClass(sev)+'">'
      +'<span class="_psv2-finding-sev" style="background:'+bg+';color:'+col+'">'+esc(sev)+'</span>'
      +'<div class="_psv2-finding-text">'+esc(f.desc||f.type||'')
      +(f.port?'<div class="_psv2-finding-desc">Port '+esc(f.port)+'</div>':'')
      +'</div></div>';
  });
  return html;
}

function renderAttackSurfaceTab(){
  var surfaceCategories={
    external:{name:'External Exposure',cls:'external',ports:[80,443,8080,8443,21,25],desc:'Public-facing services'},
    management:{name:'Management Access',cls:'management',ports:[22,3389,5900,8443],desc:'Remote administration'},
    database:{name:'Database Services',cls:'database',ports:[3306,5432,6379,27017,1433,1521],desc:'Data storage services'},
    web:{name:'Web Services',cls:'web',ports:[80,443,3000,5000,8000,8080,8443,9000],desc:'HTTP/HTTPS endpoints'},
    internal:{name:'Internal Services',cls:'internal',ports:[53,88,135,139,445,389,636],desc:'Internal network services'}
  };
  var portMap={};
  S.portResults.forEach(function(p){portMap[parseInt(p.port)]=p;});
  var html='<div class="_psv2-surface-grid">';
  Object.keys(surfaceCategories).forEach(function(cat){
    var sc=surfaceCategories[cat];
    var found=0;var total=sc.ports.length;
    sc.ports.forEach(function(pt){if(portMap[pt])found++;});
    var pct=total?Math.round(found/total*100):0;
    var col=pct>=60?'#ef4444':pct>=30?'#fb923c':pct>0?'#eab308':'#4ade80';
    html+='<div class="_psv2-surface-card '+sc.cls+'">'
      +'<div class="_psv2-surface-name">'+esc(sc.name)+'</div>'
      +'<div class="_psv2-surface-score" style="color:'+col+'">'+pct+'%</div>'
      +'<div style="font-size:10px;color:#71717a">'+found+'/'+total+' ports active</div>'
      +'<div class="_psv2-surface-bar"><div class="_psv2-surface-bar-fill" style="width:'+pct+'%;background:'+col+'"></div></div>'
      +'<div style="font-size:9px;color:#52525b;margin-top:6px">'+esc(sc.desc)+'</div></div>';
  });
  html+='</div>';
  return html;
}

function renderTimelineTab(){
  var events=[];
  S.portLogs.forEach(function(l,i){
    var ts=l.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
    var cls='';
    if(/error|fail|crit|panic/i.test(l))cls='error';
    else if(/COMPLETE|done|success/i.test(l))cls='success';
    else if(/warn|alert/i.test(l))cls='warning';
    events.push({time:ts?ts[1]:'',msg:l.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/,''),cls:cls});
  });
  if(!events.length) return'<div class="_psv2-empty">No events yet</div>';
  var html='<div class="_psv2-timeline">';
  events.slice(-50).forEach(function(e){
    html+='<div class="_psv2-timeline-item '+e.cls+'">'
      +'<div class="_psv2-timeline-time">'+esc(e.time)+'</div>'
      +'<div>'+esc(e.msg)+'</div></div>';
  });
  html+='</div>';
  return html;
}

function renderRawDataTab(){
  var data={target:S.portTarget,mode:S.portMode,status:S.portStatus,results:S.portResults,completeData:S.portCompleteData,logs:S.portLogs,ts:new Date().toISOString()};
  return'<div class="_psv2-raw-box" id="_psv2RawBox">'+esc(JSON.stringify(data,null,2))+'</div>';
}

function _psv2GetFilteredSorted(){
  var results=S.portResults.slice();
  if(_psv2.searchQuery){
    var q=_psv2.searchQuery.toLowerCase();
    results=results.filter(function(p){return String(p.port).indexOf(q)>=0||(p.service||'').toLowerCase().indexOf(q)>=0||(p.version||'').toLowerCase().indexOf(q)>=0;});
  }
  if(_psv2.riskFilter!=='all'){
    results=results.filter(function(p){return(p.risk||'LOW')===_psv2.riskFilter.toUpperCase();});
  }
  var col=_psv2.sortCol,dir=_psv2.sortDir==='asc'?1:-1;
  results.sort(function(a,b){
    if(col==='port')return dir*(parseInt(a.port)||0)-(parseInt(b.port)||0);
    if(col==='service')return dir*((a.service||'').localeCompare(b.service||''));
    if(col==='risk'){
      var o={CRITICAL:0,HIGH:1,MED:2,LOW:3};
      return dir*((o[a.risk]||4)-(o[b.risk]||4));
    }
    if(col==='latency')return dir*((a.latency||0)-(b.latency||0));
    return 0;
  });
  return results;
}

function startScanV2(){
  if(S.portStatus==='running'){cancelScanV2();return;}
  var ti=document.getElementById('_psv2Target');
  var pi=document.getElementById('_psv2Ports');
  var mi=document.getElementById('_psv2Mode');
  S.portTarget=(ti&&ti.value.trim())||S.host;
  _psState.customPorts=(pi&&pi.value.trim())||'';
  S.portMode=(mi&&mi.value)||'deep';
  if(!S.portTarget){S.portTarget=S.host;}
  S.portStatus='running';S.portResults=[];S.portProgress=0;S.portLogs=[];S.portCompleteData=null;
  _psState.results=[];_psState.scanned=0;_psState.total=0;_psState.openCount=0;_psState.elapsed=0;_psState.logPaused=false;
  _psv2.scanStartTime=Date.now();
  _psv2Refresh();
  hookSocket();
  if(!S.socket){S.portLogs.push('[ERROR] WebSocket unavailable — check connection');S.portStatus='error';_psv2Refresh();return;}
  var sid=Date.now().toString(36);
  var opts={timeout:2000,threads:120};
  var th=document.getElementById('_psv2Threads');if(th)opts.threads=parseInt(th.value)||120;
  var to=document.getElementById('_psv2Timeout');if(to)opts.timeout=parseInt(to.value)||2000;
  S.socket.emit('portscan:start',{scanId:sid,target:S.portTarget,mode:S.portMode,options:opts,ports:_psState.customPorts||undefined});
  S.portLogs.push('[PORT] Scan launched: '+S.portTarget+' ['+S.portMode.toUpperCase()+'] id='+sid);
  _psv2Refresh();
  if(_psv2.elapsedTimer)clearInterval(_psv2.elapsedTimer);
  _psv2.elapsedTimer=setInterval(function(){
    if(S.portStatus!=='running')return;
    _psState.elapsed=Math.round((Date.now()-_psv2.scanStartTime)/1000);
    var el=document.getElementById('_psv2Elapsed');
    if(el)el.textContent=_psState.elapsed+'s';
    var sp=document.getElementById('_psv2Speed');
    if(sp&&_psState.elapsed>0)sp.textContent=Math.round(S.portResults.length/_psState.elapsed);
    if(_psState.total>0&&_psState.scanned>0){
      var eta=document.getElementById('_psv2ETA');
      if(eta){
        var remaining=_psState.total-_psState.scanned;
        var speed=_psState.elapsed>0?S.portResults.length/_psState.elapsed:0;
        var etaSec=speed>0?Math.round(remaining/speed):0;
        eta.textContent=etaSec>60?Math.round(etaSec/60)+'m':etaSec+'s';
      }
    }
  },1000);
}

function cancelScanV2(){
  S.portStatus='idle';
  if(_psv2.elapsedTimer){clearInterval(_psv2.elapsedTimer);_psv2.elapsedTimer=null;}
  S.portLogs.push('[CANCELLED] Scan cancelled by user');
  _psv2Refresh();
}

function exportJSON(){
  var data={target:S.portTarget,mode:S.portMode,status:S.portStatus,results:S.portResults,completeData:S.portCompleteData,ts:new Date().toISOString()};
  var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download='portscan_'+S.portTarget+'.json';a.click();
  URL.revokeObjectURL(url);
}

function exportCSV(){
  var headers=['Port','Service','Version','Risk','Latency'];
  var rows=S.portResults.map(function(p){return[p.port,p.service||'',p.version||'',p.risk||'LOW',p.latency!=null?p.latency:''].join(',');});
  var csv=headers.join(',')+'\n'+rows.join('\n');
  var blob=new Blob([csv],{type:'text/csv'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download='portscan_'+S.portTarget+'.csv';a.click();
  URL.revokeObjectURL(url);
}

function exportMarkdown(){
  var risk=_psv2CalcRisk();
  var md='# Port Scan Report: '+S.portTarget+'\n\n';
  md+='**Mode:** '+S.portMode.toUpperCase()+' | **Date:** '+new Date().toISOString()+'\n\n';
  md+='## Summary\n\n';
  md+='| Metric | Value |\n|---|---|\n';
  md+='| Risk Score | '+risk.score+'/100 |\n';
  md+='| Open Ports | '+S.portResults.length+' |\n';
  md+='| Critical | '+risk.rc.CRITICAL+' |\n';
  md+='| High | '+risk.rc.HIGH+' |\n';
  md+='| Medium | '+risk.rc.MED+' |\n';
  md+='| Low | '+risk.rc.LOW+' |\n\n';
  md+='## Open Ports\n\n';
  md+='| Port | Service | Version | Risk | Latency |\n|---|---|---|---|---|\n';
  S.portResults.forEach(function(p){
    md+='| '+p.port+' | '+(p.service||'')+' | '+(p.version||'-')+' | '+(p.risk||'LOW')+' | '+(p.latency!=null?p.latency+'ms':'-')+' |\n';
  });
  var allF=(S.portCompleteData&&S.portCompleteData.findings)||[];
  if(allF.length){
    md+='\n## Findings\n\n';
    allF.forEach(function(f){md+='- **['+(f.severity||'INFO')+']** '+(f.desc||f.type||'')+'\n';});
  }
  var blob=new Blob([md],{type:'text/markdown'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download='portscan_'+S.portTarget+'.md';a.click();
  URL.revokeObjectURL(url);
}

function _psv2Refresh(){
  var el=document.getElementById('_nsc_ports');
  if(el){el.innerHTML=vPortV2();_psv2Bind();}
  var pl=document.getElementById('_psv2Log');
  if(pl&&!_psState.logPaused){
    pl.innerHTML=S.portLogs.slice(-100).map(function(l){
      var c=/error|fail|crit|panic/i.test(l)?'color:#f87171':/warn|alert|HIGH/i.test(l)?'color:#fb923c':/open|COMPLETE|done/i.test(l)?'color:#4ade80':/\[PORT\]|\[INIT\]/i.test(l)?'color:#22d3ee':'color:#a1a1aa';
      return'<div style="'+c+';padding:1px 0">'+esc(l)+'</div>';
    }).join('');
    if(S.status==='running')pl.innerHTML+='<span style="display:inline-block;width:7px;height:13px;background:#22d3ee;animation:_psv2-pulse .8s infinite;vertical-align:middle"></span>';
    pl.scrollTop=pl.scrollHeight;
  }
  var pf=document.getElementById('_psv2ProgFill');
  if(pf)pf.style.width=S.portProgress+'%';
  var sc=document.getElementById('_psv2Scanned');
  if(sc)sc.textContent=_psState.scanned||0;
  var oc=document.getElementById('_psv2OpenCount');
  if(oc)oc.textContent=S.portResults.length;
}

function _psv2Bind(){
  var sb=document.getElementById('_psv2ScanBtn');
  if(sb)sb.onclick=startScanV2;
  var ti=document.getElementById('_psv2Target');
  if(ti)ti.oninput=function(){S.portTarget=this.value.trim();};
  var pi=document.getElementById('_psv2Ports');
  if(pi)pi.oninput=function(){_psState.customPorts=this.value.trim();};
  var mi=document.getElementById('_psv2Mode');
  if(mi)mi.onchange=function(){S.portMode=this.value;};
  var at=document.getElementById('_psv2AdvToggle');
  if(at)at.onclick=function(){var p=document.getElementById('_psv2AdvPanel');if(p)p.style.display=p.style.display==='none'?'block':'none';};
  var th=document.getElementById('_psv2Threads');
  if(th)th.oninput=function(){var v=document.getElementById('_psv2ThreadsV');if(v)v.textContent=this.value;};
  var to=document.getElementById('_psv2Timeout');
  if(to)to.oninput=function(){var v=document.getElementById('_psv2TimeoutV');if(v)v.textContent=this.value+'ms';};
  var tp=document.getElementById('_psv2TermPause');
  if(tp)tp.onclick=function(){_psState.logPaused=!_psState.logPaused;tp.classList.toggle('active',_psState.logPaused);tp.textContent=_psState.logPaused?'Resume':'Pause';};
  var tc=document.getElementById('_psv2TermClear');
  if(tc)tc.onclick=function(){S.portLogs=[];var l=document.getElementById('_psv2Log');if(l)l.innerHTML='';};
  var ej=document.getElementById('_psv2ExportJSON');
  if(ej)ej.onclick=exportJSON;
  var ec=document.getElementById('_psv2ExportCSV');
  if(ec)ec.onclick=exportCSV;
  var em=document.getElementById('_psv2ExportMD');
  if(em)em.onclick=exportMarkdown;
  document.querySelectorAll('[data-psv2tab]').forEach(function(el){
    el.onclick=function(){_psv2.activeTab=this.dataset.psv2tab;_psv2Refresh();};
  });
  document.querySelectorAll('.sorted,[data-sort]').forEach(function(el){
    if(el.dataset.sort)el.onclick=function(){
      var col=el.dataset.sort;
      if(_psv2.sortCol===col)_psv2.sortDir=_psv2.sortDir==='asc'?'desc':'asc';
      else{_psv2.sortCol=col;_psv2.sortDir='asc';}
      _psv2Refresh();
    };
  });
  var si=document.getElementById('_psv2SearchInput');
  if(si)si.oninput=function(){_psv2.searchQuery=this.value;_psv2Refresh();};
}
function vInfrastructure(){
  var html='<div class="_infra-hero">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">'
    +ico('server',18,'#a78bfa')+'<h2>Infrastructure Scanner</h2></div>'
    +'<p>Network diagnostics, port scanning, and infrastructure health tools</p>'
    +'</div>'
    +'<div class="_infra-grid">'
    // Port Scanner card
    +'<div class="_infra-card" id="_infra_portscan">'
    +'<div class="_icn">'+ico('port',28,'#22d3ee')+'</div>'
    +'<div class="_ilbl">Port Scanner</div>'
    +'<div class="_idesc">Scan IPs for open ports, services, and vulnerabilities</div>'
    +'<span class="_istat">'+S.portResults.length+' ports open</span>'
    +'</div>'
    // Ping / Connectivity card (placeholder)
    +'<div class="_infra-card" style="opacity:.5;cursor:default">'
    +'<div class="_icn">'+ico('pulse',28,'#52525b')+'</div>'
    +'<div class="_ilbl">Ping / Traceroute</div>'
    +'<div class="_idesc">Reachability and network path analysis</div>'
    +'<span class="_istat" style="background:rgba(82,82,91,.1);color:#52525b">Coming Soon</span>'
    +'</div>'
    // DNS card (placeholder)
    +'<div class="_infra-card" style="opacity:.5;cursor:default">'
    +'<div class="_icn">'+ico('scan',28,'#52525b')+'</div>'
    +'<div class="_ilbl">DNS Lookup</div>'
    +'<div class="_idesc">DNS resolution and record inspection</div>'
    +'<span class="_istat" style="background:rgba(82,82,91,.1);color:#52525b">Coming Soon</span>'
    +'</div>'
    +'</div>'
    +'<div id="_infra_port_content"></div>';
  return html;
}

function renderInfra(){
  var el=document.getElementById('_infra_body');
  if(!el) return;
  var isRun=INFRA.status==='running';
  var html='<div class="_ips-hero"><h3>'+ico('port',14,'#60a5fa')+' Port Scanner</h3>'
    +'<p>Scan a target IP or hostname for open ports and services</p></div>'
    +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    +'<input id="_iaddr" class="_tg" value="'+esc(INFRA.target||'')+'" placeholder="Target IP or hostname" '
    +'style="flex:1;min-width:160px;padding:8px 12px;font-size:12px"'+(isRun?' disabled':'')+'>'
    +'<select id="_imode" class="_tg" style="padding:8px 12px;font-size:11px;font-weight:600"'+(isRun?' disabled':'')+'>'
    +'<option value="quick"'+(INFRA.mode==='quick'?' selected':'')+'>Quick (top 1000)</option>'
    +'<option value="deep"'+(INFRA.mode==='deep'?' selected':'')+'>Deep (port 1-65535)</option>'
    +'</select>'
    +'<button id="_iscanbtn" class="_nb" style="background:rgba(59,130,246,.15);color:#60a5fa;padding:8px 18px;font-size:11px">'
    +(isRun?ico('stop',13,'#60a5fa')+' Scanning...':ico('port',13,'#60a5fa')+' Scan Ports')+'</button>'
    +'</div>'
    +'<div id="_iprogress" style="display:'+(isRun||INFRA.progress>0?'block':'none')+'">'
    +'<div class="_ips-bar"><div id="_ipf2" class="_ips-fill" style="width:'+INFRA.progress+'%"></div></div>'
    +'</div>'
    +'<div id="_iports" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-height:300px;overflow-y:auto">'
    +INFRA.results.slice(0,500).map(function(d){
      var rc2=d.risk==='CRITICAL'?'_cr':d.risk==='HIGH'?'_hi':d.risk==='MED'?'_me':'_lo';
      var rco2=d.risk==='CRITICAL'?'#ef4444':d.risk==='HIGH'?'#fb923c':d.risk==='MED'?'#eab308':'#4ade80';
      return '<div class="_ps-card '+rc2+'"><div class="_ps-num" style="font:800 18px ui-monospace,monospace;color:#e4e4e7">'+d.port+'</div>'
        +'<div style="font-size:9px;color:#a1a1aa;font-weight:600;margin:2px 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(d.service||'Unknown')+'</div>'
        +'<div style="display:flex;align-items:center;justify-content:center;gap:3px">'
        +'<span style="font:700 7px;padding:1px 5px;border-radius:3px;background:'+rco2+'22;color:'+rco2+'">'+esc(d.risk||'LOW')+'</span>'
        +(d.latency!=null?'<span style="font:500 8px ui-monospace;color:#52525b">'+d.latency+'ms</span>':'')+'</div></div>';
    }).join('')+'</div>'
    +'<div class="_ips-term" id="_iptlog">'
    +INFRA.logs.map(function(m){return '<div class="_tl '+logClass(m)+'">'+esc(m)+'</div>';}).join('')
    +'</div>';
  el.innerHTML=html;
  // Bind scan button
  var btn=document.getElementById('_iscanbtn');
  if(btn){
    btn.onclick=function(){
      if(INFRA.status==='running') return;
      var addr=document.getElementById('_iaddr');
      var mode=document.getElementById('_imode');
      INFRA.target=(addr&&addr.value.trim())||'';
      INFRA.mode=(mode&&mode.value)||'quick';
      if(!INFRA.target) return;
      INFRA.status='running';INFRA.results=[];INFRA.progress=0;INFRA.logs=[];INFRA.completeData=null;
      renderInfra();
      var sid=Date.now().toString(36);
      S.socket.emit('portscan:start',{scanId:sid,target:INFRA.target,mode:INFRA.mode,options:{timeout:2000,threads:120}});
      INFRA.logs.push('[PORT] Scanning '+INFRA.target+' ['+INFRA.mode.toUpperCase()+']');
    };
  }
  var iaddr=document.getElementById('_iaddr');
  if(iaddr){iaddr.oninput=function(){INFRA.target=this.value.trim();};}
  var imode=document.getElementById('_imode');
  if(imode){imode.onchange=function(){INFRA.mode=this.value;};}
  var term=document.getElementById('_iptlog');
  if(term)term.scrollTop=term.scrollHeight;
}


/* ─── Log classification ──────────────────────────────────────── */
function logClass(l){
  if(/error|fail|crit|panic|killed/i.test(l)) return 'er';
  if(/warn|alert|degraded/i.test(l)) return 'wn';
  if(/COMPLETE|PASSED|done|success/i.test(l)) return 'ok';
  if(/\[STEP|\[SCAN\]|\[INIT\]|\[PORT\]|\[KERN|\[LOG|\[SERV|\[NET|\[SEC|\[AI\]|\[ROOT/i.test(l)) return 'hi';
  if(/\[STEP [0-9]\]/.test(l)) return 'in';
  return 'dim';
}
var LOGCAT={SYSTEM:'#22d3ee',KERNEL:'#a78bfa',FILESYSTEM:'#34d399',LOGS:'#fbbf24',
  SERVICES:'#60a5fa',NETWORK:'#38bdf8',SECURITY:'#f87171',DOCKER:'#818cf8',DB:'#f472b6',
  AI:'#c084fc',STEP:'#94a3b8',INIT:'#22d3ee',SCAN:'#22d3ee',PORT:'#38bdf8',ROOT:'#94a3b8'};
function fmtLogLine(full){
  var m=String(full).match(/^(\[\d{2}:\d{2}:\d{2}\])\s*(\[[^\]]+\])?\s*([\s\S]*)$/);
  if(!m) return'<span class="_lgmsg">'+esc(full)+'</span>';
  var time=m[1].replace(/[\[\]]/g,''),tag=m[2]||'',msg=m[3]||'';
  var catKey=(tag.replace(/[\[\]]/g,'').split(/[: ]/)[0]||'').toUpperCase();
  var col=LOGCAT[catKey]||'#52525b';
  if(/COMPLETE/.test(tag)) col='#4ade80';
  var sev=/error|fail|crit|panic|killed|\bERR\b/i.test(msg)?'er'
    :/warn|alert|degraded|\bHIGH\b|unusual|disabled/i.test(msg)?'wn'
    :/COMPLETE|HEALTHY|\bOK\b|done|success|\bactive\b|ONLINE/i.test(msg)?'ok':'';
  var msgCls=sev==='er'?'_lger':sev==='wn'?'_lgwn':sev==='ok'?'_lgok':'_lgmsg';
  var tagHtml=tag?'<span class="_lgtag" style="color:'+col+';border-color:'+col+'55;background:'+col+'14">'
    +esc(tag.replace(/[\[\]]/g,''))+'</span>':'';
  return'<span class="_lgt">'+esc(time)+'</span>'+tagHtml+'<span class="'+msgCls+'">'+esc(msg)+'</span>';
}

/* ─── Render ──────────────────────────────────────────────────── */
function render(){
  var id={setup:'_nsc_setup',progress:'_nsc_prog',results:'_nsc_res',fleet:'_nsc_fleet',history:'_nsc_hist',ports:'_nsc_ports',infra:'_nsc_infra'};
  var fn={setup:vSetup,progress:vProgress,results:vResults,fleet:vFleet,history:vHistory,ports:vPortV2,infra:vInfrastructure};
  Object.keys(id).forEach(function(k){
    var el=document.getElementById(id[k]); if(el) el.innerHTML=fn[k]();
  });
  bind();
}

/* ── Fleet ── */
function cssId(s){return String(s).replace(/[^a-zA-Z0-9_-]/g,'_');}
function refreshFleet(){var el=document.getElementById('_nsc_fleet'); if(el){el.innerHTML=vFleet(); bind();}}
function doFleet(){
  if(S.fleetStatus==='running')return;
  S.fleetStatus='running'; S.fleetSummary=null; S.fleetResults={}; S.fleetHosts=[];
  refreshFleet();
  fetch('/api/scan/fleet',{method:'POST',headers:{'Authorization':'Bearer '+tok(),'Content-Type':'application/json'},body:JSON.stringify({mode:S.fleetMode})})
    .then(function(r){return r.ok?r.json():r.json().then(function(e){throw new Error(e.error||'fleet failed');});})
    .then(function(d){ S.fleetId=d.fleetId; }) // fleetscan:init will populate the grid
    .catch(function(e){ S.fleetStatus='idle';
      var el=document.getElementById('_nsc_fleet');
      if(el){el.innerHTML=vFleet()+'<div class="_empty" style="color:#f87171">'+esc(e.message)+'</div>';bind();} });
}
function doFleetDrill(hostId){
  fetch('/api/scan/history-list',{headers:{'Authorization':'Bearer '+tok()}})
    .then(function(r){return r.ok?r.json():{reports:[]};})
    .then(function(d){
      var rep=((d&&d.reports)||[]).filter(function(x){return x.hostId===hostId;})[0];
      if(rep&&rep.file)loadHistoryReport(rep.file);
    }).catch(function(){});
}
function flHealthCol(h){return h==='HEALTHY'?'#4ade80':h==='DEGRADED'?'#eab308':(h==='UNREACHABLE'||h==='ERROR'||h==='UNKNOWN')?'#52525b':'#ef4444';}
function vFleet(){
  var hosts=S.fleetHosts||[];
  var res=S.fleetResults||{};
  var modeSel='<select id="_flmode" class="_sel" '+(S.fleetStatus==='running'?'disabled':'')+'>'
    +['deep','full','security','quick'].map(function(m){return'<option value="'+m+'"'+(S.fleetMode===m?' selected':'')+'>'+m.toUpperCase()+'</option>';}).join('')
    +'</select>';
  var doneN=Object.keys(res).filter(function(k){return res[k].state==='done';}).length;
  var totalN=hosts.length||Object.keys(res).length;
  var running=S.fleetStatus==='running';
  var btn='<button id="_flgo" class="_hbtn'+(running?'':' active')+'"'+(running?' disabled':'')+'>'
    +ico('scan',13,running?'#52525b':'#22d3ee')+(running?('Scanning… '+doneN+'/'+totalN):'Scan All Hosts')+'</button>';
  var head='<div class="_histtop"><div class="_sh" style="margin:0">Fleet Scan'+(totalN?(' · '+totalN+' host'+(totalN>1?'s':'')):'')+'</div>'
    +'<div style="display:flex;gap:8px;margin-left:auto;align-items:center">'+modeSel+btn+'</div></div>';

  // Summary band (after completion)
  var summ='';
  if(S.fleetSummary){
    var s=S.fleetSummary;
    var wh=s.worstHost?(s.worstHost.name+' ('+(s.worstHost.score)+')'):'—';
    summ='<div class="_flsumm">'
      +'<div class="_flgauge">'+arcGauge(s.avgScore||0,104,11)+'<div class="_flgl">Fleet Avg</div></div>'
      +'<div class="_fltiles">'
      +statTile('Reachable',(s.reachable||0)+'/'+(s.total||0),'#4ade80','server')
      +statTile('Unreachable',s.unreachable||0,(s.unreachable?'#f87171':'#52525b'),'alert')
      +statTile('Total Critical',s.totalCritical||0,(s.totalCritical?'#ef4444':'#4ade80'),'forensic')
      +statTile('Worst Host',wh,'#eab308','pulse')
      +statTile('Duration',Math.round((s.durationMs||0)/1000)+'s','#22d3ee','clock')
      +'</div></div>';
  }

  if(!totalN){
    return head+'<div class="_empty">'+ICO.scan+'<div>Scan every registered host at once</div>'
      +'<div style="font-size:10px;margin-top:4px">Runs the selected mode across all SSH hosts (bounded concurrency) and ranks them by health.</div></div>';
  }

  // Cards — order: completed worst-first once summary exists, else host order
  var order=hosts.map(function(h){return h.hostId;});
  if(S.fleetSummary&&Array.isArray(S.fleetSummary.results))order=S.fleetSummary.results.map(function(r){return r.hostId;});
  var cards=order.map(function(hid){
    var r=res[hid]||{hostId:hid,state:'pending'};
    var nm=r.name||hid;
    var st=r.state||'pending';
    var col=st==='done'?flHealthCol(r.health):'#52525b';
    var right;
    if(st==='done'){
      var sc=(r.health==='UNREACHABLE'||r.health==='ERROR'||r.health==='UNKNOWN')?null:r.score;
      right=(sc==null)
        ? '<div class="_flbad" style="color:'+col+'">'+ico('alert',13,col)+esc(r.health||'?')+'</div>'
        : '<div class="_flscore" style="color:'+scoreColor(sc)+'">'+sc+'<span>/100</span></div>';
    } else if(st==='running'){
      right='<div class="_flpw"><div class="_flpbar"><div id="_flp_'+cssId(hid)+'" class="_flpf" style="width:'+(r.pct||0)+'%"></div></div><span>'+(r.pct||0)+'%</span></div>';
    } else {
      right='<div class="_flpend">queued</div>';
    }
    var sub='';
    if(st==='done'&&r.worst&&typeof r.worst.score==='number')
      sub='<div class="_flsub">weakest: <b style="color:'+scoreColor(r.worst.score)+'">'+esc(r.worst.label)+' '+r.worst.score+'</b></div>';
    var counts='';
    if(st==='done'&&(r.critical||r.warnings))
      counts='<div class="_flcnt">'+(r.critical?('<span class="_flc">'+r.critical+' crit</span>'):'')+(r.warnings?('<span class="_flw">'+r.warnings+' warn</span>'):'')+'</div>';
    var dotcls=st==='done'?'':(st==='running'?'_run':'_pend');
    return '<div class="_flcard" data-host="'+escA(hid)+'" data-state="'+st+'" style="border-color:'+col+'33'+(st==='done'?';cursor:pointer':'')+'">'
      +'<div class="_flcl"><div class="_fldot '+dotcls+'" style="background:'+col+'"></div>'
      +'<div class="_flnm"><div class="_flhn">'+esc(nm)+'</div><div class="_flhid">'+esc(hid.replace(/^ssh-/,''))+'</div></div></div>'
      +'<div class="_flcr">'+right+counts+sub+'</div></div>';
  }).join('');

  return head+summ+'<div class="_flgrid">'+cards+'</div>';
}

/* ── Remediation (guarded) ── */
var _remStatus=null;
function loadRemediationStatus(){
  var el=document.getElementById('_nremed'); if(!el)return; el.dataset.loaded='1';
  if(_remStatus){ el.innerHTML=vRemediation(_remStatus); bind(); return; }
  fetch('/api/scan/remediation/status',{headers:{'Authorization':'Bearer '+tok()}})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){ _remStatus=d||{enabled:false,actions:[]};
      var e=document.getElementById('_nremed'); if(e){e.innerHTML=vRemediation(_remStatus);bind();} })
    .catch(function(){});
}
function vRemediation(st){
  if(!st)return'';
  if(!st.enabled){
    return'<div class="_sh">Remediation</div>'
      +'<div class="_remoff">'+ico('shield',13,'#52525b')
      +'<span>Guarded remediation is <b>disabled</b> — read-only mode. Enable with <code>REMEDIATION_ENABLED=true</code> on the server.</span></div>';
  }
  var riskCol={low:'#4ade80',medium:'#eab308',high:'#ef4444'};
  return'<div class="_sh">Remediation · one-click <span style="color:#f59e0b;font-size:9px">(confirm required · audited)</span></div>'
    +'<div class="_remgrid">'+(st.actions||[]).map(function(a){
      var c=riskCol[a.risk]||'#a1a1aa';
      return'<button class="_rembtn" data-action="'+escA(a.id)+'" data-needs="'+escA((a.needs||[]).join(','))+'" style="border-color:'+c+'40">'
        +'<span class="_remrisk" style="background:'+c+'22;color:'+c+'">'+esc(a.risk)+'</span>'
        +'<span class="_remlbl">'+esc(a.label)+'</span></button>';
    }).join('')+'</div>';
}
function doRemediate(action,needsCsv){
  var hostId=(S.report&&S.report.hostId)||'localhost';
  var params={};
  var needs=(needsCsv||'').split(',').filter(Boolean);
  for(var i=0;i<needs.length;i++){
    var v=window.prompt('Remediation "'+action+'" — enter '+needs[i]+':');
    if(v==null)return; params[needs[i]]=v.trim();
  }
  var detail=needs.map(function(n){return n+'='+params[n];}).join(', ');
  if(!window.confirm('Run "'+action+'"'+(detail?(' ('+detail+')'):'')+' on '+hostId+'?\nThis change is applied immediately and logged.'))return;
  addLog('[REMEDIATE] '+action+(detail?(' '+detail):'')+' on '+hostId+' …');
  fetch('/api/scan/remediate',{method:'POST',headers:{'Authorization':'Bearer '+tok(),'Content-Type':'application/json'},
    body:JSON.stringify({hostId:hostId,action:action,params:params,confirm:true})})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
    .then(function(x){
      if(x.ok&&x.j.ok){ addLog('[REMEDIATE ✓] '+action+' → '+(x.j.output||'done'));
        try{if(window.Notification)notify('Remediation applied',action+' on '+hostId);}catch(e){} }
      else addLog('[REMEDIATE ✗] '+action+' failed: '+((x.j&&(x.j.error||x.j.stderr))||'error'));
    })
    .catch(function(e){addLog('[REMEDIATE ✗] '+action+' error: '+e.message);});
}

/* ── History ── */
function loadHistory(){
  S.historyLoading=true;
  var el=document.getElementById('_nsc_hist'); if(el) el.innerHTML=vHistory();
  fetch('/api/scan/history-list',{headers:{'Authorization':'Bearer '+tok()}})
    .then(function(r){return r.ok?r.json():{reports:[],alert:null};})
    .then(function(d){
      S.history=(d&&d.reports)||[];
      S.historyAlert=(d&&d.alert)||null;
      S.historyLoading=false;
      var e=document.getElementById('_nsc_hist'); if(e){e.innerHTML=vHistory();bind();}
    })
    .catch(function(){S.history=[];S.historyLoading=false;
      var e=document.getElementById('_nsc_hist'); if(e){e.innerHTML=vHistory();bind();}});
}
function loadHistoryReport(file){
  fetch('/api/scan/report/'+encodeURIComponent(file),{headers:{'Authorization':'Bearer '+tok()}})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){ if(d){S.report=d;setTab('results');
      var e=document.getElementById('_nsc_res'); if(e){e.innerHTML=vResults();bind();}} });
}
function vHistory(){
  if(S.historyLoading&&!S.history) return'<div class="_empty">'+ICO.scan+'<div>Loading scan history…</div></div>';
  var h=S.history||[];
  var alertBanner='';
  if(S.historyAlert){
    var a=S.historyAlert;
    alertBanner='<div class="_histalert">'+ico('alert',15,'#f87171')
      +'<div><div class="_haln">Active Alert · '+esc(a.health||'')+' · '+(a.score)+'/100</div>'
      +'<div class="_halr">'+esc((a.reasons||[]).join(' · '))+'</div></div></div>';
  }
  var cmpN=Object.keys(S.cmpSel||{}).filter(function(k){return S.cmpSel[k];}).length;
  var bar='<div class="_histtop"><div class="_sh" style="margin:0">Scan History ('+h.length+')</div>'
    +'<div style="display:flex;gap:8px;margin-left:auto">'
    +'<button id="_nhcompare" class="_hbtn'+(cmpN===2?' active':'')+'"'+(cmpN===2?'':' disabled')+'>'+ico('forensic',12,'currentColor')+'Compare'+(cmpN?' ('+cmpN+'/2)':'')+'</button>'
    +'<button id="_nhrefresh" class="_hbtn">'+ico('scan',12,'#22d3ee')+'Refresh</button></div></div>';
  if(!h.length) return alertBanner+bar+'<div class="_empty">'+ICO.scan+'<div>No saved scans yet</div><div style="font-size:10px;margin-top:4px">Daily auto-scan runs at 03:30 · or launch one now</div></div>';

  // trend sparkline (oldest -> newest)
  var chron=h.slice().reverse();
  var spark='<div class="_sh">Score Trend</div><div class="_spark">';
  chron.forEach(function(x){
    var sc=x.score||0,c=sc>=80?'#4ade80':sc>=60?'#eab308':'#ef4444';
    spark+='<div class="_spb" title="'+esc(x.ts)+' · '+sc+'/100"><div class="_spbf" style="height:'+Math.max(4,sc)+'%;background:'+c+'"></div></div>';
  });
  spark+='</div>';

  var rows='<div class="_histtbl">'
    +'<div class="_htr _hth"><span></span><span>Time</span><span>Mode</span><span>Score</span><span>Status</span><span>Crit</span><span>Warn</span></div>';
  h.forEach(function(x){
    var sc=x.score||0,c=sc>=80?'#4ade80':sc>=60?'#eab308':'#ef4444';
    var hc=x.health==='HEALTHY'?'#4ade80':x.health==='CRITICAL'?'#ef4444':'#eab308';
    var checked=!!(S.cmpSel&&S.cmpSel[x.file]);
    rows+='<div class="_htr _histrow" data-file="'+esc(x.file)+'">'
      +'<span class="_htchk"><input type="checkbox" class="_cmpchk" data-file="'+esc(x.file)+'"'+(checked?' checked':'')+' aria-label="Select for compare"></span>'
      +'<span class="_htts">'+esc(x.ts)+'</span>'
      +'<span class="_htmd">'+esc(x.mode||'-')+'</span>'
      +'<span style="color:'+c+';font-weight:700">'+sc+'</span>'
      +'<span style="color:'+hc+'">'+esc(x.health||'-')+'</span>'
      +'<span style="color:'+(x.critical>0?'#f87171':'#52525b')+'">'+(x.critical||0)+'</span>'
      +'<span style="color:'+(x.warnings>0?'#fbbf24':'#52525b')+'">'+(x.warnings||0)+'</span>'
      +'</div>';
  });
  rows+='</div>';
  return alertBanner+bar+spark+rows;
}

/* ── Compare two scans side-by-side ── */
function doCompare(){
  var files=Object.keys(S.cmpSel||{}).filter(function(k){return S.cmpSel[k];});
  if(files.length!==2) return;
  var el=document.getElementById('_nsc_hist'); if(el) el.innerHTML='<div class="_empty">'+ICO.scan+'<div>Loading comparison…</div></div>';
  Promise.all(files.map(function(f){
    return fetch('/api/scan/report/'+encodeURIComponent(f),{headers:{'Authorization':'Bearer '+tok()}}).then(function(r){return r.ok?r.json():null;});
  })).then(function(res){
    if(!res[0]||!res[1]){ loadHistory(); return; }
    // order oldest -> newest by ts
    var a=res[0],b=res[1]; if((a.ts||0)>(b.ts||0)){ var t=a;a=b;b=t; }
    var e=document.getElementById('_nsc_hist'); if(e){ e.innerHTML=vCompare(a,b); bind(); }
  }).catch(function(){ loadHistory(); });
}
function _fset(rep,sev){ var o={}; ((rep.findings||{})[sev]||[]).forEach(function(f){o[(f.area||'')+'::'+(f.msg||'')]=f;}); return o; }
function vCompare(a,b){
  var dScore=(b.overallScore||0)-(a.overallScore||0);
  var dCol=dScore>0?'#4ade80':dScore<0?'#ef4444':'#a1a1aa';
  var head='<div class="_histtop"><button id="_cmpback" class="_hbtn">'+ico('scan',12,'#22d3ee')+'Back</button>'
    +'<div class="_sh" style="margin:0 auto">Scan Comparison</div></div>'
    +'<div class="_cmpkpis">'
    +'<div class="_cmpkpi"><div class="_cmpts">'+esc(a.ts||new Date(a.ts).toISOString())+'</div><div class="_cmpsc" style="color:'+scoreColor(a.overallScore||0)+'">'+(a.overallScore!=null?a.overallScore:'—')+'</div><div class="_cmplb">'+esc(a.health||'')+'</div></div>'
    +'<div class="_cmparrow"><div style="color:'+dCol+';font-weight:800;font-size:18px">'+(dScore>0?'▲ +'+dScore:dScore<0?'▼ '+dScore:'= 0')+'</div><div class="_cmplb">score Δ</div></div>'
    +'<div class="_cmpkpi"><div class="_cmpts">'+esc(b.ts||'')+'</div><div class="_cmpsc" style="color:'+scoreColor(b.overallScore||0)+'">'+(b.overallScore!=null?b.overallScore:'—')+'</div><div class="_cmplb">'+esc(b.health||'')+'</div></div>'
    +'</div>';
  // subsystem deltas
  var subs=a.subsystems||{}, subsB=b.subsystems||{}, subOut='';
  Object.keys(subs).forEach(function(k){
    var sa=subs[k]||{}, sb=subsB[k]||{}, d=(sb.score||0)-(sa.score||0);
    var dc=d>0?'#4ade80':d<0?'#ef4444':'#52525b';
    subOut+='<div class="_cmprow"><span class="_cmpn">'+esc(sa.label||k)+'</span>'
      +'<span style="color:'+scoreColor(sa.score||0)+'">'+(sa.score||0)+'</span>'
      +'<span style="color:'+dc+';font-weight:700">'+(d>0?'+'+d:d)+'</span>'
      +'<span style="color:'+scoreColor(sb.score||0)+'">'+(sb.score||0)+'</span></div>';
  });
  var subsBlock='<div class="_sh">Subsystem Scores (then → now)</div><div class="_cmptbl">'
    +'<div class="_cmprow _cmph"><span>Subsystem</span><span>Before</span><span>Δ</span><span>After</span></div>'+subOut+'</div>';
  // findings diff (critical + warnings)
  function diffBlock(sev,label){
    var oa=_fset(a,sev), ob=_fset(b,sev);
    var added=Object.keys(ob).filter(function(k){return !oa[k];}).map(function(k){return ob[k];});
    var removed=Object.keys(oa).filter(function(k){return !ob[k];}).map(function(k){return oa[k];});
    if(!added.length&&!removed.length) return '';
    var out='<div class="_sh">'+label+' changes</div><div class="_cmpdiff">';
    added.forEach(function(f){out+='<div class="_diffi add">'+ico('alert',12,'#f87171')+'<span><b>NEW</b> ['+esc(f.area)+'] '+esc(f.msg)+'</span></div>';});
    removed.forEach(function(f){out+='<div class="_diffi rem">'+ico('check',12,'#4ade80')+'<span><b>RESOLVED</b> ['+esc(f.area)+'] '+esc(f.msg)+'</span></div>';});
    return out+'</div>';
  }
  var critBlock=diffBlock('critical','Critical'), warnBlock=diffBlock('warnings','Warning');
  return head+subsBlock+critBlock+warnBlock
    +((critBlock||warnBlock)?'':'<div class="_cmpnochange">No finding changes between these two scans.</div>');
}

function setTab(t){
  S.activeTab=t;
  document.querySelectorAll('._nt').forEach(function(el){
    el.classList.toggle('on',el.dataset.tab===t);
  });
  document.querySelectorAll('._nv').forEach(function(el){
    el.classList.toggle('on',el.dataset.view===t);
  });
  if(t==='history'&&!S.history&&!S.historyLoading) loadHistory();
  if(t==='setup'&&S.status!=='running') renderSetup(); // refresh health ring / live badge
  if(t==='setup') loadSchedule();
}

var _hsShown=null;
function animateHealth(){
  var t=document.getElementById('_hsnum'); if(!t) return;
  var target=S.lastScore; if(target==null) return;
  if(_hsShown===target){ t.textContent=target; return; } // already shown — no re-animate on minor re-renders
  _hsShown=target;
  var t0=(window.performance&&performance.now)?performance.now():Date.now(), dur=900;
  function step(now){
    var p=Math.min(1,((now||Date.now())-t0)/dur);
    t.textContent=Math.round(target*(1-Math.pow(1-p,3))); // easeOutCubic
    if(p<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function renderSetup(){var el=document.getElementById('_nsc_setup'); if(el){el.innerHTML=vSetup(); bind(); animateHealth();}}
function loadSchedule(){
  if(S._schedLoaded) return; S._schedLoaded=true;
  fetch('/api/scan/schedule',{headers:{'Authorization':'Bearer '+tok()}})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){ if(d){ S.schedule=d; renderSetup(); } })
    .catch(function(){});
}
function saveSchedule(){
  var en=document.getElementById('_schen'), hh=document.getElementById('_schh'), mm=document.getElementById('_schm'), msg=document.getElementById('_schmsg');
  var body={enabled:en&&en.checked, hour:hh?parseInt(hh.value):3, minute:mm?parseInt(mm.value):30};
  if(msg){msg.textContent='Saving…';msg.style.color='#64748b';}
  fetch('/api/scan/schedule',{method:'POST',headers:{'Authorization':'Bearer '+tok(),'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.ok?r.json():Promise.reject();})
    .then(function(d){ S.schedule={enabled:d.enabled,hour:d.hour,minute:d.minute};
      if(msg){msg.textContent='✓ Saved'+(d.enabled?' · daily '+('0'+d.hour).slice(-2)+':'+('0'+d.minute).slice(-2):' · disabled');msg.style.color='#4ade80';} })
    .catch(function(){ if(msg){msg.textContent='✕ Failed';msg.style.color='#f87171';} });
}

/* ── Export / print ── */
function exportReportJSON(){
  if(!S.report) return;
  try{
    var blob=new Blob([JSON.stringify(S.report,null,2)],{type:'application/json'});
    var url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download='nova-scan-'+((S.report.hostId||'host').replace(/[^\w.-]/g,'_'))+'-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')+'.json';
    document.body.appendChild(a); a.click();
    setTimeout(function(){URL.revokeObjectURL(url);a.remove();},150);
  }catch(e){}
}
function printReport(){
  if(!S.report) return;
  var r=S.report, w=window.open('','_nova_print','width=920,height=720'); if(!w) return;
  var rows=function(arr){return (arr||[]).length?(arr).map(function(f){return '<tr><td>'+esc(f.area||'')+'</td><td>'+esc(f.msg||'')+'</td></tr>';}).join(''):'<tr><td colspan=2>None</td></tr>';};
  var subs=Object.keys(r.subsystems||{}).map(function(k){var s=r.subsystems[k];return '<tr><td>'+esc(s.label)+'</td><td>'+s.score+'</td><td>'+esc(s.value||'')+'</td></tr>';}).join('');
  var recs=(r.recommendations||[]).map(function(x){return '<li><b>['+esc(x.priority)+']</b> '+esc(x.action)+(x.cmd?' — <code>'+esc(x.cmd)+'</code>':'')+'</li>';}).join('');
  var col=(r.overallScore>=80?'#16a34a':r.overallScore>=50?'#d97706':'#dc2626');
  w.document.write('<html><head><title>NOVA Scan Report</title><meta charset="utf-8"><style>'
    +'body{font-family:Arial,Helvetica,sans-serif;padding:32px;color:#111;max-width:900px;margin:auto}'
    +'h1{color:#0e7490;margin:0 0 4px}h2{margin:22px 0 6px;border-bottom:2px solid #e5e7eb;padding-bottom:4px;font-size:16px}'
    +'table{width:100%;border-collapse:collapse;margin:6px 0}td,th{border:1px solid #e5e7eb;padding:6px 10px;text-align:left;font-size:12px}'
    +'th{background:#f8fafc}.sc{font-size:46px;font-weight:800;color:'+col+'}code{background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:11px}'
    +'.meta{color:#555;font-size:13px}</style></head><body>'
    +'<h1>NOVA Scan Center — Investigation Report</h1>'
    +'<p class="meta"><b>Host:</b> '+esc(r.hostId||'')+' &nbsp;|&nbsp; <b>Mode:</b> '+esc(r.mode||'')+' &nbsp;|&nbsp; <b>Date:</b> '+new Date(r.ts||Date.now()).toLocaleString()+'</p>'
    +'<div class="sc">'+(r.overallScore!=null?r.overallScore:'—')+' / 100 &nbsp;<span style="font-size:18px">'+esc(r.health||'')+'</span></div>'
    +'<h2>Subsystem Health</h2><table><tr><th>Subsystem</th><th>Score</th><th>Detail</th></tr>'+subs+'</table>'
    +'<h2>AI Root Cause</h2><p>'+esc((r.rootCause||{}).summary||'No analysis')+'</p>'
    +'<h2>Critical Findings ('+(((r.findings||{}).critical)||[]).length+')</h2><table><tr><th>Area</th><th>Issue</th></tr>'+rows((r.findings||{}).critical)+'</table>'
    +'<h2>Warnings ('+(((r.findings||{}).warnings)||[]).length+')</h2><table><tr><th>Area</th><th>Issue</th></tr>'+rows((r.findings||{}).warnings)+'</table>'
    +'<h2>Recommendations</h2><ul>'+(recs||'<li>None</li>')+'</ul>'
    +'</body></html>');
  w.document.close();
  setTimeout(function(){try{w.focus();w.print();}catch(e){}},350);
}

/* ── Critical alert: sound + browser notification ── */
var _audioCtx=null;
function playAlert(){
  if(!S.soundOn) return;
  try{
    _audioCtx=_audioCtx||new (window.AudioContext||window.webkitAudioContext)();
    [880,660].forEach(function(f,i){
      var o=_audioCtx.createOscillator(), g=_audioCtx.createGain(), t=_audioCtx.currentTime+i*0.18;
      o.type='square'; o.frequency.value=f; o.connect(g); g.connect(_audioCtx.destination);
      g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.12,t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,t+0.16); o.start(t); o.stop(t+0.17);
    });
  }catch(e){}
}
function notify(title,body){
  try{
    if(!('Notification'in window)) return;
    if(Notification.permission==='granted') new Notification(title,{body:body});
    else if(Notification.permission!=='denied') Notification.requestPermission();
  }catch(e){}
}
function applyModeFilter(){
  var qq=(S.modeSearch||'').toLowerCase(), f=S.modeFilter;
  q('._mc',function(el){
    var cat=MODE_CAT[el.dataset.mode]||'';
    var catOk=(f==='all')||cat===f||cat==='All';
    var sOk=!qq||(el.textContent||'').toLowerCase().indexOf(qq)>=0;
    el.style.display=(catOk&&sOk)?'':'none';
  });
}
function selectMode(id){ if(S.status==='running')return; S.mode=id; renderSetup(); }
function bind(){
  // Infrastructure card clicks
    q('._svchip',function(el){el.onclick=function(){ if(S.status==='running')return; S.host=el.dataset.srv; renderSetup(); };});
  q('#_infra_portscan',function(el){el.onclick=function(){
    openPortScanner();
  };});  q('._mc',function(el){
    el.onclick=function(e){ if(e.target.closest('._mcchkbox'))return; selectMode(el.dataset.mode); };
    el.onkeydown=function(e){ if(e.key==='Enter'||e.key===' '){e.preventDefault();selectMode(el.dataset.mode);} };
  });
  q('._mcsel',function(el){el.onclick=function(e){
    e.stopPropagation(); S.selectedModes[el.dataset.mode]=el.checked; renderSetup();
  };});
  q('._catf',function(el){el.onclick=function(){
    S.modeFilter=(el.dataset.cat==='All'?'all':el.dataset.cat);
    q('._catf',function(c){var on=c.dataset.cat===el.dataset.cat;c.classList.toggle('on',on);c.setAttribute('aria-selected',on);});
    applyModeFilter();
  };});
  on('_modesearch','input',function(e){S.modeSearch=e.target.value||'';applyModeFilter();});
  var ss=document.getElementById('_schsave'); if(ss)ss.onclick=saveSchedule;
  var qs=document.getElementById('_quickscan'); if(qs)qs.onclick=function(){ if(S.status==='running')return; S.mode='deep'; renderSetup(); doScan(); };
  var rs=document.getElementById('_runsel'); if(rs)rs.onclick=function(){ runSelectedModes(); };
  var sp=document.getElementById('_nscstop'); if(sp)sp.onclick=stopScan;
  var g=document.getElementById('_nscgo'); if(g) g.onclick=doScan;
  var ag=document.getElementById('_nscagain'); if(ag) ag.onclick=resetScan;
  var pb=document.getElementById('_npb'); if(pb) pb.onclick=doPort;
  on('_npi','input',function(e){S.portTarget=e.target.value.trim();});
  on('_npm','change',function(e){S.portMode=e.target.value;});
  var hr=document.getElementById('_nhrefresh'); if(hr) hr.onclick=function(){S.history=null;loadHistory();};
  q('._histrow',function(el){el.onclick=function(e){ if(e.target.closest('._htchk'))return; loadHistoryReport(el.dataset.file);};});
  // Compare selection (max 2)
  q('._cmpchk',function(el){el.onclick=function(e){
    e.stopPropagation();
    S.cmpSel=S.cmpSel||{};
    if(el.checked){
      var sel=Object.keys(S.cmpSel).filter(function(k){return S.cmpSel[k];});
      if(sel.length>=2){ el.checked=false; return; } // limit 2
      S.cmpSel[el.dataset.file]=true;
    } else { delete S.cmpSel[el.dataset.file]; }
    var e2=document.getElementById('_nsc_hist'); if(e2){e2.innerHTML=vHistory();bind();}
  };});
  var hc=document.getElementById('_nhcompare'); if(hc) hc.onclick=doCompare;
  var cb=document.getElementById('_cmpback'); if(cb) cb.onclick=function(){S.cmpSel={};loadHistory();};
  q('._copybtn',function(el){el.onclick=function(){
    var t=el.getAttribute('data-cmd')||'';
    try{if(navigator.clipboard)navigator.clipboard.writeText(t);}catch(e){}
    el.classList.add('_ok');setTimeout(function(){el.classList.remove('_ok');},1200);
  };});
  // Findings filter chips + subsystem dropdown
  q('._ffchip',function(el){el.onclick=function(){S.findFilter=el.dataset.fsev;var rl=document.getElementById('_nsc_res');if(rl){rl.innerHTML=vResults();bind();}};});
  on('_ffarea','change',function(e){S.findArea=e.target.value;var rl=document.getElementById('_nsc_res');if(rl){rl.innerHTML=vResults();bind();}});
  // Export / print
  var ej=document.getElementById('_expjson'); if(ej)ej.onclick=exportReportJSON;
  var ep=document.getElementById('_expprint'); if(ep)ep.onclick=printReport;
  on('_termsearch','input',function(e){S.termQuery=(e.target.value||'').toLowerCase();applyTermFilter();});
  var tpz=document.getElementById('_termpause'); if(tpz)tpz.onclick=function(){
    S.termPaused=!S.termPaused;tpz.classList.toggle('on',S.termPaused);
    tpz.innerHTML=ico(S.termPaused?'clock':'pulse',11,'currentColor')+(S.termPaused?'Resume':'Pause');
    if(!S.termPaused){var t=document.getElementById('_nterm');if(t)t.scrollTop=t.scrollHeight;}
  };
  var tcl=document.getElementById('_termclear'); if(tcl)tcl.onclick=function(){
    S.logs=[];var t=document.getElementById('_nterm');if(t){var cur=t.querySelector('._cursor');t.innerHTML='';if(cur&&S.status==='running')t.appendChild(cur);}
  };
  // Fleet
  var fg=document.getElementById('_flgo'); if(fg)fg.onclick=doFleet;
  on('_flmode','change',function(e){S.fleetMode=e.target.value;});
  q('._flcard',function(el){el.onclick=function(){ if(el.dataset.state==='done')doFleetDrill(el.dataset.host); };});
  // Remediation (lazy-loads its gated status into the Results panel)
  var rmd=document.getElementById('_nremed'); if(rmd&&!rmd.dataset.loaded)loadRemediationStatus();
  q('._rembtn',function(el){el.onclick=function(){doRemediate(el.dataset.action,el.dataset.needs);};});
}
function applyTermFilter(){
  var t=document.getElementById('_nterm'); if(!t)return;
  var qq=S.termQuery||'';
  t.querySelectorAll('._tl').forEach(function(el){
    el.style.display=(!qq||(el.textContent||'').toLowerCase().indexOf(qq)>=0)?'':'none';
  });
}
function q(sel,fn){document.querySelectorAll(sel).forEach(fn);}
function on(id,ev,fn){var el=document.getElementById(id);if(el)el.addEventListener(ev,fn);}

/* ─── Scan ────────────────────────────────────────────────────── */
// Run all checkbox-selected modes sequentially (queue advanced in fullscan:complete)
function runSelectedModes(){
  if(S.status==='running')return;
  var ids=Object.keys(S.selectedModes).filter(function(k){return S.selectedModes[k];});
  if(!ids.length)return;
  S.scanQueue=ids.slice(1);          // remaining after the first
  S.mode=ids[0];
  addLog('[QUEUE] Batch run: '+ids.join(' → '));
  renderSetup(); doScan();
}

// Client-side stop: clears the batch queue + timers and ignores the in-flight result.
// (The full-system API has no server cancel; the remote task finishes harmlessly and is discarded.)
function stopScan(){
  S._scanLock=false; S.scanQueue=[]; S._cancelled=true;
  if(S.elapsedTimer){clearInterval(S.elapsedTimer);S.elapsedTimer=null;}
  if(S._hangTimer){clearTimeout(S._hangTimer);S._hangTimer=null;}
  S.status='idle'; S.progress=0;
  addLog('[STOPPED] Scan cancelled — any in-flight server task will finish in the background and be ignored');
  render(); setTab('setup');
}

function doScan(){
  if(S.status==='running'||S._scanLock||S.jobId)return;
  S._scanLock=true; S._cancelled=false; // fresh run
  hookSocket(); // Always ensure socket is hooked before starting
  STEP_META=STEP_META_DEFAULT.slice(); // reset; backend will send fullscan:init
  S.status='running';S.logs=[];S.steps=new Array(STEP_META.length).fill('pend');
  S.progress=0;S.report=null;S.jobId=null;S.scanStart=Date.now();
  if(S.elapsedTimer) clearInterval(S.elapsedTimer);
  if(S._hangTimer){clearTimeout(S._hangTimer);S._hangTimer=null;}
  S.elapsedTimer=setInterval(function(){
    var el=document.getElementById('_nsc_prog');
    if(el&&S.status==='running'){
      var pm=el.querySelectorAll('._progm');
      if(pm[1]) pm[1].querySelector('span').textContent=fmt(Date.now()-S.scanStart);
    }
  },1000);
  render(); setTab('progress');
  if(!S.socket){
    addLog('[WARN] WebSocket not ready — will retry hook on first event');
  }
  fetch('/api/scan/full-system',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok()},
    body:JSON.stringify({hostId:S.host,mode:S.mode})
  }).then(function(r){return r.json();}).then(function(d){
    S.jobId=d.jobId;
    addLog('[SCAN] Investigation started · Job: '+S.jobId+' · Target: '+S.host+' · Mode: '+S.mode.toUpperCase());
    hookSocket(); // second attempt after REST call confirms backend is up
    refreshProg();
    // Hang detection — alert if no progress after 30s
    S._hangTimer=setTimeout(function(){
      if(S.status==='running'&&S.progress===0){
        addLog('[TIMEOUT] No scan events received in 30s — attempting socket rehook...');
        _hooked=false; S.socket=null;
        hookSocket();
        if(!S.socket) addLog('[ERROR] WebSocket unavailable — check server at '+window.location.host);
      }
    },30000);
  }).catch(function(e){
    S.status='error';S.steps[0]='error';
    addLog('[ERROR] Failed to start scan: '+e.message);
    refreshProg();
  });
}

function resetScan(){
  if(S.elapsedTimer){clearInterval(S.elapsedTimer);S.elapsedTimer=null;}
  S.status='idle';S.report=null;S.logs=[];S.steps=[];S.progress=0;S.jobId=null;
  render();setTab('setup');
}

function addLog(msg){
  var now=new Date();
  var ts='['+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')+':'+String(now.getSeconds()).padStart(2,'0')+']';
  var fullMsg=ts+' '+msg;
  S.logs.push(fullMsg);
  if(S.logs.length>500) S.logs.splice(0,100);
  var t=document.getElementById('_nterm');
  if(t){
    var d=document.createElement('div');d.className='_tl _line';d.innerHTML=fmtLogLine(fullMsg);
    if(S.termQuery && fullMsg.toLowerCase().indexOf(S.termQuery)<0) d.style.display='none';
    // remove old cursor
    var cur=t.querySelector('._cursor');if(cur)cur.remove();
    t.appendChild(d);
    if(S.status==='running'){var cu=document.createElement('span');cu.className='_cursor';t.appendChild(cu);}
    if(!S.termPaused) t.scrollTop=t.scrollHeight;
  }
}

function refreshProg(){
  var el=document.getElementById('_nsc_prog');if(!el)return;
  var pf=document.getElementById('_npf');
  if(pf){pf.style.width=Math.round(S.progress)+'%';return;}
  el.innerHTML=vProgress();bind();
}

/* ─── Port scan ───────────────────────────────────────────────── */
function doPort(){startScanV2();}

function refreshPort(){
  var el=document.getElementById('_nsc_ports');if(!el)return;
  el.innerHTML=vPortV2();_psv2Bind();
  var pl=document.getElementById('_psv2Log');if(pl)pl.scrollTop=pl.scrollHeight;
}

/* ─── Socket ──────────────────────────────────────────────────── */

// Load socket.io client from server if not already available
function _ensureIO(cb){
  if(typeof window.io==='function'){cb();return;}
  if(_ioLoading){setTimeout(function(){_ensureIO(cb);},400);return;}
  _ioLoading=true;
  var s=document.createElement('script');
  s.src='/socket.io/socket.io.js';
  s.onload=function(){_ioLoading=false;cb();};
  s.onerror=function(){_ioLoading=false;cb();/* proceed anyway */};
  document.head.appendChild(s);
}

function _attachListeners(ns){
  // Remove ALL previous listeners first — prevents duplicate handlers on retry
  var EVTS=['hosts_update','connect','disconnect','fullscan:init','fullscan:progress','fullscan:step',
            'fullscan:log','fullscan:complete','fullscan:alert','portscan:log','portscan:port','portscan:progress','portscan:complete',
            'portscan:start','portscan:target-complete','portscan:error','portscan:cancelled'];
  EVTS.forEach(function(e){try{ns.off(e);}catch(ex){}});

  ns.on('hosts_update',function(d){if(d&&typeof d==='object')S.hosts=d;});
  ns.on('connect',function(){S.connected=true;updDot();addLog('[WS] Socket connected to server');});
  ns.on('disconnect',function(){
    S.connected=false;updDot();
    // Don't null S.socket — socket.io auto-reconnects; just clear hooked flag so listeners re-attach on reconnect
    _hooked=false;
  });
  ns.on('reconnect',function(){
    addLog('[WS] Socket reconnected — re-attaching listeners');
    _attachListeners(ns);
    _hooked=true;
  });

  // INIT: backend tells us which steps will run for this mode
  ns.on('fullscan:init',function(d){
    if(!d||!Array.isArray(d.steps))return;
    STEP_META=d.steps.map(function(s){return{id:s.id,n:s.name,i:STEP_ICONS[s.id]||'scan'};});
    S.steps=new Array(STEP_META.length).fill('pend');
    S.totalSteps=d.totalSteps||STEP_META.length;
    // re-render progress panel so step grid matches mode
    var pl=document.getElementById('_nsc_prog');if(pl){pl.innerHTML=vProgress();bind();}
  });

  // PROGRESS: explicit % from backend — never go backwards
  ns.on('fullscan:progress',function(d){
    if(!d||d.pct==null)return;
    if(S._hangTimer){clearTimeout(S._hangTimer);S._hangTimer=null;}
    S.progress=Math.max(S.progress,d.pct);
    _updateProgressDOM();
  });

  // STEP: update step status + recalculate progress
  ns.on('fullscan:step',function(d){
    if(!d||d.step==null)return;
    if(S._hangTimer){clearTimeout(S._hangTimer);S._hangTimer=null;}
    var tot=(S.totalSteps||STEP_META.length||10);
    if(d.step>=0&&d.step<tot) S.steps[d.step]=d.status;
    var done=S.steps.filter(function(x){return x==='done';}).length;
    var stepPct=Math.round((done/tot)*100);
    // Never regress progress — only advance
    S.progress=Math.max(S.progress,stepPct);
    _updateProgressDOM();
    _updateStepDOM();
  });

  ns.on('fullscan:log',function(d){if(d&&d.msg)addLog(d.msg);});

  ns.on('fullscan:complete',function(d){
    if(S.elapsedTimer){clearInterval(S.elapsedTimer);S.elapsedTimer=null;}
    if(S._hangTimer){clearTimeout(S._hangTimer);S._hangTimer=null;}
    if(S._cancelled){ S._cancelled=false; return; } // user stopped — discard this result
    S.status=(d&&d.report&&d.report.error)?'error':'complete';
    S.report=d&&d.report?d.report:null;
    S.progress=100;
    _updateProgressDOM();
    // Update results panel without touching progress/terminal panel
    var rl=document.getElementById('_nsc_res');if(rl){rl.innerHTML=vResults();bind();}
    // Update status badge in progress panel
    var sb=document.querySelector('._progmeta ._progm:last-child');
    if(sb){sb.style.color=S.status==='complete'?'#4ade80':'#ef4444';sb.textContent=S.status.toUpperCase();}
    var cur=document.querySelector('._cursor');if(cur)cur.remove();
    var _rp=S.report||{};var _cc=((_rp.findings||{}).critical||[]).length,_wc=((_rp.findings||{}).warnings||[]).length;
    // Store real score for the Health Score ring (idle '—' stays until a real scan lands)
    if(_rp.overallScore!=null){S.lastScore=_rp.overallScore;S.lastHealth=_rp.health||'';}
    // Critical alert — sound + browser notification
    if(_cc>0){ playAlert(); notify('NOVA: '+_cc+' critical finding'+(_cc>1?'s':''),(_rp.hostId||'host')+' scored '+(_rp.overallScore||'—')+'/100 ('+(_rp.health||'')+')'); }
    var _dur=S.scanStart>0?fmt(Date.now()-S.scanStart):'—';
    addLog('[DONE] Investigation complete in '+_dur+' · '+(_rp.overallScore||'—')+'/100 '+(_rp.health||'')+' · '+_cc+' critical · '+_wc+' warnings');
    S._scanLock=false;
    S.history=null; // invalidate cache so History tab reloads fresh
    // Advance batch queue (Run Selected) — start next mode after a short pause
    if(S.scanQueue&&S.scanQueue.length){
      var nx=S.scanQueue.shift();
      addLog('[QUEUE] Next batch mode: '+nx);
      setTimeout(function(){S.mode=nx;doScan();},1800);
    } else if(S.status==='complete'){
      setTimeout(function(){setTab('results');},1200);
    }
  });

  ns.on('fullscan:alert',function(d){
    if(!d)return;
    S.historyAlert={ts:new Date().toISOString(),score:d.score,prevScore:d.prevScore,health:d.health,reasons:d.reasons||[]};
    addLog('[ALERT] Health degraded · '+(d.reasons||[]).join(' · '));
    // surface a badge on the History tab button
    var ht=document.querySelector('._nt[data-tab="history"]');
    if(ht&&!ht.querySelector('._ndot'))ht.insertAdjacentHTML('beforeend','<span class="_ndot"></span>');
  });

  // ── Fleet scan events ──
  ns.on('fleetscan:init',function(d){
    if(!d)return;
    S.fleetId=d.fleetId; S.fleetStatus='running'; S.fleetSummary=null; S.fleetMode=d.mode||S.fleetMode;
    S.fleetHosts=(d.hosts||[]).map(function(h){return{hostId:h.hostId,name:h.name};});
    S.fleetResults={};
    (S.fleetHosts).forEach(function(h){S.fleetResults[h.hostId]={hostId:h.hostId,name:h.name,state:'pending',pct:0};});
    refreshFleet();
  });
  ns.on('fleetscan:host-start',function(d){
    if(!d)return; var r=S.fleetResults[d.hostId]||{hostId:d.hostId,name:d.name};
    r.state='running'; r.pct=0; S.fleetResults[d.hostId]=r; refreshFleet();
  });
  ns.on('fleetscan:host-progress',function(d){
    if(!d)return; var r=S.fleetResults[d.hostId]; if(!r)return;
    r.pct=Math.max(r.pct||0,d.pct||0);
    var bar=document.getElementById('_flp_'+cssId(d.hostId)); if(bar)bar.style.width=r.pct+'%';
  });
  ns.on('fleetscan:host-complete',function(d){
    if(!d)return;
    S.fleetResults[d.hostId]={hostId:d.hostId,name:d.name,state:'done',pct:100,
      score:d.score,health:d.health,critical:d.critical,warnings:d.warnings,worst:d.worst,error:d.error};
    refreshFleet();
  });
  ns.on('fleetscan:complete',function(d){
    S.fleetStatus='complete'; S.fleetSummary=d||null; refreshFleet();
  });

  ns.on('portscan:log',function(d){
    if(!d||!d.msg)return;
    S.portLogs.push(d.msg);
    var pl=document.getElementById('_psv2Log');
    if(pl&&!_psState.logPaused){
      var c=/error|fail|crit|panic/i.test(d.msg)?'color:#f87171':/warn|alert|HIGH/i.test(d.msg)?'color:#fb923c':/open|COMPLETE|done/i.test(d.msg)?'color:#4ade80':/\[PORT\]|\[INIT\]/i.test(d.msg)?'color:#22d3ee':'color:#a1a1aa';
      var div=document.createElement('div');div.style.cssText=c+';padding:1px 0';div.textContent=d.msg;
      pl.appendChild(div);pl.scrollTop=pl.scrollHeight;
    }
    if(INFRA.status==='running'){
      INFRA.logs.push(d.msg);
      _updatePSUI();
      var ip=document.getElementById('_iptlog');
      if(ip){var i2=document.createElement('div');
        var c2=/CRITICAL/i.test(d.msg)?'er':/HIGH/i.test(d.msg)?'wn':/open/i.test(d.msg)?'ok':'dim';
        i2.className='_tl '+c2;i2.textContent=d.msg;ip.appendChild(i2);ip.scrollTop=ip.scrollHeight;}
    }
  });
  ns.on('portscan:port',function(d){
    if(d){S.portResults.push(d);_psState.openCount=S.portResults.length;
      _psv2Refresh();
      if(INFRA.status==='running'){
        INFRA.results.push(d);
        _updatePSUI();
        var ig=document.getElementById('_iports');
        if(ig&&INFRA.results.length<=500){
          var rc2=d.risk==='CRITICAL'?'_cr':d.risk==='HIGH'?'_hi':d.risk==='MED'?'_me':'_lo';
          var rco2=d.risk==='CRITICAL'?'#ef4444':d.risk==='HIGH'?'#fb923c':d.risk==='MED'?'#eab308':'#4ade80';
          var h='<div class="_ps-card '+rc2+'"><div class="_ps-num" style="font:800 20px ui-monospace,monospace;color:#e4e4e7">'+d.port+'</div>'
            +'<div style="font-size:10px;color:#a1a1aa;font-weight:600;margin:3px 0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(d.service||'Unknown')+'</div>'
            +'<div style="display:flex;align-items:center;justify-content:center;gap:4px">'
            +'<span style="font:700 8px;padding:2px 6px;border-radius:4px;background:'+rco2+'22;color:'+rco2+'">'+esc(d.risk||'LOW')+'</span>'
            +(d.latency!=null?'<span style="font:500 9px ui-monospace;color:#52525b">'+d.latency+'ms</span>':'')
            +'</div></div>';
          ig.insertAdjacentHTML('beforeend',h);
          if(ig.scrollHeight-ig.scrollTop-ig.clientHeight<200) ig.scrollTop=ig.scrollHeight;
        }
        if(INFRA.results.length%50===0){
          var ib=document.getElementById('_infra_body');
          if(ib){renderInfra();}
        }
      }
    }
  });
  ns.on('portscan:progress',function(d){
    if(d&&d.pct!=null){
      S.portProgress=d.pct;
      if(d.scanned)_psState.scanned=d.scanned;
      if(d.total)_psState.total=d.total;
      var pf=document.getElementById('_psv2ProgFill');if(pf)pf.style.width=d.pct+'%';
      var pf2=document.getElementById('_npf2');if(pf2)pf2.style.width=d.pct+'%';
      if(INFRA.status==='running'){
        INFRA.progress=d.pct;
        var ipf=document.getElementById('_ipf2');if(ipf)ipf.style.width=d.pct+'%';
      }
    }
  });
  ns.on('portscan:complete',function(d){
    S.portStatus='complete';S.portProgress=100;
    S.portCompleteData=d||null;
    if(d&&d.openPorts)S.portResults=d.openPorts;
    if(d&&d.findings)S._portFindings=d.findings;
    if(_psv2.elapsedTimer){clearInterval(_psv2.elapsedTimer);_psv2.elapsedTimer=null;}
    refreshPort();
    if(INFRA.status==='running'){
      INFRA.status='complete';INFRA.progress=100;
      INFRA.completeData=d||null;
      if(d&&d.openPorts)INFRA.results=d.openPorts;
      _updatePSUI();
      renderInfra();
    }
  });

  ns.on('portscan:start',function(d){
    if(!d)return;
    S.portStatus='running';
    S.portLogs.push('[PORT] Scan started: '+JSON.stringify(d.target||S.portTarget));
    _psv2Refresh();
  });
  ns.on('portscan:target-complete',function(d){
    if(!d)return;
    S.portLogs.push('[PORT] Target complete: '+(d.target||'')+' ('+(d.openPorts||0)+' open)');
    _psv2Refresh();
  });
  ns.on('portscan:error',function(d){
    S.portStatus='error';
    S.portLogs.push('[ERROR] '+(d&&d.msg?d.msg:'Scan error occurred'));
    if(_psv2.elapsedTimer){clearInterval(_psv2.elapsedTimer);_psv2.elapsedTimer=null;}
    _psv2Refresh();
  });
  ns.on('portscan:cancelled',function(d){
    S.portStatus='idle';
    S.portLogs.push('[CANCELLED] Scan was cancelled');
    if(_psv2.elapsedTimer){clearInterval(_psv2.elapsedTimer);_psv2.elapsedTimer=null;}
    _psv2Refresh();
  });
}

// Fine-grained DOM update — never rebuilds terminal
function _updateProgressDOM(){
  var pf=document.getElementById('_npf');if(pf)pf.style.width=S.progress+'%';
  var pp=document.querySelector('._progpct');
  if(pp)pp.innerHTML=S.progress+'<span style="font-size:14px;color:#52525b">%</span>';
}

function _updateStepDOM(){
  var grid=document.querySelector('._stepgrid');if(!grid)return;
  var items=grid.querySelectorAll('._step');
  for(var i=0;i<items.length;i++){
    var st=S.steps[i]||'pend';
    items[i].className='_step'+(st==='done'?' done':st==='running'?' run':st==='error'?' err':'');
  }
}

function hookSocket(){
  if(_hooked&&S.socket&&(S.socket.connected||S.socket.id))return;
  _ensureIO(function(){
    try{
      var ns=null;

      // Method 1: piggyback on app's existing socket.io connection
      if(window.io&&window.io.managers){
        var mgr=window.io.managers;
        var mkeys=Object.keys(mgr);
        outer: for(var ki=0;ki<mkeys.length;ki++){
          var nsps=mgr[mkeys[ki]].nsps||{};
          var nkeys=Object.keys(nsps);
          for(var ni=0;ni<nkeys.length;ni++){
            var c=nsps[nkeys[ni]];
            if(c){ns=c;break outer;}
          }
        }
      }

      // Method 2: create dedicated overlay socket (reliable fallback)
      if(!ns){
        if(!_ownSocket){
          if(typeof window.io==='function'){
            _ownSocket=window.io(window.location.origin,{
              path:'/socket.io',
              transports:['websocket','polling'],
              reconnection:true,reconnectionDelay:2000,reconnectionAttempts:10
            });
            addLog('[WS] Created dedicated overlay socket');
          }
        }
        if(_ownSocket) ns=_ownSocket;
      }

      if(!ns){addLog('[WS] Socket unavailable — will retry');return;}

      _attachListeners(ns);
      S.socket=ns;_hooked=true;
      S.connected=!!(ns.connected||ns.id);updDot();
    }catch(e){addLog('[WS ERROR] '+e.message);}
  });
}

function updDot(){
  var d=document.getElementById('_nsdot');if(!d)return;
  d.className='_dot'+(S.connected?' on':' off');
  var sv=document.getElementById('_nsconnv');
  if(sv)sv.textContent=S.connected?'CONNECTED':'OFFLINE';
}

/* ─── Visibility / Layout ─────────────────────────────────────── */
function isScanOn(){
  // Check sidebar active nav items for scan section
  var navEls=document.querySelectorAll('nav button,aside button,[class*="sidebar"] button,[class*="nav"] li,[class*="menu"] li');
  for(var i=0;i<navEls.length;i++){
    var el=navEls[i];
    var tx=(el.textContent||'').trim();
    var isActive=el.classList.contains('active')||el.getAttribute('aria-selected')==='true'||el.getAttribute('aria-current')||el.classList.contains('selected');
    if(isActive&&/scan.?center|scan_hub/i.test(tx))return true;
    if(isActive&&tx==='Scan Center')return true;
  }
  // Scan-hub markers: require BOTH 'System Scan' AND 'Port Intelligence' present.
  // (Server / SSH list rows often have a per-row 'System Scan' button — matching on
  // either one wrongly activated the overlay on those pages and covered them. Both
  // labels only co-exist in the real Scan Center view.)
  var hasSys=false,hasPort=false;
  var bs=document.querySelectorAll('button');
  for(var i=0;i<bs.length;i++){
    var t=(bs[i].textContent||'').trim();
    if(t==='System Scan') hasSys=true;
    else if(t==='Port Intelligence') hasPort=true;
    if(hasSys&&hasPort) return true;
  }
  return false;
}

// Open the panel ONLY when the user clicks a scan entry button. Default state = main
// page only. Captured at document level so it works regardless of host markup.
document.addEventListener('click',function(e){
  try{
    var n=e.target; if(!n||!n.closest) return;
    if(n.closest('#_nsc')) return; // ignore clicks inside our own panel
    var el=n.closest('button,a,li,[role="button"]')||n;
    var tx=((el.textContent||'')).replace(/\s+/g,' ').trim();
    if(/\bscan center\b/i.test(tx)||/^scans?$/i.test(tx)||/^system scan$/i.test(tx)){
      S.opened=true; return; // open on scan entry click
    }
    // Clicking any OTHER navigation entry returns to the main page (closes the panel).
    var inNav=el.closest('nav,aside,[class*="sidebar"],[class*="nav"],[class*="menu"],[class*="rail"]');
    if(inNav && S.opened) S.opened=false;
  }catch(_){}
},true);

function hidePanel(root){
  root=root||document.getElementById('_nsc'); if(!root)return;
  _vis=false;
  root.classList.add('_closing');
  setTimeout(function(){ root.classList.remove('vis'); root.classList.remove('_closing'); },230);
}
setInterval(function(){
  var root=document.getElementById('_nsc');if(!root)return;
  var now=S.opened;                    // show ONLY when explicitly opened via a scan button
  if(now!==_vis){
    if(now){
      _vis=true; root.classList.remove('_closing'); root.classList.add('vis');
      hookSocket();
      render();
      relayoutSoon();
      setTab(S.status==='running'?'progress':S.status==='complete'?'results':'setup');
    } else {
      hidePanel(root); // animate out
    }
  }
  if(now&&(!_hooked||!S.socket)) hookSocket();
},600);

setInterval(function(){ if(_vis) layout(); },2000);

/* ─── Init ────────────────────────────────────────────────────── */
function init(){
  var style=document.createElement('style');style.textContent=CSS;document.head.appendChild(style);
  var root=document.createElement('div');root.id='_nsc';
  root.innerHTML=
    '<div class="_nh">'
    +'<div class="_nhl">'+ico('scan',18,'#22d3ee')
    +'<div><div class="_nht">NOVA SCAN CENTER</div>'
    +'<div class="_nhs">Advanced System Investigation Engine</div></div></div>'
    +'<div class="_nhr">'
    +'<button id="_nscsnd" class="_sndbtn" title="Toggle critical-alert sound" aria-label="Toggle alert sound">'+ico('pulse',13,'currentColor')+'</button>'
    +'<button id="_nschome" class="_xbtn" title="Close scan panel — back to main page" aria-label="Close">✕</button>'
    +'<div class="_nhstat">'+ico('pulse',12,'#3f3f46')
    +'<span id="_nsconnv" class="_nhstatv" style="color:#52525b">OFFLINE</span></div>'
    +'<div id="_nsdot" class="_dot off"></div>'
    +'</div></div>'

    +'<div class="_ntbar">'
    +'<button class="_nt on" data-tab="setup">'+ico('server',13)+'Setup</button>'
    +'<button class="_nt" data-tab="progress">'+ico('pulse',13)+'Live Scan</button>'
    +'<button class="_nt" data-tab="results">'+ico('forensic',13)+'Results</button>'
    +'<button class="_nt" data-tab="fleet">'+ico('server',13)+'Fleet</button>'
    +'<button class="_nt" data-tab="history">'+ico('pulse',13)+'History</button>'
    +'<button class="_nt" data-tab="ports">'+ico('port',13)+'Port Intel</button>'
    +'<button class="_nt" data-tab="infra">'+ico('server',13)+'Infrastructure</button>'
    +'</div>'

    +'<div class="_nb">'
    +'<div class="_nv on" data-view="setup"><div id="_nsc_setup"></div></div>'
    +'<div class="_nv" data-view="progress"><div id="_nsc_prog"></div></div>'
    +'<div class="_nv" data-view="results"><div id="_nsc_res"></div></div>'
    +'<div class="_nv" data-view="fleet"><div id="_nsc_fleet"></div></div>'
    +'<div class="_nv" data-view="history"><div id="_nsc_hist"></div></div>'
    +'<div class="_nv" data-view="ports"><div id="_nsc_ports"></div></div>'
    +'<div class="_nv" data-view="infra"><div id="_nsc_infra"></div></div>'
    +'</div>';

  document.body.appendChild(root);
  q('._nt',function(el){el.onclick=function(){setTab(el.dataset.tab);};});
  // Close button (X) — animate out, then hide; the main page + section bar stay in view.
  var hb=document.getElementById('_nschome');
  if(hb) hb.onclick=function(){ S.opened=false; hidePanel(root); };
  // Sound toggle for critical alerts
  var sb=document.getElementById('_nscsnd');
  if(sb){ sb.classList.toggle('off',!S.soundOn);
    sb.onclick=function(){ S.soundOn=!S.soundOn; sb.classList.toggle('off',!S.soundOn);
      sb.title=S.soundOn?'Alert sound: ON':'Alert sound: OFF'; if(S.soundOn) playAlert(); }; }
  relayoutSoon();                              // measure now + retry for late-mounting chrome
  window.addEventListener('resize',layout);    // keep aligned on viewport / sidebar changes
  // Load socket.io client eagerly so it's ready before scan starts
  _ensureIO(function(){hookSocket();});
}

if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}

/* fetch interceptor removed - doScan sends hostId directly */


/* ─── Dashboard Port Scanner Injection ── */
var _psInjectTimer=null,_psDashboardEl=null;
function _psInject(){
  // Check if Storage Grid / dashboard is visible
  var main=document.querySelector('main');
  if(!main) return;
  // Look for dashboard-specific elements: Storage Grid heading or dashboard container
  var dash=document.querySelector('[class*="DashboardView"],main>div>div>div>div>div');
  var hasStorage=/storage/i.test(document.body.innerText.slice(0,500));
  var isDash=document.querySelector('button[class*="active"]')&&/storage|dashboard/i.test(document.querySelector('header')?.innerText||'');
  if(!isDash&&!hasStorage){
    if(_psDashboardEl&&_psDashboardEl.parentNode){
      _psDashboardEl.style.display='none';
    }
    return;
  }
  // Already injected?
  if(document.getElementById('_psDashSection')){
    document.getElementById('_psDashSection').style.display='block';
    return;
  }
  // Find the dashboard main content area to inject below
  var container=main.querySelector('div[style*="flex"]')||main.firstElementChild;
  if(!container) return;
  var section=document.createElement('div');
  section.id='_psDashSection';
  section.style.cssText='margin:24px 0 0;padding:20px;background:linear-gradient(135deg,rgba(239,68,68,.05) 0%,rgba(127,29,29,.1) 100%);border:1px solid rgba(239,68,68,.2);border-radius:16px;font-family:"Inter",system-ui,sans-serif';
  section.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'
    +'<div style="display:flex;align-items:center;gap:10px">'
    +'<span style="font-size:20px">'+ico('port',20,'#ef4444')+'</span>'
    +'<div><h3 style="margin:0;font-size:14px;font-weight:700;color:#fca5a5;letter-spacing:.03em">Port Scanner</h3>'
    +'<p style="margin:2px 0 0;font-size:11px;color:#a1a1aa">Infrastructure port scanning & vulnerability detection</p></div></div>'
    +'<span id="_psStat" style="font-size:10px;font-weight:700;padding:3px 10px;border-radius:5px;color:#fca5a5;background:rgba(239,68,68,.1)">IDLE</span></div>'
    +'<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">'
    +'<input id="_psDaddr" placeholder="Enter IP or hostname" value="'+esc(_psState.target)+'"'
    +' style="flex:1;min-width:160px;padding:10px 14px;border-radius:8px;border:1px solid rgba(239,68,68,.2);background:rgba(0,0,0,.35);color:#e4e4e7;font-size:13px;outline:none">'
    +'<select id="_psDmode" style="padding:10px 12px;border-radius:8px;border:1px solid rgba(239,68,68,.2);background:rgba(0,0,0,.35);color:#e4e4e7;font-size:12px;font-weight:600;outline:none">'
    +'<option value="quick"'+(_psState.mode==='quick'?' selected':'')+'>Quick Scan</option>'
    +'<option value="deep"'+(_psState.mode==='deep'?' selected':'')+'>Deep Scan</option></select>'
    +'<button id="_psDgo" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .2s">'
    +ico('port',13,'#fff')+' Start Scan</button></div>'
    +'<div id="_psDbarWrap" style="display:'+(_psState.status==='running'?'block':'none')+';margin:8px 0">'
    +'<div style="background:rgba(0,0,0,.4);border-radius:6px;height:16px;overflow:hidden;border:1px solid rgba(239,68,68,.1)">'
    +'<div id="_psDbar" style="height:100%;border-radius:6px;background:linear-gradient(90deg,#dc2626,#ef4444);transition:width .3s ease;width:'+_psState.progress+'%"></div></div></div>'
    +'<div id="_psDgrid" style="display:flex;flex-wrap:wrap;gap:5px;margin:8px 0;max-height:280px;overflow-y:auto"></div>'
    +'<div id="_psDlog" style="background:#000;border:1px solid rgba(239,68,68,.1);border-radius:10px;padding:10px 12px;max-height:160px;overflow-y:auto;font:500 11px/1.5 ui-monospace,monospace;margin-top:8px;color:#a1a1aa"></div>'
    +'</div>';
  // Append after container
  container.parentNode.insertBefore(section, container.nextSibling);
  _psBindDash();
}
function _psBindDash(){
  var go=document.getElementById('_psDgo');
  if(go)go.onclick=function(){_psDashScan();}
  var addr=document.getElementById('_psDaddr');
  if(addr)addr.oninput=function(){_psState.target=this.value.trim();}
  var mode=document.getElementById('_psDmode');
  if(mode)mode.onchange=function(){_psState.mode=this.value;}
}
function _psDashScan(){
  if(_psState.status==='running') return;
  var a=document.getElementById('_psDaddr');
  var m=document.getElementById('_psDmode');
  _psState.target=(a&&a.value.trim())||'';
  _psState.mode=(m&&m.value)||'quick';
  if(!_psState.target) return;
  _psState.status='running';_psState.results=[];_psState.progress=0;_psState.logs=[];_psState.completeData=null;
  _psDashUpdateUI();
  var sid=Date.now().toString(36);
  if(!S.socket) hookSocket();
  if(S.socket) S.socket.emit('portscan:start',{scanId:sid,target:_psState.target,mode:_psState.mode,options:{timeout:2000,threads:120}});
  _psState.logs.push('[PORT] Scanning '+_psState.target+' ['+_psState.mode.toUpperCase()+']');
  _psDashUpdateUI();
}
function _psDashUpdateUI(){
  var stat=document.getElementById('_psStat');
  if(stat) stat.textContent=_psState.status==='running'?'SCANNING...':_psState.status==='complete'?'COMPLETE':'IDLE';
  var barWrap=document.getElementById('_psDbarWrap');
  if(barWrap) barWrap.style.display=_psState.status==='running'?'block':'none';
  var bar=document.getElementById('_psDbar');
  if(bar) bar.style.width=_psState.progress+'%';
  var grid=document.getElementById('_psDgrid');
  if(grid){
    grid.innerHTML=_psState.results.slice(0,500).map(function(d){
      var rc=d.risk==='CRITICAL'?'_cr':d.risk==='HIGH'?'_hi':d.risk==='MED'?'_me':'_lo';
      var rco=d.risk==='CRITICAL'?'#ef4444':d.risk==='HIGH'?'#fb923c':d.risk==='MED'?'#eab308':'#4ade80';
      return '<div class="_ps-card '+rc+'" style="min-width:80px"><div class="_ps-num" style="font:800 16px ui-monospace,monospace;color:#e4e4e7">'+d.port+'</div>'
        +'<div style="font-size:8px;color:#a1a1aa;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(d.service||'Unknown')+'</div>'
        +'<div style="display:flex;align-items:center;justify-content:center;gap:3px;margin-top:2px">'
        +'<span style="font:700 7px;padding:1px 5px;border-radius:3px;background:'+rco+'22;color:'+rco+'">'+esc(d.risk||'LOW')+'</span></div></div>';
    }).join('');
  }
  var log=document.getElementById('_psDlog');
  if(log){
    log.innerHTML=_psState.logs.map(function(m){return '<div class="_tl '+logClass(m)+'">'+esc(m)+'</div>';}).join('');
    log.scrollTop=log.scrollHeight;
  }
}
// Override _updatePSUI to also update dashboard injection
var _origUpdatePSUI=_updatePSUI;
_updatePSUI=function(){_origUpdatePSUI();_psDashUpdateUI();};

// Periodic check to inject into dashboard view
setInterval(function(){
  try{
    // Detect if Storage Grid / dashboard is the active view
    var activeBtn=document.querySelector('nav button[class*="active"],aside button[class*="active"]');
    var isDashboard=activeBtn&&(/storage/i.test(activeBtn.textContent)||/dashboard/i.test(activeBtn.textContent));
    if(isDashboard||document.querySelector('[class*="DashboardView"]')){
      _psInject();
    }else{
      var el=document.getElementById('_psDashSection');
      if(el) el.style.display='none';
    }
  }catch(_){}
},2000);



/* ─── Port Scanner Sidebar View Injection ── */
var _psNavTimer=null, _psFilter='all', _psScanning=false;
function _renderPortScannerView(){
  var container=document.getElementById('_psViewContainer');
  if(!container) return;
  var root=document.getElementById('__psSidebarRoot');
  if(root){ root.style.display='flex'; return; }
  root=document.createElement('div');
  root.id='__psSidebarRoot';
  root.style.cssText='flex:1;display:flex;flex-direction:column;background:#000;position:relative;overflow:hidden;padding:16px 20px';
  root.innerHTML='<div id="_psv2Container"></div>';
  container.appendChild(root);
  _psv2RenderSidebar();
}
function _psv2RenderSidebar(){
  var el=document.getElementById('_psv2Container');
  if(!el) return;
  el.innerHTML=vPortV2();
  _psv2Bind();
}
function _psv2Bind(){
  var sb=document.getElementById('_psv2ScanBtn');
  if(sb)sb.onclick=startScanV2;
  var ti=document.getElementById('_psv2Target');
  if(ti)ti.oninput=function(){S.portTarget=this.value.trim();};
  var pi=document.getElementById('_psv2Ports');
  if(pi)pi.oninput=function(){_psState.customPorts=this.value.trim();};
  var mi=document.getElementById('_psv2Mode');
  if(mi)mi.onchange=function(){S.portMode=this.value;};
  var at=document.getElementById('_psv2AdvToggle');
  if(at)at.onclick=function(){var p=document.getElementById('_psv2AdvPanel');if(p)p.style.display=p.style.display==='none'?'block':'none';};
  var th=document.getElementById('_psv2Threads');
  if(th)th.oninput=function(){var v=document.getElementById('_psv2ThreadsV');if(v)v.textContent=this.value;};
  var to=document.getElementById('_psv2Timeout');
  if(to)to.oninput=function(){var v=document.getElementById('_psv2TimeoutV');if(v)v.textContent=this.value+'ms';};
  var tp=document.getElementById('_psv2TermPause');
  if(tp)tp.onclick=function(){_psState.logPaused=!_psState.logPaused;tp.classList.toggle('active',_psState.logPaused);tp.textContent=_psState.logPaused?'Resume':'Pause';};
  var tc=document.getElementById('_psv2TermClear');
  if(tc)tc.onclick=function(){S.portLogs=[];var l=document.getElementById('_psv2Log');if(l)l.innerHTML='';};
  var ej=document.getElementById('_psv2ExportJSON');
  if(ej)ej.onclick=exportJSON;
  var ec=document.getElementById('_psv2ExportCSV');
  if(ec)ec.onclick=exportCSV;
  var em=document.getElementById('_psv2ExportMD');
  if(em)em.onclick=exportMarkdown;
  document.querySelectorAll('[data-psv2tab]').forEach(function(el){
    el.onclick=function(){_psv2.activeTab=this.dataset.psv2tab;
      var tc2=document.getElementById('_psv2TabContent');
      if(tc2)tc2.innerHTML=_psv2RenderTab();
      document.querySelectorAll('[data-psv2tab]').forEach(function(b){b.classList.toggle('active',b.dataset.psv2tab===_psv2.activeTab);});
    };
  });
  document.querySelectorAll('[data-sort]').forEach(function(el){
    el.onclick=function(){
      var col=el.dataset.sort;
      if(_psv2.sortCol===col)_psv2.sortDir=_psv2.sortDir==='asc'?'desc':'asc';
      else{_psv2.sortCol=col;_psv2.sortDir='asc';}
      _psv2RenderSidebar();
    };
  });
  var si=document.getElementById('_psv2SearchInput');
  if(si)si.oninput=function(){_psv2.searchQuery=this.value;
    var tc2=document.getElementById('_psv2TabContent');
    if(tc2)tc2.innerHTML=_psv2RenderTab();
  };
}
function _psSyncSidebar(){
  _psv2RenderSidebar();
}
function _psUpdateDash(){
  _psv2RenderSidebar();
}
function _psRenderGrid(){
  _psv2RenderSidebar();
}
function _psRenderLog(){
  _psv2RenderSidebar();
}
function _psExportJSON(){exportJSON();}
function _psClearAll(){
  S.portResults=[];S.portProgress=0;S.portLogs=[];S.portCompleteData=null;S.portStatus='idle';
  _psState.results=[];_psState.scanned=0;_psState.total=0;_psState.openCount=0;
  _psScanning=false;
  _psv2RenderSidebar();
}
var _origPSUI=_updatePSUI;
_updatePSUI=function(){_origPSUI(); _psSyncSidebar(); _psHandlePhase();};
function _psHandlePhase(){
  if(!S.socket) return;
  if(!S.socket._phaseHandlerAdded){
    S.socket.on('portscan:phase', function(data){
      _psUpdatePhaseUI(data);
    });
    S.socket._phaseHandlerAdded=true;
  }
}
function _psUpdatePhaseUI(data){
  var phaseDiv=document.getElementById('_psPhaseSteps');
  if(!phaseDiv) return;
  var phases=['discovery','port_sweep','service_detection','ssl_inspection','vuln_analysis'];
  var labels={'discovery':'Host Discovery','port_sweep':'Port Sweep','service_detection':'Service Detection','ssl_inspection':'SSL/TLS Inspection','vuln_analysis':'Vuln Analysis'};
  phaseDiv.innerHTML=phases.map(function(p){
    var st='', icon='';
    if(p===data.phase){
      if(data.status==='running'){st='running';icon='⟳';}
      else if(data.status==='complete'){st='done';icon='✓';}
      else{st='error';icon='✗';}
    }else if(phases.indexOf(p)<phases.indexOf(data.phase)){
      st='done';icon='✓';
    }else{
      st='pending';icon='○';
    }
    return '<div class="_psPhaseStep '+st+'"><span class="_psPhaseIcon">'+icon+'</span><span class="_psPhaseLabel">'+labels[p]+'</span><span class="_psPhaseProg">'+(data.phase===p&&data.progress?data.progress+'%':'')+'</span></div>';
  }).join('');
}

setInterval(function(){
  try{
    var c=document.getElementById('_psViewContainer');
    if(c&&!document.getElementById('__psSidebarRoot')){_renderPortScannerView();}
    else if(!c){var r=document.getElementById('__psSidebarRoot');if(r)r.style.display='none';}
  }catch(_){}
},1200);
})();
