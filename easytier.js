(function(){
'use strict';

// ===================== 配置 =====================
const SIGNAL_SERVERS = [
  {host:'peerjs.92k.de', port:443, secure:true, path:'/'},
  {host:'0.peerjs.com', port:443, secure:true, path:'/'}
];
const ICE = [
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun.miwifi.com:3478'},
  {urls:'stun:global.stun.twilio.com:3478'}
];
const HUB_ID = 'p1-hub-v5'; // 升级协议版本
const CHUNK_SIZE = 64 * 1024;

// ===================== 核心逻辑 =====================
const app = {
  localId: localStorage.getItem('p1_id') || '',
  myName: localStorage.getItem('nickname') || ('User-'+Math.random().toString(36).substr(2,4)),
  
  peer: null,
  conns: {}, 
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{}'),
  
  // 优化：使用 Set + 自动清理机制
  seenIds: new Set(),
  
  serverIdx: 0,
  isHub: false,
  restarting: false,
  
  onUpdate: null, 
  onMsgAdded: null,

  log(s) {
    // 生产环境关闭详细日志，防卡顿
    // console.log(s); 
    const el = document.getElementById('miniLog');
    if(el) {
      if(el.childElementCount > 50) el.removeChild(el.lastChild);
      const d = document.createElement('div');
      d.innerText = s;
      el.prepend(d);
    }
  },

  init() {
    this.start();
    setInterval(() => this.watchdog(), 5000);
    // 内存保护：每分钟清理一次旧指纹
    setInterval(() => { 
      if(this.seenIds.size > 2000) {
        const arr = Array.from(this.seenIds);
        this.seenIds = new Set(arr.slice(arr.length - 1000)); // 保留最近1000条
      }
    }, 60000);
    
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible' && (!this.peer || this.peer.disconnected)) {
        this.start();
      }
    });
  },

  start(forceHub = false) {
    if(this.restarting) return;
    this.restarting = true;
    if(this.peer) { try{this.peer.destroy();}catch(e){} this.peer=null; }
    
    const srv = SIGNAL_SERVERS[this.serverIdx];
    this.log(`连接 ${srv.host}...`);

    let myId = forceHub ? HUB_ID : (this.localId || undefined);
    if(!forceHub && this.localId === HUB_ID) myId = HUB_ID;

    try {
      const p = new Peer(myId, {
        host: srv.host, port: srv.port, secure: srv.secure, path: srv.path,
        config: { iceServers: ICE }, debug: 0,
        pingInterval: 5000
      });

      p.on('open', id => {
        this.restarting = false;
        this.localId = id;
        this.isHub = (id === HUB_ID);
        if(!this.isHub) localStorage.setItem('p1_id', id);
        
        this.log(`✅ ${this.isHub?'👑':'👤'} ${id.slice(0,6)}`);
        this.requestWakeLock();
        this.notifyUI();

        if(!this.isHub) {
          this.dial(HUB_ID);
          this.reconnectKnown();
        }
      });

      p.on('connection', conn => this.handleIncoming(conn));
      
      p.on('error', err => {
        this.restarting = false;
        if(err.type === 'unavailable-id') {
          if(myId === HUB_ID) {
            this.localId = ''; localStorage.removeItem('p1_id');
            setTimeout(() => this.start(false), 500);
          }
        } 
        else if(err.type === 'peer-unavailable') {
          if(err.message.includes(HUB_ID)) this.start(true);
        }
        else if(['network','server-error','socket-error'].includes(err.type)) {
          this.serverIdx = (this.serverIdx + 1) % SIGNAL_SERVERS.length;
          setTimeout(() => this.start(), 2000);
        }
      });

      p.on('disconnected', () => { if(!this.restarting) p.reconnect(); });
      this.peer = p;

    } catch(e) {
      this.restarting = false;
      setTimeout(() => this.start(), 3000);
    }
  },

  dial(pid) {
    if(pid === this.localId || (this.conns[pid] && this.conns[pid].state === 'connected')) return;
    if(!this.peer || this.peer.destroyed) return;
    const conn = this.peer.connect(pid, {reliable: true, serialization: 'json'});
    this.setupConn(conn, false);
  },

  handleIncoming(conn) { this.setupConn(conn, true); },

  setupConn(conn, isIncoming) {
    const pid = conn.peer;
    const c = { conn, state: 'connecting', lastPing: Date.now(), name: pid.slice(0,6) };
    this.conns[pid] = c;

    conn.on('open', () => {
      conn.send({t: 'HELLO', name: this.myName});
      if(this.isHub) {
        const list = Object.keys(this.conns).filter(id => id!==pid && this.conns[id].state==='connected');
        if(list.length) conn.send({t: 'PEERS', list});
      }
    });

    conn.on('data', d => {
      c.lastPing = Date.now();
      
      if(d.t === 'HELLO') {
        c.name = d.name;
        c.state = 'connected';
        this.remember(pid);
        this.notifyUI();
        conn.send({t: 'HELLO_ACK'});
      }
      else if(d.t === 'HELLO_ACK') {
        c.state = 'connected';
        this.notifyUI();
      }
      else if(d.t === 'PEERS') {
        d.list.forEach(id => this.dial(id));
      }
      else if(d.t === 'MSG') {
        if(this.seenIds.has(d.id)) return;
        this.seenIds.add(d.id);
        
        this.saveMsg(d.target, d.text, false, d.name, d.isHtml);
        
        // 转发 (TTL - 1)
        if(d.target === 'all' && (d.ttl || 10) > 0) {
          d.ttl = (d.ttl || 10) - 1;
          this.flood(d, pid);
        }
      }
      else if(d.t === 'FILE_START') {
        // 文件传输逻辑
        if(this.onMsgAdded) this.onMsgAdded(pid, {txt: `正在接收 ${d.name}...`, me: false, name: '系统', time: Date.now()});
        c.fileBuffer = [];
        c.fileMeta = d;
      }
      else if(d.t === 'FILE_CHUNK') {
        if(c.fileMeta && c.fileBuffer) {
          c.fileBuffer.push(d.data); // ArrayBuffer
          if(d.done) {
             const blob = new Blob(c.fileBuffer, {type: c.fileMeta.type});
             const url = URL.createObjectURL(blob);
             const link = `<a href="${url}" download="${c.fileMeta.name}" style="color:#4ade80">📄 ${c.fileMeta.name}</a>`;
             this.saveMsg(pid, link, false, c.name, true);
             c.fileBuffer = null;
             c.fileMeta = null;
          }
        }
      }
    });

    conn.on('close', () => { this.closeConn(pid); });
    conn.on('error', () => { this.closeConn(pid); });
  },

  closeConn(pid) {
    if(this.conns[pid]) { delete this.conns[pid]; this.notifyUI(); }
  },

  flood(msgPacket, excludePid) {
    Object.entries(this.conns).forEach(([pid, c]) => {
      if(c.state === 'connected' && pid !== excludePid) {
        try { c.conn.send(msgPacket); } catch(e){}
      }
    });
  },

  watchdog() {
    const now = Date.now();
    if(this.peer && this.peer.disconnected && !this.restarting) this.peer.reconnect();
    
    Object.keys(this.conns).forEach(pid => {
      const c = this.conns[pid];
      if(now - c.lastPing > 15000) {
        if(c.state === 'connected') try { c.conn.send({t: 'PING'}); } catch(e) { this.closeConn(pid); }
        else if (now - c.lastPing > 30000) this.closeConn(pid);
      }
    });

    if(!this.isHub && !this.conns[HUB_ID] && !this.restarting) this.dial(HUB_ID);
  },

  send(text, targetId) {
    const msgId = Date.now() + Math.random().toString(36).substr(2,5);
    const msg = {t: 'MSG', text, name: this.myName, id: msgId, target: targetId, ttl: 10};
    this.seenIds.add(msgId);
    
    this.saveMsg(targetId, text, true, '我', false);

    if(targetId === 'all') {
      this.flood(msg, null);
    } else {
      const c = this.conns[targetId];
      if(c && c.state === 'connected') c.conn.send(msg);
      else {
        this.saveMsg(targetId, '[发送失败: 未连接]', true, '系统', false);
        this.dial(targetId);
      }
    }
  },

  sendFile(file, targetId) {
    if(targetId === 'all') { alert('暂不支持群发文件'); return; }
    const c = this.conns[targetId];
    if(!c || c.state !== 'connected') { alert('未连接'); return; }
    
    c.conn.send({t: 'FILE_START', name: file.name, type: file.type, size: file.size});
    
    const reader = new FileReader();
    let offset = 0;
    reader.onload = e => {
      const chunk = e.target.result;
      offset += chunk.byteLength;
      const done = offset >= file.size;
      c.conn.send({t: 'FILE_CHUNK', data: chunk, done}); // ArrayBuffer 自动传输
      if(!done) readNext();
      else this.saveMsg(targetId, `文件 ${file.name} 已发送`, true, '系统', false);
    };
    const readNext = () => {
      reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
    };
    readNext();
  },

  saveMsg(pid, text, isMe, senderName, isHtml) {
    const key = (pid === 'all' || pid === undefined) ? 'all' : pid;
    
    if(!this.msgs[key]) this.msgs[key] = [];
    const msgObj = { txt: text, me: isMe, name: senderName, time: Date.now(), html: isHtml };
    this.msgs[key].push(msgObj);
    
    if(this.msgs[key].length > 50) this.msgs[key].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
    
    if(this.onMsgAdded) this.onMsgAdded(key, msgObj);
  },

  remember(pid) {
    if(pid === HUB_ID) return;
    let list = JSON.parse(localStorage.getItem('p1_peers')||'[]');
    if(!list.includes(pid)) {
      list.push(pid);
      if(list.length > 10) list.shift();
      localStorage.setItem('p1_peers', JSON.stringify(list));
    }
  },
  
  reconnectKnown() {
    JSON.parse(localStorage.getItem('p1_peers')||'[]').forEach(pid => this.dial(pid));
  },

  requestWakeLock() {
    if('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(()=>{});
  },

  notifyUI() {
    if(this.onUpdate) this.onUpdate();
  }
};

// ===================== UI =====================
const ui = {
  active: 'all',
  
  init() {
    app.onUpdate = () => this.renderStatus();
    
    app.onMsgAdded = (chatId, msg) => {
      if(chatId === this.active) {
        this.appendMsg(msg);
      }
    };
    
    const $ = s => document.querySelector(s);
    
    $('#btnSend').onclick = () => {
      const txt = $('#editor').innerText.trim();
      if(txt) { app.send(txt, this.active); $('#editor').innerText=''; }
    };
    
    // 文件按钮
    $('#btnFile').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => {
      if(e.target.files[0]) app.sendFile(e.target.files[0], this.active);
    };
    
    this.renderStatus();
    this.switch('all');
  },

  renderStatus() {
    const $ = s => document.querySelector(s);
    $('#myId').innerText = app.localId ? app.localId.slice(0,6) : '...';
    $('#statusText').innerText = app.peer && !app.peer.disconnected ? '在线' : '连接中';
    $('#statusDot').className = 'dot ' + (app.peer && !app.peer.disconnected ? 'online' : '');
    $('#onlineCount').innerText = Object.keys(app.conns).filter(k=>app.conns[k].state==='connected').length + ' 邻居';
    
    const list = $('#contactList');
    let html = `
      <div class="contact-item ${this.active==='all'?'active':''}" onclick="ui.switch('all')">
        <div class="avatar" style="background:#2a7cff">全</div>
        <div class="c-info"><div class="c-name">公共频道</div></div>
      </div>
    `;
    
    let allPeers = new Set([...Object.keys(app.conns), ...Object.keys(app.msgs)]);
    allPeers.forEach(pid => {
      if(pid === 'all' || pid === app.localId) return;
      const c = app.conns[pid];
      const isOnline = c && c.state === 'connected';
      const name = c ? c.name : (pid===HUB_ID?'👑 接待员':pid.slice(0,6));
      
      html += `
        <div class="contact-item ${this.active===pid?'active':''}" onclick="ui.switch('${pid}')">
          <div class="avatar" style="background:${isOnline?'#22c55e':'#666'}">${name[0]}</div>
          <div class="c-info">
            <div class="c-top">
              <div class="c-name">${name}</div>
              <div class="c-time">${isOnline?'在线':'离线'}</div>
            </div>
          </div>
        </div>
      `;
    });
    list.innerHTML = html;
  },

  switch(pid) {
    this.active = pid;
    const msgBox = document.querySelector('#msgList');
    msgBox.innerHTML = ''; 
    
    const msgs = app.msgs[pid] || [];
    msgs.forEach(m => this.appendMsg(m));
    
    document.querySelector('#chatTitle').innerText = pid==='all' ? '公共频道' : pid.slice(0,6);
    this.renderStatus();
    
    if(window.innerWidth < 768) document.querySelector('#sidebar').classList.add('hidden');
  },

  appendMsg(m) {
    const msgBox = document.querySelector('#msgList');
    const div = document.createElement('div');
    div.className = `msg-row ${m.me?'me':'other'}`;
    
    const content = m.html ? m.txt : m.txt.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    
    div.innerHTML = `
      <div style="max-width:100%">
        <div class="msg-bubble">${content}</div>
        ${!m.me ? `<div class="msg-meta">${m.name}</div>` : ''}
      </div>`;
    msgBox.appendChild(div);
    msgBox.scrollTop = msgBox.scrollHeight;
  }
};

window.app = app;
window.ui = ui;
app.init();
ui.init();

})();