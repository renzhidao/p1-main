(function(){
'use strict';

// ===================== 强壮配置 =====================
const SIGNAL_SERVERS = [
  {host:'peerjs.92k.de', port:443, secure:true, path:'/'},
  {host:'0.peerjs.com', port:443, secure:true, path:'/'}
];
const ICE = [
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun.miwifi.com:3478'},
  {urls:'stun:global.stun.twilio.com:3478'}
];
const MAX_PEERS = 20;
const HUB_ID = 'p1-hub-v4'; // 升级版本

// ===================== 核心逻辑 =====================
const app = {
  localId: localStorage.getItem('p1_id') || '',
  myName: localStorage.getItem('nickname') || ('User-'+Math.random().toString(36).substr(2,4)),
  
  peer: null,
  conns: {}, // pid -> {conn, state, lastPing, name}
  // state: 'connecting' | 'connected' | 'dead'
  
  // 🔥 永久存储
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{}'), // pid -> [msgObj]
  
  // 内部状态
  serverIdx: 0,
  isHub: false,
  restarting: false,
  
  // UI 接口
  onUpdate: null, // 合并所有 UI 更新通知

  log(s) {
    console.log(s);
    const el = document.getElementById('miniLog');
    if(el) { el.innerText = s + '\n' + el.innerText; } // 新日志在顶部
  },

  init() {
    this.start();
    
    // 5秒一次大检查
    setInterval(() => this.watchdog(), 5000);
    
    // 页面切回前台时，如果断网了，立刻重连
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible' && (!this.peer || this.peer.disconnected)) {
        this.log('👀 唤醒重连...');
        this.start();
      }
    });
  },

  // 启动/重启流程
  start(forceHub = false) {
    if(this.restarting) return;
    this.restarting = true;

    // 清理旧身
    if(this.peer) { try{this.peer.destroy();}catch(e){} this.peer=null; }
    
    const srv = SIGNAL_SERVERS[this.serverIdx];
    this.log(`正在连接 ${srv.host}...`);

    // 决定 ID：如果是强制 Hub，则用 Hub ID；否则用本地 ID；没有则 undefined (随机)
    let myId = forceHub ? HUB_ID : (this.localId || undefined);
    // 如果本地存的是 Hub ID 但现在没强制 Hub，说明上次我是 Hub，这次也尽量保持
    if(!forceHub && this.localId === HUB_ID) myId = HUB_ID;

    try {
      const p = new Peer(myId, {
        host: srv.host, port: srv.port, secure: srv.secure, path: srv.path,
        config: { iceServers: ICE }, debug: 1,
        pingInterval: 5000 // PeerJS 内部心跳
      });

      p.on('open', id => {
        this.restarting = false;
        this.localId = id;
        this.isHub = (id === HUB_ID);
        if(!this.isHub) localStorage.setItem('p1_id', id); // 只有普通 ID 才存，防止 Hub ID 污染
        
        this.log(`✅ 成功: ${this.isHub?'👑 接待员':'👤 节点'} (${id.slice(0,6)})`);
        this.requestWakeLock();
        this.notifyUI();

        // 业务启动
        if(!this.isHub) {
          this.dial(HUB_ID); // 找接待员
          this.reconnectKnown(); // 找老朋友
        }
      });

      p.on('connection', conn => this.handleIncoming(conn));
      
      p.on('error', err => {
        this.restarting = false;
        this.log(`⚠️ ${err.type}`);
        
        if(err.type === 'unavailable-id') {
          // ID 冲突：如果你想当 Hub 被拒了，说明 Hub 活着，那你就当普通人
          if(myId === HUB_ID) {
            this.log('👑 接待员席位已满，转为普通人');
            this.localId = ''; // 清空 ID 让系统生成新的
            localStorage.removeItem('p1_id');
            setTimeout(() => this.start(false), 500);
          }
        } 
        else if(err.type === 'peer-unavailable') {
          // 找不到人：如果是找 Hub 找不到，那就自己上位
          if(err.message.includes(HUB_ID)) {
            this.log('🚨 接待员缺席，正在上位...');
            this.start(true); // 强制成为 Hub
          }
        }
        else if(['network','server-error','socket-error'].includes(err.type)) {
          this.serverIdx = (this.serverIdx + 1) % SIGNAL_SERVERS.length;
          setTimeout(() => this.start(), 2000);
        }
      });

      p.on('disconnected', () => { 
        // 仅仅是信令断了，连接可能还在，尝试重连信令
        if(!this.restarting) p.reconnect(); 
      });

      this.peer = p;

    } catch(e) {
      this.restarting = false;
      this.log('启动失败:' + e.message);
      setTimeout(() => this.start(), 3000);
    }
  },

  // 拨号
  dial(pid) {
    if(pid === this.localId || (this.conns[pid] && this.conns[pid].state === 'connected')) return;
    if(!this.peer || this.peer.destroyed) return;
    
    const conn = this.peer.connect(pid, {reliable: true, serialization: 'json'});
    this.setupConn(conn, false);
  },

  // 处理入站
  handleIncoming(conn) {
    this.setupConn(conn, true);
  },

  // 连接设置 & 握手
  setupConn(conn, isIncoming) {
    const pid = conn.peer;
    const c = { 
      conn, 
      state: 'connecting', 
      lastPing: Date.now(), 
      name: pid.slice(0,6) 
    };
    this.conns[pid] = c;

    conn.on('open', () => {
      // 握手第一步：发送身份
      conn.send({t: 'HELLO', name: this.myName});
      // 如果我是 Hub，把别人介绍给他
      if(this.isHub) {
        const list = Object.keys(this.conns).filter(id => id!==pid && this.conns[id].state==='connected');
        if(list.length) conn.send({t: 'PEERS', list});
      }
    });

    conn.on('data', d => {
      c.lastPing = Date.now();
      
      if(d.t === 'HELLO') {
        c.name = d.name;
        c.state = 'connected'; // 握手完成
        this.log((isIncoming?'📥':'📤') + ` 连通: ${d.name}`);
        this.remember(pid);
        this.notifyUI();
        
        // 握手回执 (ACK) - 解决半开连接
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
        this.saveMsg(pid, d.text, false, d.name);
        this.notifyUI();
      }
      else if(d.t === 'FILE_CHUNK') {
        // 简化文件处理：直接提示
        this.saveMsg(pid, `[收到文件数据 ${d.curr}/${d.total}]`, false, d.name);
        this.notifyUI();
      }
    });

    conn.on('close', () => { this.closeConn(pid); });
    conn.on('error', () => { this.closeConn(pid); });
  },

  closeConn(pid) {
    if(this.conns[pid]) {
      // this.log(`断开: ${shortId(pid)}`);
      delete this.conns[pid];
      this.notifyUI();
    }
  },

  // 看门狗：检测死链、断网
  watchdog() {
    const now = Date.now();
    // 1. 检查信令
    if(this.peer && this.peer.disconnected && !this.restarting) {
      this.peer.reconnect();
    }
    
    // 2. 检查节点心跳
    Object.keys(this.conns).forEach(pid => {
      const c = this.conns[pid];
      if(now - c.lastPing > 15000) { // 15秒没动静
        if(c.state === 'connected') {
           // 尝试发 Ping
           try { c.conn.send({t: 'PING'}); } catch(e) { this.closeConn(pid); }
        } else if (now - c.lastPing > 30000) {
           // 连了30秒还是 connecting? 杀。
           this.closeConn(pid);
        }
      }
    });

    // 3. 没接待员？重试
    if(!this.isHub && !this.conns[HUB_ID] && !this.restarting) {
      this.dial(HUB_ID);
    }
  },

  // 发送消息
  send(text, targetId) {
    const msg = {t: 'MSG', text, name: this.myName, id: Date.now()};
    
    // 存自己的
    this.saveMsg(targetId, text, true, '我');

    if(targetId === 'all') {
      // 群发
      Object.values(this.conns).forEach(c => {
        if(c.state === 'connected') c.conn.send(msg);
      });
    } else {
      // 私聊
      const c = this.conns[targetId];
      if(c && c.state === 'connected') {
        c.conn.send(msg);
      } else {
        this.saveMsg(targetId, '[发送失败: 未连接]', true, '系统');
        this.dial(targetId); // 尝试重连
      }
    }
    this.notifyUI();
  },

  // 保存消息到本地存储
  saveMsg(pid, text, isMe, senderName) {
    if(!this.msgs[pid]) this.msgs[pid] = [];
    this.msgs[pid].push({
      txt: text, 
      me: isMe, 
      name: senderName, 
      time: Date.now()
    });
    // 限制历史记录长度 50 条
    if(this.msgs[pid].length > 50) this.msgs[pid].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
  },

  // 辅助
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
    let list = JSON.parse(localStorage.getItem('p1_peers')||'[]');
    list.forEach(pid => this.dial(pid));
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
    app.onUpdate = () => this.render();
    
    // 绑定事件
    const $ = s => document.querySelector(s);
    $('#btnSend').onclick = () => {
      const txt = $('#editor').innerText.trim();
      if(txt) { app.send(txt, this.active); $('#editor').innerText=''; }
    };
    
    // 定期刷新UI (时间戳)
    setInterval(() => this.render(), 3000);
  },

  render() {
    const $ = s => document.querySelector(s);
    
    // 1. 自身状态
    $('#myId').innerText = app.localId ? app.localId.slice(0,6) : '...';
    $('#statusText').innerText = app.peer && !app.peer.disconnected ? '在线' : '连接中';
    $('#statusDot').className = 'dot ' + (app.peer && !app.peer.disconnected ? 'online' : '');
    
    // 2. 联系人列表
    const list = $('#contactList');
    let html = `
      <div class="contact-item ${this.active==='all'?'active':''}" onclick="ui.switch('all')">
        <div class="avatar" style="background:#2a7cff">全</div>
        <div class="c-info"><div class="c-name">公共频道</div></div>
      </div>
    `;
    
    // 合并“当前连接”和“历史记录”
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

    // 3. 消息列表
    const msgBox = $('#msgList');
    const msgs = app.msgs[this.active] || [];
    
    // 简单的差异更新（防止闪烁）
    if(msgBox.childElementCount !== msgs.length + 1) { // +1 是系统欢迎语
      msgBox.innerHTML = '<div class="sys-msg">加密连接已建立</div>';
      msgs.forEach(m => {
        const div = document.createElement('div');
        div.className = `msg-row ${m.me?'me':'other'}`;
        div.innerHTML = `
          <div style="max-width:100%">
            <div class="msg-bubble">${m.txt}</div>
            ${!m.me ? `<div class="msg-meta">${m.name}</div>` : ''}
          </div>`;
        msgBox.appendChild(div);
      });
      msgBox.scrollTop = msgBox.scrollHeight;
    }
    
    // 标题
    $('#chatTitle').innerText = this.active==='all' ? '公共频道' : (app.conns[this.active]?.name || this.active.slice(0,6));
  },

  switch(pid) {
    this.active = pid;
    const msgBox = document.querySelector('#msgList');
    msgBox.innerHTML = ''; // 强制重绘
    this.render();
    if(window.innerWidth < 768) document.querySelector('#sidebar').classList.add('hidden');
  }
};

window.app = app;
window.ui = ui;
app.init();
ui.init();

})();