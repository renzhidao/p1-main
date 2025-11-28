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
const MAX_PEERS = 15;
const CHUNK_SIZE = 64 * 1024; 

// 🔥 固定种子 ID (接待员 ID)
const PUBLIC_HUB_ID = 'p1-hub-v2'; 

// ===================== 核心逻辑 (Mesh Core) =====================
const app = {
  localId: localStorage.getItem('p1_id') || '',
  myName: localStorage.getItem('nickname') || ('User-'+Math.random().toString(36).substr(2,4)),
  conns: {}, 
  peer: null,
  serverIdx: 0,
  knownPeers: new Set(JSON.parse(localStorage.getItem('p1_peers')||'[]')),
  isHub: false, // 标记自己是否成为了接待员
  
  seenMsgIds: new Set(),
  fileChunks: {},
  
  // UI 接口
  onStatus: null, 
  onMsg: null,
  onContactUpdate: null,
  onFileProgress: null,

  log(s) {
    console.log('[Mesh]', s);
    const el = document.getElementById('miniLog');
    if(el) { el.innerText += s+'\n'; el.scrollTop=el.scrollHeight; }
  },

  init() {
    // 启动时，先尝试作为普通人连接
    this.connect();
    
    setInterval(() => this.keepAlive(), 5000);
    setInterval(() => { if(this.seenMsgIds.size > 5000) this.seenMsgIds.clear(); }, 60000);
    
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState==='visible' && !this.peer) this.connect();
    });
  },

  connect(forceId = null) {
    if(this.peer) return;
    const srv = SIGNAL_SERVERS[this.serverIdx];
    this.log(`启动连接 ${srv.host}...`);
    
    try {
      const opts = { 
        host: srv.host, port: srv.port, secure: srv.secure, path: srv.path,
        config: { iceServers: ICE }, debug: 1
      };
      
      // 如果指定了 forceId (通常是想成为 Hub)，则使用它
      // 否则优先使用本地存储 ID，没有则随机
      let idToUse = forceId || this.localId || undefined;
      
      // ⚠️ 特殊逻辑：如果我是为了抢占 Hub 而重启，ID 必须是 Hub ID
      if(forceId === PUBLIC_HUB_ID) idToUse = PUBLIC_HUB_ID;

      this.peer = new Peer(idToUse, opts);
    } catch(e) { this.nextServer(); return; }

    this.peer.on('open', id => {
      this.localId = id;
      // 只有非 Hub 的普通 ID 才保存，避免下次我也默认成了 Hub
      if(id !== PUBLIC_HUB_ID) localStorage.setItem('p1_id', id);
      
      this.isHub = (id === PUBLIC_HUB_ID);
      this.log(`✅ 身份: ${this.isHub ? '👑 接待员 (Hub)' : '👤 普通节点'} (${id})`);
      
      this.updateStatus();
      this.requestWakeLock();
      
      if (this.isHub) {
        // 我是接待员：等待别人连我，不用主动干啥
        this.log('正在等待其他节点接入...');
      } else {
        // 我是普通人：必须立刻去找接待员
        this.log('正在寻找接待员...');
        this.dial(PUBLIC_HUB_ID); // 👈 关键：呼叫固定接待员
        
        // 同时也呼叫历史好友
        this.knownPeers.forEach(pid => {
          if(pid !== PUBLIC_HUB_ID) this.dial(pid);
        });
      }
    });

    this.peer.on('connection', conn => this.setupConn(conn, true));
    
    this.peer.on('error', err => {
      // this.log(`⚠️ ${err.type}`);
      
      if(['network','server-error'].includes(err.type)) {
        this.nextServer();
      }
      else if(err.type === 'unavailable-id') {
        // ID 被占用
        if (this.localId === PUBLIC_HUB_ID) {
           this.log('👑 接待员已存在，退化为普通节点...');
           // Hub 被人占了，那我做普通人，重新生成随机 ID
           this.localId = ''; 
           localStorage.removeItem('p1_id');
           if(this.peer) this.peer.destroy();
           this.peer = null;
           setTimeout(() => this.connect(), 500);
        } else {
           // 普通 ID 被占，重置
           localStorage.removeItem('p1_id'); 
           this.localId=''; 
           this.connect(); 
        }
      }
      else if(err.type === 'peer-unavailable') {
        // ⚠️ 关键逻辑：找不到连接对象
        // 如果我试图连接 PUBLIC_HUB_ID 失败了，说明没人当接待员
        // 那我就去当接待员！
        const target = err.message.split(' ').pop(); // 尝试解析 ID
        if (target.includes(PUBLIC_HUB_ID) || this.conns[PUBLIC_HUB_ID]?.open === false) {
           this.log('🚨 没找到接待员，正在尝试上位...');
           this.becomeHub();
        }
      }
    });
    
    this.peer.on('disconnected', () => { this.peer.reconnect(); });
    this.peer.on('close', () => { this.peer = null; this.updateStatus(); });
  },

  // 👑 篡位逻辑：销毁当前连接，以 Hub ID 重生
  becomeHub() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    setTimeout(() => {
      this.connect(PUBLIC_HUB_ID);
    }, 1000);
  },

  nextServer() {
    if(this.peer) { this.peer.destroy(); this.peer = null; }
    this.serverIdx = (this.serverIdx + 1) % SIGNAL_SERVERS.length;
    setTimeout(() => this.connect(), 1000);
  },

  dial(pid) {
    if(pid === this.localId || (this.conns[pid] && this.conns[pid].open)) return;
    if(Object.keys(this.conns).length >= MAX_PEERS) return;
    if(!this.peer) return;
    
    // 只有连接 Hub 时才设置 reliable: true，其他普通节点随意
    const conn = this.peer.connect(pid, {reliable: true});
    this.setupConn(conn, false);
    
    // 监控连接失败（为了触发 peer-unavailable）
    setTimeout(() => {
      if (pid === PUBLIC_HUB_ID && (!this.conns[pid] || !this.conns[pid].open)) {
        // 手动触发检查
        if(!this.isHub) {
           this.log('接待员未响应，尝试上位...');
           this.becomeHub();
        }
      }
    }, 5000); // 5秒连不上接待员就自己当
  },

  setupConn(conn, isIncoming) {
    const pid = conn.peer;
    const cObj = { conn, open: false, name: shortId(pid), lastPing: Date.now() };
    this.conns[pid] = cObj;

    conn.on('open', () => {
      cObj.open = true;
      this.remember(pid);
      conn.send({type:'hello', name: this.myName});
      
      // 如果我是 Hub，并且有新人连我，我把我知道的所有人推给他 (简单的 Peer Exchange)
      if (this.isHub) {
        const others = Object.keys(this.conns).filter(id => id !== pid && this.conns[id].open);
        conn.send({type:'peers', list: others});
      }
      
      this.updateStatus();
    });

    conn.on('data', d => this.handleData(pid, d));
    conn.on('close', () => { delete this.conns[pid]; this.updateStatus(); });
    conn.on('error', () => { delete this.conns[pid]; this.updateStatus(); });
  },

  handleData(pid, d) {
    const c = this.conns[pid];
    if(!c) return;
    c.lastPing = Date.now();

    if(d.type === 'hello') {
      c.name = d.name;
      this.updateStatus();
    }
    else if(d.type === 'peers') {
      // 收到接待员给的名单，尝试去连这些人
      if (Array.isArray(d.list)) {
        this.log(`收到 ${d.list.length} 个推荐节点`);
        d.list.forEach(id => this.dial(id));
      }
    }
    else if(d.type === 'chat') {
      if(this.seenMsgIds.has(d.id)) return; 
      this.seenMsgIds.add(d.id);
      if(this.onMsg) this.onMsg(d.from, d.text, 'text', d.senderName);
      this.flood(d, pid); 
    }
    else if(d.type === 'file-start') {
      this.fileChunks[d.fileId] = { meta: d.meta, buffer: [], received: 0, lastUpdate: Date.now() };
      if(this.onMsg) this.onMsg(pid, `正在接收文件: ${d.meta.name} (${humanSize(d.meta.size)})...`, 'sys');
    }
    else if(d.type === 'file-chunk') {
      const f = this.fileChunks[d.fileId];
      if(f) {
        f.buffer.push(d.data);
        f.received += d.data.byteLength;
        f.lastUpdate = Date.now();
        if(f.received >= f.meta.size) {
          const blob = new Blob(f.buffer, {type: f.meta.type});
          const url = URL.createObjectURL(blob);
          if(this.onMsg) this.onMsg(pid, `<a href="${url}" download="${f.meta.name}" style="color:#4ade80">📄 ${f.meta.name} 下载完成</a>`, 'file');
          delete this.fileChunks[d.fileId];
        }
      }
    }
  },

  flood(msg, excludePid) {
    const payload = JSON.stringify(msg);
    Object.entries(this.conns).forEach(([targetId, c]) => {
      if(c.open && targetId !== excludePid) {
        try { c.conn.send(msg); } catch(e){}
      }
    });
  },

  sendChat(text, targetPid) {
    const msgId = Date.now() + '-' + Math.random().toString(36).substr(2,5);
    const msg = {
      type: 'chat', id: msgId, text: text,
      from: this.localId, senderName: this.myName, target: targetPid
    };
    this.seenMsgIds.add(msgId);

    if(targetPid === 'all') {
      this.flood(msg, null);
    } else {
      const c = this.conns[targetPid];
      if(c && c.open) c.conn.send(msg);
      else {
        this.dial(targetPid);
        setTimeout(() => {
           const c2 = this.conns[targetPid];
           if(c2 && c2.open) c2.conn.send(msg);
           else if(this.onMsg) this.onMsg(null, '发送失败：未连接到对方', 'sys');
        }, 2000);
      }
    }
  },

  sendFile(file, targetPid) {
    if(targetPid === 'all') {
      alert('Mesh 模式下暂不支持群发文件（防止拥堵），请先点击头像私聊');
      return;
    }
    const c = this.conns[targetPid];
    if(!c || !c.open) {
      this.dial(targetPid);
      alert('正在建立直连，请稍后再试...');
      return;
    }

    const fileId = Date.now() + '-' + Math.random().toString(36).substr(2,5);
    const meta = { name: file.name, size: file.size, type: file.type };
    c.conn.send({ type: 'file-start', fileId, meta });

    let offset = 0;
    const reader = new FileReader();
    reader.onload = (e) => {
      if(c.open) {
        c.conn.send({ type: 'file-chunk', fileId: fileId, data: e.target.result });
        offset += e.target.result.byteLength;
        if(offset < file.size) readNext();
        else if(this.onMsg) this.onMsg(null, `文件 ${file.name} 发送完毕`, 'sys');
      }
    };
    const readNext = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };
    readNext();
  },

  keepAlive() {
    if(!this.peer) return;
    const now = Date.now();
    const pids = Object.keys(this.conns);
    
    // 只有当我不是 Hub，且我没连上 Hub 时，才疯狂重试连接 Hub
    if (!this.isHub && !this.conns[PUBLIC_HUB_ID]?.open) {
       this.dial(PUBLIC_HUB_ID);
    }

    Object.entries(this.conns).forEach(([pid, c]) => {
      if(!c.open) return;
      if(now - c.lastPing > 4000) c.conn.send({type:'ping'});
      if(now - c.lastPing > 30000) { c.conn.close(); delete this.conns[pid]; }
    });
  },

  remember(pid) {
    if(pid === PUBLIC_HUB_ID) return; // 不用记 Hub，反正写死在代码里
    this.knownPeers.add(pid);
    if(this.knownPeers.size > 50) {
      const it = this.knownPeers.values();
      this.knownPeers.delete(it.next().value);
    }
    localStorage.setItem('p1_peers', JSON.stringify([...this.knownPeers]));
  },

  updateStatus() {
    if(this.onStatus) this.onStatus({
      id: this.localId,
      online: Object.keys(this.conns).filter(k => this.conns[k].open).length,
      connected: !!this.peer && !this.peer.disconnected,
      isHub: this.isHub
    });
    if(this.onContactUpdate) this.onContactUpdate(this.conns);
  },

  requestWakeLock() {
    if('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(()=>{});
  }
};

// ===================== 界面逻辑 (UI) =====================
const ui = {
  activeChat: 'all', 
  
  init() {
    this.bindEvents();
    app.onStatus = s => {
      $('#myId').innerText = shortId(s.id);
      // 显示是否是接待员
      const role = s.isHub ? '👑 接待员' : '普通节点';
      $('#statusText').innerText = s.connected ? `在线 (${role})` : '离线';
      $('#statusDot').className = 'dot ' + (s.connected ? 'online':'');
      $('#onlineCount').innerText = `${s.online} 邻居`;
      $('#myNick').innerText = app.myName;
    };
    
    app.onContactUpdate = conns => this.renderContacts(conns);
    
    app.onMsg = (fromId, text, type, senderName) => {
      const isPublic = !app.conns[fromId]?.target || app.conns[fromId]?.target === 'all';
      if(this.activeChat === 'all' || this.activeChat === fromId) {
         const name = senderName || (app.conns[fromId]?.name) || shortId(fromId);
         const isHtml = type === 'file';
         this.appendMsg(name, text, false, type==='sys', isHtml);
      }
    };

    app.init();
  },

  bindEvents() {
    $('#btnSend').onclick = () => this.doSend();
    $('#editor').onkeydown = e => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); this.doSend(); } };
    $('#btnBack').onclick = () => { $('#sidebar').classList.remove('hidden'); };
    $('#btnSettings').onclick = () => $('#settings-panel').style.display='grid';
    $('#btnCloseSettings').onclick = () => $('#settings-panel').style.display='none';
    
    $('#btnFile').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = (e) => {
      const file = e.target.files[0];
      if(file) {
        if(app.sendFile(file, this.activeChat) !== false) { 
           this.appendMsg('我', `正在发送文件 ${file.name}...`, true, true);
        }
        e.target.value = ''; 
      }
    };

    $('#btnSave').onclick = () => {
      const nick = $('#iptNick').value.trim();
      if(nick) { app.myName = nick; localStorage.setItem('nickname', nick); }
      const peer = $('#iptPeer').value.trim();
      if(peer) app.dial(peer);
      $('#settings-panel').style.display='none';
      app.updateStatus();
    };
    $('#iptNick').value = app.myName;
    $('#btnToggleLog').onclick = () => {
      const el = $('#miniLog');
      el.style.display = el.style.display==='block' ? 'none' : 'block';
    };
  },

  renderContacts(conns) {
    const list = $('#contactList');
    let html = `
      <div class="contact-item ${this.activeChat==='all'?'active':''}" onclick="ui.switchChat('all')">
        <div class="avatar" style="background:#2a7cff">全</div>
        <div class="c-info">
          <div class="c-top"><div class="c-name">公共频道</div></div>
          <div class="c-msg">Mesh 全网广播</div>
        </div>
      </div>
    `;
    
    Object.entries(conns).forEach(([pid, c]) => {
      if(!c.open) return;
      // 标记接待员
      const isHub = (pid === PUBLIC_HUB_ID);
      const tag = isHub ? '👑 ' : '';
      
      html += `
        <div class="contact-item ${this.activeChat===pid?'active':''}" onclick="ui.switchChat('${pid}')">
          <div class="avatar" style="background:#1f2937">${c.name[0]}</div>
          <div class="c-info">
            <div class="c-top">
              <div class="c-name">${tag}${c.name}</div>
              <div class="c-time">${shortId(pid)}</div>
            </div>
            <div class="c-msg">直连中</div>
          </div>
        </div>
      `;
    });
    list.innerHTML = html;
  },

  switchChat(pid) {
    this.activeChat = pid;
    $('#chatTitle').innerText = pid==='all' ? '公共频道 (Mesh)' : (app.conns[pid]?.name || pid);
    $('#msgList').innerHTML = '<div class="sys-msg">切换会话</div>';
    if(window.innerWidth < 768) $('#sidebar').classList.add('hidden');
    this.renderContacts(app.conns);
  },

  doSend() {
    const el = $('#editor');
    const txt = el.innerText.trim();
    if(!txt) return;
    
    app.sendChat(txt, this.activeChat);
    this.appendMsg('我', txt, true);
    el.innerText = '';
  },

  appendMsg(name, text, isMe, isSys, isHtml) {
    const list = $('#msgList');
    const div = document.createElement('div');
    if(isSys) {
      div.className = 'sys-msg';
      div.innerHTML = text; 
    } else {
      div.className = `msg-row ${isMe?'me':'other'}`;
      const content = isHtml ? text : text.replace(/</g,'<').replace(/>/g,'>');
      div.innerHTML = `
        <div style="max-width:100%">
          <div class="msg-bubble">${content}</div>
          ${!isMe ? `<div class="msg-meta">${name}</div>` : ''}
        </div>
      `;
    }
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }
};

function shortId(id){ return (id||'').substr(0,6); }
function humanSize(bytes) {
  const k = 1024; if(bytes<k) return bytes+' B';
  const i = Math.floor(Math.log(bytes)/Math.log(k));
  return parseFloat((bytes/Math.pow(k,i)).toFixed(1)) + ' ' + ['B','KB','MB','GB'][i];
}
const $ = s => document.querySelector(s);

window.ui = ui;
window.app = app;
ui.init();

})();