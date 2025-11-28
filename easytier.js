(function(){
'use strict';

// ===================== 大规模 Mesh 配置 =====================
// 定义 10 个平行宇宙（Shard），用户随机落入其中一个
// 想要扩容？增加 SHARD_COUNT 即可
const SHARD_COUNT = 10; 
const SEED_PREFIX = 'p1-seed-';

const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};

// ===================== 核心逻辑 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*100000),
  myShard: 0, // 我所在的宇宙编号
  
  peer: null,
  conns: {}, // pid -> conn
  isSeed: false,
  
  // 状态统计
  shardStats: {}, // 记录其他宇宙的人数估算
  
  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = s + '\n' + el.innerText.slice(0,300);
  },

  init() {
    // 1. 确定我的宇宙
    // 如果是老用户，保持在原来的宇宙；新用户随机分配
    let savedShard = localStorage.getItem('p1_shard');
    if (savedShard === null) {
      savedShard = Math.floor(Math.random() * SHARD_COUNT);
      localStorage.setItem('p1_shard', savedShard);
    }
    this.myShard = parseInt(savedShard);
    
    // 2. 启动连接
    // 优先尝试成为本宇宙的种子节点
    const delay = Math.floor(Math.random() * 2000);
    setTimeout(() => this.tryBecomeSeed(0), delay);
    
    // 3. 守护进程
    setInterval(() => this.maintainNetwork(), 5000);
    setInterval(() => this.broadcastStats(), 10000); // 每10秒汇报存活
  },

  // 尝试成为本宇宙的种子
  tryBecomeSeed(index) {
    // 每个宇宙有 3 个种子位：p1-seed-5-alpha, p1-seed-5-beta...
    const seeds = ['alpha', 'beta', 'gamma'];
    if (index >= seeds.length) {
      this.startNormal();
      return;
    }

    const seedId = `${SEED_PREFIX}${this.myShard}-${seeds[index]}`;
    this.log(`尝试成为宇宙 ${this.myShard} 的守护者 (${seeds[index]})...`);

    const p = new Peer(seedId, CONFIG);

    p.on('open', (id) => {
      this.myId = id;
      this.isSeed = true;
      this.peer = p;
      this.bindEvents(p);
      this.log(`👑 我是宇宙 ${this.myShard} 的守护者`);
      ui.render();
      
      // 种子互联：连接本宇宙其他种子
      seeds.forEach(suffix => {
        const other = `${SEED_PREFIX}${this.myShard}-${suffix}`;
        if(other !== id) this.connectTo(other);
      });
      
      // 跨宇宙桥接：尝试连接下一个宇宙的 alpha 种子，形成环状骨干网
      const nextShard = (this.myShard + 1) % SHARD_COUNT;
      this.connectTo(`${SEED_PREFIX}${nextShard}-alpha`);
    });

    p.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        this.tryBecomeSeed(index + 1);
      } else {
        this.tryBecomeSeed(index + 1); // 其他错误也跳过
      }
    });
  },

  startNormal() {
    this.isSeed = false;
    const p = new Peer(CONFIG);
    
    p.on('open', (id) => {
      this.myId = id;
      this.peer = p;
      this.bindEvents(p);
      this.log(`👤 居民 (宇宙 ${this.myShard})`);
      ui.render();
      
      // 连接本宇宙的种子
      ['alpha', 'beta', 'gamma'].forEach(suffix => {
        this.connectTo(`${SEED_PREFIX}${this.myShard}-${suffix}`);
      });
    });
    
    p.on('error', e => {});
  },

  bindEvents(p) {
    p.on('connection', conn => this.setupConn(conn));
    p.on('disconnected', () => p.reconnect());
  },

  connectTo(pid) {
    if(pid === this.myId || this.conns[pid]) return;
    // 普通人只连 5 个，种子连 20 个
    const limit = this.isSeed ? 20 : 5;
    if(Object.keys(this.conns).length >= limit) return;
    
    const conn = this.peer.connect(pid, {reliable:true});
    this.setupConn(conn);
  },

  setupConn(conn) {
    const pid = conn.peer;
    conn.on('open', () => {
      this.conns[pid] = { conn, open: true, shard: -1 }; // 暂不知道对方宇宙
      // 握手：报上名号和宇宙ID
      conn.send({t:'HELLO', n: this.myName, s: this.myShard});
    });

    conn.on('data', (d) => {
      if(d.t === 'HELLO') {
        if(this.conns[pid]) {
          this.conns[pid].label = d.n;
          this.conns[pid].shard = d.s;
        }
        // 如果对方是其他宇宙的，标记为“星际通道”
        if(d.s !== this.myShard) this.log(`🌌 建立星际通道: 宇宙 ${d.s}`);
      }
      
      // 消息转发逻辑 (Gossip)
      if(d.t === 'MSG') {
        // 如果是本宇宙消息，或者是全宇宙广播
        if(d.shard === this.myShard || d.target === 'global') {
          ui.addMsg(d.n, d.txt, false, d.shard);
        }
        
        // 转发规则：
        // 1. 如果 target='global'，发给所有人（TTL控制）
        // 2. 如果是本宇宙消息，只发给本宇宙连接
        this.flood(d, pid);
      }
      
      // 状态统计
      if(d.t === 'STATS') {
        // 更新全网人数估算
        this.shardStats[d.fromShard] = d.count;
        ui.updateGlobalCount();
      }
    });

    conn.on('close', () => { delete this.conns[pid]; });
    conn.on('error', () => { delete this.conns[pid]; });
  },

  flood(msg, excludeId) {
    // 简单的 TTL 防止无限循环
    if(msg.ttl <= 0) return;
    msg.ttl -= 1;
    
    Object.keys(this.conns).forEach(tid => {
      if(tid === excludeId) return;
      const c = this.conns[tid];
      if(!c.open) return;
      
      // 路由优化：本宇宙消息不出宇宙，除非你是桥接种子
      if(msg.target !== 'global' && c.shard !== this.myShard && c.shard !== -1) return;
      
      try { c.conn.send(msg); } catch(e){}
    });
  },

  send(txt) {
    if(!txt) return;
    // 默认发给本宇宙
    const msg = {
      t: 'MSG', 
      txt, 
      n: this.myName, 
      id: Date.now()+Math.random(), 
      shard: this.myShard,
      target: 'local', // or 'global'
      ttl: 10 
    };
    ui.addMsg('我', txt, true, this.myShard);
    this.flood(msg, null);
  },

  maintainNetwork() {
    if(!this.peer || this.peer.destroyed) return;
    // 掉线重连种子
    if (Object.keys(this.conns).length < 2) {
      ['alpha', 'beta', 'gamma'].forEach(suffix => {
        this.connectTo(`${SEED_PREFIX}${this.myShard}-${suffix}`);
      });
    }
  },
  
  broadcastStats() {
    // 估算本宇宙在线：我的直连 * 扩散系数 (伪科学，但能看)
    const myCount = Object.keys(this.conns).filter(k => this.conns[k].shard === this.myShard).length + 1;
    const msg = {t:'STATS', fromShard: this.myShard, count: myCount, ttl: 5};
    this.flood(msg, null);
  },
  
  getTotalOnline() {
    let sum = 0;
    for(let s=0; s<SHARD_COUNT; s++) sum += (this.shardStats[s] || 0);
    return Math.max(sum, Object.keys(this.conns).length + 1);
  }
};

// ===================== UI =====================
const ui = {
  init() {
    document.getElementById('btnSend').onclick = () => {
      const el = document.getElementById('editor');
      app.send(el.innerText);
      el.innerText = '';
    };
    document.getElementById('btnBack').onclick = () => {
      document.getElementById('sidebar').classList.remove('hidden');
    };
    setInterval(() => this.render(), 2000);
  },

  render() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,8) : '...';
    document.getElementById('statusText').innerText = `宇宙 #${app.myShard} | ${app.isSeed?'守护者':'居民'}`;
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
    this.updateGlobalCount();

    const list = document.getElementById('contactList');
    list.innerHTML = `
      <div class="contact-item active">
        <div class="avatar" style="background:#2a7cff">#${app.myShard}</div>
        <div class="c-info">
          <div class="c-name">本宇宙频道</div>
          <div class="c-msg">仅限分片 ${app.myShard} 内通信</div>
        </div>
      </div>
    `;
    
    // 显示直连节点
    Object.keys(app.conns).forEach(pid => {
      const c = app.conns[pid];
      if(!c.open) return;
      const isAlien = c.shard !== app.myShard;
      list.innerHTML += `
        <div class="contact-item" style="opacity:0.7">
          <div class="avatar" style="background:${isAlien?'#purple':'#333'}">${isAlien?'👽':'👤'}</div>
          <div class="c-info"><div class="c-name">${c.label} ${isAlien?('(宇宙 '+c.shard+')'):''}</div></div>
        </div>`;
    });
  },
  
  updateGlobalCount() {
    document.getElementById('onlineCount').innerText = app.getTotalOnline() + ' 节点在线';
  },

  addMsg(name, txt, isMe, shardId) {
    const box = document.getElementById('msgList');
    const d = document.createElement('div');
    d.className = `msg-row ${isMe?'me':'other'}`;
    const tag = (shardId !== undefined && shardId !== app.myShard) ? `[来自宇宙 ${shardId}] ` : '';
    d.innerHTML = `
      <div style="max-width:80%">
        <div class="msg-bubble">${tag}${txt}</div>
        ${!isMe ? `<div class="msg-meta">${name}</div>` : ''}
      </div>`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
};

window.app = app;
window.ui = ui;
ui.init();
app.init();

})();