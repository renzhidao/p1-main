(function(){
'use strict';

// ===================== 纯粹配置 =====================
const MASTER_ID = 'p1-master-node-v8'; // 固定主节点 ID
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};

// ===================== 核心状态 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*1000),
  peer: null,
  conns: {}, // 活跃连接池: id -> conn
  msgs: [],  // 消息历史
  seen: new Set(), // 去重指纹
  isMaster: false,
  
  // 启动入口
  init() {
    this.log('正在初始化网络...');
    // 1. 尝试篡位：直接申请当主节点
    this.tryBecomeMaster();
    
    // 2. 守护进程：每3秒清理死链，每分钟清理指纹
    setInterval(() => this.cleanup(), 3000);
    setInterval(() => this.seen.clear(), 60000);
    
    // 3. 页面唤醒重连
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible' && (!this.peer || this.peer.disconnected)) {
        this.log('唤醒重连...');
        this.tryBecomeMaster();
      }
    });
  },

  log(s) {
    // 限制日志长度，防止 UI 卡死
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 500);
  },

  // ====== 连接流程 ======
  
  tryBecomeMaster() {
    if(this.peer) this.peer.destroy();
    
    // 尝试以 MASTER_ID 启动
    const p = new Peer(MASTER_ID, CONFIG);
    
    p.on('open', id => {
      this.onReady(p, id, true);
    });
    
    p.on('error', err => {
      if (err.type === 'unavailable-id') {
        // 失败：说明主节点活着，那我做普通节点
        this.startAsNormal();
      } else {
        this.log('网络错误: ' + err.type);
        setTimeout(() => this.tryBecomeMaster(), 2000);
      }
    });
  },

  startAsNormal() {
    const p = new Peer(CONFIG); // 随机 ID
    p.on('open', id => {
      this.onReady(p, id, false);
      // 连接主节点
      this.connectTo(MASTER_ID);
    });
    p.on('error', e => this.log('普通节点错误: ' + e.type));
  },

  onReady(p, id, isMaster) {
    this.peer = p;
    this.myId = id;
    this.isMaster = isMaster;
    this.conns = {}; // 重置连接池
    this.log(`✅ 上线成功: ${isMaster ? '我是主机' : '普通成员'}`);
    ui.updateSelf();
    
    // 监听入站
    p.on('connection', conn => this.setupConn(conn));
  },

  connectTo(targetId) {
    if(!this.peer || this.conns[targetId] || targetId === this.myId) return;
    const conn = this.peer.connect(targetId, {reliable: true});
    this.setupConn(conn);
  },

  setupConn(conn) {
    const pid = conn.peer;
    
    conn.on('open', () => {
      this.conns[pid] = conn;
      this.log(`🔗 连接: ${pid.slice(0,6)}`);
      ui.renderList(); // 刷新列表
      
      // 握手
      conn.send({t: 'HELLO', name: this.myName});
      
      // 如果我是主机，把别人介绍给他 (简单的路由发现)
      if(this.isMaster) {
        const others = Object.keys(this.conns).filter(id => id !== pid);
        if(others.length) conn.send({t: 'PEERS', list: others});
      }
    });

    conn.on('data', d => this.handleData(pid, d));
    
    conn.on('close', () => {
      delete this.conns[pid];
      ui.renderList();
    });
    
    conn.on('error', () => {
      delete this.conns[pid];
      ui.renderList();
    });
  },

  // ====== 消息处理核心 (修复刷屏的关键) ======
  handleData(fromId, d) {
    // 1. 基础握手
    if(d.t === 'HELLO') {
      if(this.conns[fromId]) this.conns[fromId].label = d.name;
      ui.renderList();
      return;
    }
    
    // 2. 节点发现
    if(d.t === 'PEERS' && Array.isArray(d.list)) {
      d.list.forEach(id => this.connectTo(id));
      return;
    }

    // 3. 聊天消息 (重点修复)
    if(d.t === 'MSG') {
      // ⚡️ 关键：去重检查 ⚡️
      if(this.seen.has(d.id)) return; // 见过？丢弃！
      this.seen.add(d.id);            // 没见过？记录！
      
      // UI 显示
      ui.appendMsg(d.sender, d.txt, false);
      
      // ⚡️ 关键：转发 (Flood) ⚡️
      // 规则：转发给所有连接，但【排除】发送给我的那个人
      this.broadcast(d, fromId);
    }
  },

  // 发送/转发函数
  broadcast(packet, excludeId = null) {
    Object.keys(this.conns).forEach(pid => {
      if (pid === excludeId) return; // 绝不发回来源
      const conn = this.conns[pid];
      if (conn && conn.open) {
        try { conn.send(packet); } catch(e){}
      }
    });
  },

  sendText(txt) {
    if(!txt) return;
    const id = Date.now() + '-' + Math.random().toString(36).substr(2,5);
    const packet = { t: 'MSG', id: id, txt: txt, sender: this.myName };
    
    // 自己也要记录指纹，防止回路回来
    this.seen.add(id);
    
    // UI 显示
    ui.appendMsg('我', txt, true);
    
    // 发送给所有人
    this.broadcast(packet, null);
  },

  cleanup() {
    // 移除已断开的连接对象
    Object.keys(this.conns).forEach(pid => {
      if(!this.conns[pid].open) delete this.conns[pid];
    });
    // 没连上主节点？重试
    if(!this.isMaster && !this.conns[MASTER_ID]) {
      this.connectTo(MASTER_ID);
    }
    ui.renderList();
  },
  
  // 简易文件发送 (直连)
  sendFile(file, targetId) {
    // 暂略，确保聊天先通
    alert('当前版本优先保证聊天稳定，请先测试文字');
  }
};

// ===================== UI =====================
const ui = {
  init() {
    document.getElementById('btnSend').onclick = () => {
      const el = document.getElementById('editor');
      app.sendText(el.innerText);
      el.innerText = '';
    };
    
    // 侧边栏
    document.getElementById('btnBack').onclick = () => {
      document.getElementById('sidebar').classList.remove('hidden');
    };
    
    // 初始状态
    this.updateSelf();
    this.renderList();
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('statusText').innerText = app.isMaster ? '👑 主机' : '在线';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  // 实时重新渲染列表 (修复虚节点)
  renderList() {
    const list = document.getElementById('contactList');
    list.innerHTML = `
      <div class="contact-item active" onclick="ui.toggleSidebar()">
        <div class="avatar" style="background:#2a7cff">全</div>
        <div class="c-info"><div class="c-name">公共频道</div><div class="c-msg">全员广播</div></div>
      </div>
    `;
    
    const count = Object.keys(app.conns).length;
    document.getElementById('onlineCount').innerText = count + ' 连接';

    Object.keys(app.conns).forEach(pid => {
      const c = app.conns[pid];
      const name = c.label || pid.slice(0,6);
      const isMaster = (pid === MASTER_ID);
      
      list.innerHTML += `
        <div class="contact-item">
          <div class="avatar" style="background:${isMaster?'#ff9f00':'#333'}">${name[0]}</div>
          <div class="c-info">
            <div class="c-name">${name} ${isMaster?'(主机)':''}</div>
            <div class="c-msg">ID: ${pid.slice(0,6)}</div>
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