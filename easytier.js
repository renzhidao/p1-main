(function(){
'use strict';

// ===================== 无主 Mesh 配置 =====================
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};

const MAX_NEIGHBORS = 8; 
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3']; 

// ===================== 核心逻辑 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*10000),
  peer: null,
  conns: {}, 
  knownPeers: new Set(), 
  seenMsgs: new Set(), 
  
  isSeed: false, // 标记自己是否变成了种子

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 300);
  },

  init() {
    this.start();
    
    // 🕸️ 网络维护
    setInterval(() => {
      this.cleanup();
      this.fillSlots();
      this.exchangePeers();
    }, 5000);
    
    // 指纹清理
    setInterval(() => this.seenMsgs.clear(), 60000);
  },

  start() {
    if(this.peer) return;
    
    // 初始策略：先做普通人，连连看
    this.initPeer(undefined); 
    
    // 🔥 保底机制：5秒后还是孤家寡人？我去当种子！
    setTimeout(() => {
      if (Object.keys(this.conns).length === 0 && !this.isSeed) {
        this.log('🚨 无人响应，正在强制化身为种子...');
        this.becomeSeed();
      }
    }, 5000);
  },

  // 尝试变身为种子（轮询 SEEDS 列表）
  becomeSeed(index = 0) {
    if (index >= SEEDS.length) {
      this.log('⚠️ 所有种子位均被占，保持普通身份重试...');
      this.initPeer(undefined); // 回退为普通人
      return;
    }
    
    if (this.peer) this.peer.destroy();
    this.initPeer(SEEDS[index], index); // 尝试第 index 个种子 ID
  },

  initPeer(id, seedIndex = null) {
    try {
      const p = new Peer(id, CONFIG);
      
      p.on('open', myId => {
        this.myId = myId;
        this.peer = p;
        this.isSeed = (seedIndex !== null);
        this.log(`✅ 上线: ${myId.slice(0,6)} ${this.isSeed ? '(种子)' : ''}`);
        ui.updateSelf();
        
        // 不管我是谁，我都尝试去连所有种子（互相结网）
        SEEDS.forEach(s => { if(s !== myId) this.connectTo(s); });
      });

      p.on('error', err => {
        if(err.type === 'unavailable-id') {
          // 种子 ID 被占了？试试下一个种子位
          if (seedIndex !== null) {
            this.becomeSeed(seedIndex + 1);
          } else {
            // 普通 ID 被占（极罕见），重试
            setTimeout(() => this.initPeer(undefined), 1000);
          }
        } else {
          // this.log(`Err: ${err.type}`);
        }
      });

      p.on('connection', conn => this.handleConn(conn, true));
    } catch(e) {
      this.log('PeerJS 崩溃: ' + e);
    }
  },

  // 建立连接
  connectTo(targetId) {
    if(targetId === this.myId || this.conns[targetId]) return;
    if(Object.keys(this.conns).length >= MAX_NEIGHBORS) return;
    
    const conn = this.peer.connect(targetId, {reliable: true});
    this.handleConn(conn, false);
  },

  handleConn(conn, isIncoming) {
    const pid = conn.peer;
    
    conn.on('open', () => {
      this.conns[pid] = conn;
      this.knownPeers.add(pid); 
      ui.renderList();
      
      conn.send({t: 'HELLO', n: this.myName});
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') {
        conn.label = d.n;
        // this.log(`🔗 连上: ${d.n}`);
        ui.renderList();
      }
      
      if(d.t === 'PEER_EX' && Array.isArray(d.list)) {
        d.list.forEach(id => this.knownPeers.add(id));
        this.fillSlots();
      }
      
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; 
        this.seenMsgs.add(d.id);
        
        ui.appendMsg(d.sender, d.txt, false);
        this.flood(d, pid); 
      }
    });

    conn.on('close', () => this.dropPeer(pid));
    conn.on('error', () => this.dropPeer(pid));
  },

  dropPeer(pid) {
    delete this.conns[pid];
    ui.renderList();
  },

  flood(packet, excludeId) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== excludeId && this.conns[pid].open) {
        try { this.conns[pid].send(packet); } catch(e){}
      }
    });
  },

  sendText(txt) {
    const id = Date.now() + Math.random().toString(36);
    const packet = {t: 'MSG', id, txt, sender: this.myName};
    this.seenMsgs.add(id);
    
    ui.appendMsg('我', txt, true);
    this.flood(packet, null);
  },

  // === 🕸️ 自愈逻辑 ===
  cleanup() {
    Object.keys(this.conns).forEach(pid => {
      if(!this.conns[pid].open) this.dropPeer(pid);
    });
  },

  fillSlots() {
    // 只要连接数不满，就一直尝试连人
    if (Object.keys(this.conns).length < MAX_NEIGHBORS) {
      // 优先连种子
      SEEDS.forEach(s => {
        if(s !== this.myId && !this.conns[s]) this.connectTo(s);
      });
      
      // 其次连已知节点
      const candidates = [...this.knownPeers].filter(p => !this.conns[p] && p !== this.myId);
      if(candidates.length > 0) {
        const luckyOne = candidates[Math.floor(Math.random() * candidates.length)];
        this.connectTo(luckyOne);
      }
    }
  },

  exchangePeers() {
    const myKnowledge = [...this.knownPeers, this.myId].slice(0, 20); 
    const packet = {t: 'PEER_EX', list: myKnowledge};
    
    Object.values(this.conns).forEach(c => {
      if(c.open) c.send(packet);
    });
  }
};

// ===================== UI =====================
const ui = {
  init() {
    document.getElementById('btnSend').onclick = () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) {
        app.sendText(el.innerText.trim());
        el.innerText = '';
      }
    };
    document.getElementById('btnBack').onclick = () => {
      document.getElementById('sidebar').classList.remove('hidden');
    };
    
    this.updateSelf();
    this.renderList();
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    const role = app.isSeed ? '👑 种子节点' : '普通节点';
    document.getElementById('statusText').innerText = role;
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  renderList() {
    const list = document.getElementById('contactList');
    list.innerHTML = `
      <div class="contact-item active" onclick="ui.toggleSidebar()">
        <div class="avatar" style="background:#2a7cff">全</div>
        <div class="c-info"><div class="c-name">公共频道</div><div class="c-msg">Mesh 广播</div></div>
      </div>
    `;
    
    const count = Object.keys(app.conns).length;
    document.getElementById('onlineCount').innerText = count + ' 邻居';

    Object.keys(app.conns).forEach(pid => {
      const c = app.conns[pid];
      list.innerHTML += `
        <div class="contact-item">
          <div class="avatar" style="background:#333">${(c.label||pid)[0]}</div>
          <div class="c-info">
            <div class="c-name">${c.label || pid.slice(0,6)}</div>
            <div class="c-msg">${pid.includes('p1-s') ? '引导节点' : '直连'}</div>
          </div>
        </div>
      `;
    });
  },

  appendMsg(name, txt, isMe) {
    const box = document.getElementById('msgList');
    const d = document.createElement('div');
    d.className = `msg-row ${isMe?'me':'other'}`;
    d.innerHTML = `
      <div style="max-width:85%">
        <div class="msg-bubble">${txt}</div>
        ${!isMe ? `<div class="msg-meta">${name}</div>` : ''}
      </div>`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  },
  
  toggleSidebar() {
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
  }
};

// 启动
window.app = app;
window.ui = ui;
ui.init();
app.init();

})();