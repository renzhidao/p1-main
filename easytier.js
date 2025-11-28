(function(){
'use strict';

// ===================== 极简配置 =====================
const HUB_ID = 'p1-hub-v6'; // 再次升级，避开所有旧缓存
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};

// ===================== 核心逻辑 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*1000),
  peer: null,
  conns: {}, // pid -> conn
  isHub: false,
  
  // 简单日志
  log(s) {
    console.log(s);
    const el = document.getElementById('miniLog');
    if(el) el.innerText = s + '\n' + el.innerText.slice(0, 200);
  },

  init() {
    // 1. 尝试以普通身份启动
    this.connect();
    
    // 2. 绑定页面可见性
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState==='visible' && (!this.peer || this.peer.disconnected)) {
        this.connect();
      }
    });
  },

  connect(forceHub = false) {
    if(this.peer) { this.peer.destroy(); this.peer = null; }
    
    // 决定 ID
    let id = forceHub ? HUB_ID : (localStorage.getItem('p1_saved_id') || undefined);
    if(!forceHub && id === HUB_ID) id = undefined; // 防止意外永久成为 Hub

    try {
      const p = new Peer(id, CONFIG);
      
      p.on('open', (id) => {
        this.myId = id;
        this.isHub = (id === HUB_ID);
        
        if(!this.isHub) localStorage.setItem('p1_saved_id', id);
        this.log(`✅ ${this.isHub?'接待员':'普通节点'} ID: ${id.slice(0,5)}`);
        
        ui.render(); // 刷新界面
        
        // 如果我是普通人，找接待员
        if(!this.isHub) this.joinNetwork();
      });

      p.on('connection', (conn) => this.setupConn(conn));
      
      p.on('error', (err) => {
        // ID 被占 (说明 Hub 在线，或者我有旧 ID 冲突)
        if(err.type === 'unavailable-id') {
          if(id === HUB_ID) {
            // 我想当 Hub 失败 -> 做普通人
            this.connect(false);
          } else {
            // 我旧 ID 冲突 -> 换新 ID
            localStorage.removeItem('p1_saved_id');
            this.connect(false);
          }
        }
        // 找不到人 (说明 Hub 不在线)
        else if(err.type === 'peer-unavailable') {
          if(err.message.includes(HUB_ID)) {
            this.log('🚨 无接待员，上位中...');
            this.connect(true); // 篡位
          }
        }
        else {
          this.log('⚠️ ' + err.type);
        }
      });

      this.peer = p;
    } catch(e) {
      this.log('启动失败: ' + e);
    }
  },

  joinNetwork() {
    // 连接待员
    const conn = this.peer.connect(HUB_ID, {reliable:true});
    this.setupConn(conn);
    
    // 5秒连不上，自己当接待员
    setTimeout(() => {
      if(!this.conns[HUB_ID] || !this.conns[HUB_ID].open) {
        this.log('接待员超时，上位...');
        this.connect(true);
      }
    }, 4000);
  },

  setupConn(conn) {
    const pid = conn.peer;
    
    conn.on('open', () => {
      this.conns[pid] = conn;
      this.log(`🔗 连通: ${pid.slice(0,5)}`);
      ui.render();
      
      // 交换名字
      conn.send({t:'NAME', n: this.myName});
      
      // 如果我是 Hub，把别人介绍给他
      if(this.isHub) {
        const others = Object.keys(this.conns).filter(id => id !== pid);
        if(others.length) conn.send({t:'PEERS', l: others});
      }
    });

    conn.on('data', (d) => {
      if(d.t === 'NAME') { conn.label = d.n; ui.render(); }
      if(d.t === 'PEERS') { d.l.forEach(id => {
        if(!this.conns[id]) this.setupConn(this.peer.connect(id));
      });}
      if(d.t === 'MSG') { ui.addMsg(d.n, d.txt, false); }
    });

    conn.on('close', () => { delete this.conns[pid]; ui.render(); });
    conn.on('error', () => { delete this.conns[pid]; ui.render(); });
  },

  send(txt) {
    if(!txt) return;
    ui.addMsg('我', txt, true);
    // 群发
    Object.values(this.conns).forEach(c => {
      if(c.open) c.send({t:'MSG', txt: txt, n: this.myName});
    });
  }
};

// ===================== 极简 UI =====================
const ui = {
  init() {
    try {
      document.getElementById('btnSend').onclick = () => {
        const el = document.getElementById('editor');
        app.send(el.innerText);
        el.innerText = '';
      };
      
      // 侧边栏开关
      document.getElementById('btnBack').onclick = () => {
        document.getElementById('sidebar').classList.remove('hidden');
      };
      
      this.render();
    } catch(e) { alert('UI Init Error: ' + e); }
  },

  render() {
    // 更新头部状态
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,5) : '-';
    document.getElementById('onlineCount').innerText = Object.keys(app.conns).length + ' 邻居';
    document.getElementById('statusText').innerText = app.isHub ? '👑 接待员' : '在线';
    document.getElementById('statusDot').className = 'dot ' + (app.peer && !app.peer.disconnected ? 'online':'');

    // 更新联系人列表
    const list = document.getElementById('contactList');
    list.innerHTML = '';
    
    // 公共频道
    let html = `
      <div class="contact-item active">
        <div class="avatar" style="background:#2a7cff">全</div>
        <div class="c-info"><div class="c-name">公共频道</div></div>
      </div>
    `;
    
    Object.keys(app.conns).forEach(pid => {
      const c = app.conns[pid];
      html += `
        <div class="contact-item">
          <div class="avatar" style="background:#666">${(c.label||pid)[0]}</div>
          <div class="c-info"><div class="c-name">${c.label||pid.slice(0,5)}</div></div>
        </div>
      `;
    });
    list.innerHTML = html;
  },

  addMsg(name, txt, isMe) {
    const box = document.getElementById('msgList');
    const d = document.createElement('div');
    d.className = `msg-row ${isMe?'me':'other'}`;
    d.innerHTML = `
      <div style="max-width:80%">
        <div class="msg-bubble">${txt}</div>
        ${!isMe ? `<div class="msg-meta">${name}</div>` : ''}
      </div>`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
};

// 启动
window.app = app;
window.ui = ui;
app.init();
ui.init();

})();