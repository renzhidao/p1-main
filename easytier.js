(function(){
'use strict';

// ===================== 无主 Mesh 配置 =====================
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};

// 每个人最多维持 8 个直连，多了拒绝，少了去补
const MAX_NEIGHBORS = 8; 
// 引导节点池（种子）：仅用于初次进入网络，连上后就不再依赖它们
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3']; 

// ===================== 核心逻辑 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*10000),
  peer: null,
  conns: {}, // 活跃连接: pid -> conn
  knownPeers: new Set(), // 知道但不一定连着的节点池
  seenMsgs: new Set(), // 消息去重指纹
  
  // 日志
  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 300);
  },

  init() {
    this.start();
    
    // 🕸️ 网络维护进程
    setInterval(() => {
      this.cleanup();        // 清理死链
      this.fillSlots();      // 缺人补人
      this.exchangePeers();  // 交换通讯录
    }, 5000);
    
    // 指纹清理
    setInterval(() => this.seenMsgs.clear(), 60000);
  },

  start() {
    if(this.peer) return;
    
    // 随机尝试抢占一个种子位，抢不到就做普通节点
    // 这样保证网络里总有几个固定的入口 ID 存在
    const seedIndex = Math.floor(Math.random() * SEEDS.length);
    const tryId = (Math.random() > 0.5) ? SEEDS[seedIndex] : undefined; // 50%概率尝试当种子

    this.initPeer(tryId);
  },

  initPeer(id) {
    const p = new Peer(id, CONFIG);
    
    p.on('open', myId => {
      this.myId = myId;
      this.peer = p;
      this.log(`✅ 上线: ${myId.slice(0,6)}`);
      ui.updateSelf();
      
      // 刚上线，先连种子节点混个脸熟
      SEEDS.forEach(s => { if(s !== myId) this.connectTo(s); });
    });

    p.on('error', err => {
      // 如果种子 ID 被占，说明种子在线，那我做普通人
      if(err.type === 'unavailable-id') {
        this.initPeer(undefined); // 重新以随机 ID 启动
      }
    });

    p.on('connection', conn => this.handleConn(conn, true));
  },

  // 建立连接
  connectTo(targetId) {
    if(targetId === this.myId || this.conns[targetId]) return;
    // 超过连接上限，不再主动出击（除非是种子）
    if(Object.keys(this.conns).length >= MAX_NEIGHBORS) return;
    
    const conn = this.peer.connect(targetId, {reliable: true});
    this.handleConn(conn, false);
  },

  handleConn(conn, isIncoming) {
    const pid = conn.peer;
    
    conn.on('open', () => {
      // 连接成功
      this.conns[pid] = conn;
      this.knownPeers.add(pid); // 记入小本本
      ui.renderList();
      
      // 握手
      conn.send({t: 'HELLO', n: this.myName});
    });

    conn.on('data', d => {
      // 1. 基础信息交换
      if(d.t === 'HELLO') {
        conn.label = d.n;
        this.log(`🔗 连上: ${d.n}`);
        ui.renderList();
      }
      
      // 2. 通讯录交换 (Gossip)
      if(d.t === 'PEER_EX' && Array.isArray(d.list)) {
        d.list.forEach(id => this.knownPeers.add(id));
        // 如果我很缺连接，就从这里面挑人连
        this.fillSlots();
      }
      
      // 3. 消息处理 (Flood)
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; // 已阅，丢弃
        this.seenMsgs.add(d.id);
        
        ui.appendMsg(d.sender, d.txt, false);
        this.flood(d, pid); // 传给除了来源外的其他人
      }
    });

    conn.on('close', () => this.dropPeer(pid));
    conn.on('error', () => this.dropPeer(pid));
  },

  dropPeer(pid) {
    delete this.conns[pid];
    ui.renderList();
  },

  // 广播 (Flood)
  flood(packet, excludeId) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== excludeId) {
        try { this.conns[pid].send(packet); } catch(e){}
      }
    });
  },

  // 发送入口
  sendText(txt) {
    const id = Date.now() + Math.random().toString(36);
    const packet = {t: 'MSG', id, txt, sender: this.myName};
    this.seenMsgs.add(id);
    
    ui.appendMsg('我', txt, true);
    this.flood(packet, null); // 发给所有人
  },

  // === 🕸️ 自愈逻辑 ===
  
  // 1. 清理无效连接
  cleanup() {
    Object.keys(this.conns).forEach(pid => {
      if(!this.conns[pid].open) this.dropPeer(pid);
    });
  },

  // 2. 缺人补人
  fillSlots() {
    const current = Object.keys(this.conns).length;
    if (current < 3) { // 最少保持 3 个连接
      // 从小本本里随机挑人连
      const candidates = [...this.knownPeers].filter(p => !this.conns[p] && p !== this.myId);
      if(candidates.length > 0) {
        // 随机连一个，避免所有人都连同一个
        const luckyOne = candidates[Math.floor(Math.random() * candidates.length)];
        this.connectTo(luckyOne);
      }
    }
  },

  // 3. 交换通讯录 (Gossip)
  exchangePeers() {
    // 随机把我知道的节点告诉我的邻居
    const myKnowledge = [...this.knownPeers, this.myId].slice(0, 20); // 最多带20个，省流量
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
    document.getElementById('statusText').innerText = '无主网状网络';
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
            <div class="c-msg">直连节点</div>
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