const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8083;
const ROOT = __dirname;

// 视频上传目录
const VIDEO_DIR = path.join(ROOT, 'videos');
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

// 文件上传目录
const FILES_DIR = path.join(ROOT, 'files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// MD 文件存储
const MD_DIR = path.join(ROOT, 'mdfiles');
if (!fs.existsSync(MD_DIR)) fs.mkdirSync(MD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

// ===== 账号系统 =====
const crypto = require('crypto');
const USERS_FILE = path.join(ROOT, 'users.json');
const INVITES_FILE = path.join(ROOT, 'invites.json');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function loadUsers() {
  try { if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (_) {}
  return {};
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

function loadInvites() {
  try { if (fs.existsSync(INVITES_FILE)) return JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8')); } catch (_) {}
  return {};
}
function saveInvites(i) { fs.writeFileSync(INVITES_FILE, JSON.stringify(i, null, 2)); }

let users = loadUsers();
let invites = loadInvites();

// 没有管理员时生成初始邀请码
if (Object.keys(invites).length === 0) {
  const code = 'admin' + Math.random().toString(36).slice(2, 8);
  invites[code] = { used: false, createdBy: 'system', createdAt: Date.now() };
  saveInvites(invites);
}

// token → userId
const tokens = new Map();
const ctJson = { 'Content-Type': 'application/json; charset=utf-8' };

// ===== WebSocket 服务器 =====
const { WebSocketServer } = require('ws');

const clients = new Map(); // ws → { id, name, time }

// ===== 轮麦系统 =====
const SPEAK_TIME = 180000;
let speakQueue = [];
let currentSpeaker = null;
let speakerTimer = null;
let speakerStartTime = 0;

// ===== 一起看视频 =====
let videoOwner = null;       // 房主 ID
let videoUrl = '';           // 当前视频 URL
let videoState = 'pause';    // play | pause
let videoTime = 0;           // 当前进度（秒）
let videoIsPlatform = false; // 是否是平台链接
let videoIsScreenShare = false; // 是否是投屏
let videoOwnerName = '';     // 房主名字
let videoSyncTime = 0;       // 最后同步时间戳

function broadcast(data, excludeWs) {
  const msg = JSON.stringify(data);
  for (const [ws, info] of clients) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function getUserList() {
  return [...clients.values()].map(c => ({ id: c.id, name: c.name }));
}

function sendTo(userId, data) {
  for (const [ws, info] of clients) {
    if (info.id === userId && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
      return;
    }
  }
}

function startNextSpeaker() {
  clearTimeout(speakerTimer);
  if (currentSpeaker) {
    sendTo(currentSpeaker, { type: 'speak-end' });
    broadcastAll({ type: 'speaker-changed', currentSpeaker: null, queue: speakQueue });
  }
  currentSpeaker = null;
  if (speakQueue.length === 0) return;
  currentSpeaker = speakQueue.shift();
  speakerStartTime = Date.now();
  sendTo(currentSpeaker, { type: 'speak-start', duration: SPEAK_TIME });
  broadcastAll({ type: 'speaker-changed', currentSpeaker, queue: [...speakQueue], startTime: speakerStartTime });
  speakerTimer = setTimeout(() => {
    broadcastAll({ type: 'system-msg', text: getSpeakerName() + ' 发言时间到，自动下麦' });
    startNextSpeaker();
  }, SPEAK_TIME);
}

function getSpeakerName() {
  if (!currentSpeaker) return '';
  for (const [ws, info] of clients) {
    if (info.id === currentSpeaker) return info.name;
  }
  return '';
}

// ===== HTTP 服务器 =====
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let reqPath = decodeURIComponent(url.pathname);

  // === 注册 ===
  if (reqPath === '/api/register' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, password, invite } = JSON.parse(body);
        if (!name || !password || !invite) { res.writeHead(400, ctJson); return res.end(JSON.stringify({ error: '缺少参数' })); }
        if (name.length > 20 || name.length < 1) { res.writeHead(400, ctJson); return res.end(JSON.stringify({ error: '昵称1-20字符' })); }
        if (password.length < 4) { res.writeHead(400, ctJson); return res.end(JSON.stringify({ error: '密码至少4位' })); }
        if (Object.values(users).find(u => u.name === name)) { res.writeHead(400, ctJson); return res.end(JSON.stringify({ error: '昵称已被注册' })); }
        const inv = invites[invite];
        if (!inv) { res.writeHead(400, ctJson); return res.end(JSON.stringify({ error: '邀请码无效' })); }
        if (inv.used) { res.writeHead(400, ctJson); return res.end(JSON.stringify({ error: '邀请码已被使用' })); }

        const userId = 'u' + Date.now().toString(36);
        const isAdmin = Object.keys(users).length === 0;
        users[userId] = { name, password: sha256(password), isAdmin, createdAt: Date.now() };
        invites[invite].used = true;
        invites[invite].usedBy = userId;
        saveUsers(users); saveInvites(invites);

        const token = crypto.randomBytes(16).toString('hex');
        tokens.set(token, userId);
        res.writeHead(200, ctJson);
        res.end(JSON.stringify({ ok: true, token, userId, name, isAdmin }));
      } catch (e) {
        res.writeHead(400, ctJson); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === 登录 ===
  if (reqPath === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, password } = JSON.parse(body);
        const user = Object.entries(users).find(([id, u]) => u.name === name);
        if (!user || user[1].password !== sha256(password)) {
          res.writeHead(401, ctJson); return res.end(JSON.stringify({ error: '昵称或密码错误' }));
        }
        const token = crypto.randomBytes(16).toString('hex');
        tokens.set(token, user[0]);
        res.writeHead(200, ctJson);
        res.end(JSON.stringify({ ok: true, token, userId: user[0], name: user[1].name, isAdmin: user[1].isAdmin }));
      } catch (e) {
        res.writeHead(400, ctJson); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === 管理员：用户列表 ===
  if (reqPath === '/api/users' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const adminId = tokens.get(token);
    if (!adminId || !users[adminId] || !users[adminId].isAdmin) { res.writeHead(403, ctJson); return res.end(JSON.stringify({ error: '无权限' })); }
    res.writeHead(200, ctJson);
    res.end(JSON.stringify(Object.entries(users).map(([id, u]) => ({ id, name: u.name, isAdmin: u.isAdmin, createdAt: u.createdAt }))));
    return;
  }

  // === 邀请码管理 ===
  if (reqPath === '/api/invites' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const userId = tokens.get(token);
    const user = users[userId];
    if (!user || !user.isAdmin) { res.writeHead(403, ctJson); return res.end(JSON.stringify({ error: '无权限' })); }
    res.writeHead(200, ctJson);
    res.end(JSON.stringify(Object.entries(invites).map(([code, info]) => ({ code, used: info.used, usedBy: info.usedBy ? users[info.usedBy]?.name : null }))));
    return;
  }

  if (reqPath === '/api/invites' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body);
        const userId = tokens.get(token);
        const user = users[userId];
        if (!user || !user.isAdmin) { res.writeHead(403, ctJson); return res.end(JSON.stringify({ error: '无权限' })); }
        const code = 'dm' + Math.random().toString(36).slice(2, 8);
        invites[code] = { used: false, createdBy: userId, createdAt: Date.now() };
        saveInvites(invites);
        res.writeHead(200, ctJson);
        res.end(JSON.stringify({ ok: true, code }));
      } catch (e) { res.writeHead(400, ctJson); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (reqPath === '/api/invites' && req.method === 'DELETE') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { token, code } = JSON.parse(body);
        const userId = tokens.get(token);
        const user = users[userId];
        if (!user || !user.isAdmin) { res.writeHead(403, ctJson); return res.end(JSON.stringify({ error: '无权限' })); }
        const inv = invites[code];
        if (!inv) { res.writeHead(404, ctJson); return res.end(JSON.stringify({ error: '邀请码不存在' })); }
        // 若已被使用, 连被邀请人一起删除
        if (inv.used && inv.usedBy) {
          const targetId = inv.usedBy;
          delete users[targetId];
          for (const [t, uid] of tokens) { if (uid === targetId) tokens.delete(t); }
        }
        delete invites[code];
        saveUsers(users); saveInvites(invites);
        res.writeHead(200, ctJson);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, ctJson); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // === 管理员：删除用户 ===
  if (reqPath === '/api/delete-user' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { token, userId: targetId } = JSON.parse(body);
        const adminId = tokens.get(token);
        const admin = users[adminId];
        if (!admin || !admin.isAdmin) { res.writeHead(403, ctJson); return res.end(JSON.stringify({ error: '无权限' })); }
        if (targetId === adminId) { res.writeHead(400, ctJson); return res.end(JSON.stringify({ error: '不能删除自己' })); }
        if (!users[targetId]) { res.writeHead(404, ctJson); return res.end(JSON.stringify({ error: '用户不存在' })); }
        delete users[targetId];
        // 清除该用户的 token
        for (const [t, uid] of tokens) { if (uid === targetId) tokens.delete(t); }
        saveUsers(users);
        res.writeHead(200, ctJson);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, ctJson); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // === 视频上传 ===
  if (reqPath === '/api/upload-video' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      let filename = 'video_' + Date.now() + '.mp4';
      let fileData = buffer;

      if (boundaryMatch) {
        const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '');
        const boundaryBuf = Buffer.from('--' + boundary, 'latin1');
        const crlfcrlf = Buffer.from('\r\n\r\n', 'latin1');
        const firstB = buffer.indexOf(boundaryBuf);
        if (firstB !== -1) {
          const hStart = firstB + boundaryBuf.length + 2;
          const hEnd = buffer.indexOf(crlfcrlf, hStart);
          if (hEnd !== -1) {
            const hStr = buffer.subarray(hStart, hEnd).toString('latin1');
            const fnMatch = hStr.match(/filename="([^"]+)"/);
            if (fnMatch) filename = fnMatch[1].replace(/[\\/:*?"<>|]/g, '_');
            const cStart = hEnd + 4;
            const nextB = buffer.indexOf(boundaryBuf, cStart);
            fileData = nextB !== -1 ? buffer.subarray(cStart, nextB - 2) : buffer.subarray(cStart);
          }
        }
      }

      const safeName = Date.now() + '_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(VIDEO_DIR, safeName);
      fs.writeFileSync(filePath, fileData);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, url: '/videos/' + safeName, name: filename }));
    });
    return;
  }

  // === 文件上传（图片/文档/PDF/MD） ===
  if (reqPath === '/api/upload-file' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      let filename = 'file_' + Date.now();
      let fileData = buffer;
      if (boundaryMatch) {
        const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '');
        const boundaryBuf = Buffer.from('--' + boundary, 'latin1');
        const crlfcrlf = Buffer.from('\r\n\r\n', 'latin1');
        const firstB = buffer.indexOf(boundaryBuf);
        if (firstB !== -1) {
          const hStart = firstB + boundaryBuf.length + 2;
          const hEnd = buffer.indexOf(crlfcrlf, hStart);
          if (hEnd !== -1) {
            const hStr = buffer.subarray(hStart, hEnd).toString('latin1');
            const fnMatch = hStr.match(/filename="([^"]+)"/);
            if (fnMatch) filename = fnMatch[1].replace(/[\\/:*?"<>|]/g, '_');
            const cStart = hEnd + 4;
            const nextB = buffer.indexOf(boundaryBuf, cStart);
            fileData = nextB !== -1 ? buffer.subarray(cStart, nextB - 2) : buffer.subarray(cStart);
          }
        }
      }
      const ext = path.extname(filename).toLowerCase();
      const safeName = Date.now() + '_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      let subDir = FILES_DIR;
      if (ext === '.md') subDir = MD_DIR;
      const fp = path.join(subDir, safeName);
      fs.writeFileSync(fp, fileData);
      const furl = (subDir === MD_DIR ? '/mdfiles/' : '/files/') + safeName;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, url: furl, name: filename, size: fileData.length, ext }));
    });
    return;
  }

  // === MD 保存 ===
  if (reqPath === '/api/save-md' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { path: mdPath, content } = JSON.parse(body);
        const fp = path.join(ROOT, mdPath);
        if (path.normalize(fp).indexOf(path.normalize(MD_DIR)) !== 0) {
          res.writeHead(403); return res.end('Forbidden');
        }
        fs.writeFileSync(fp, content, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // === 视频/文件静态托管 ===
  if (reqPath.startsWith('/videos/') || reqPath.startsWith('/files/') || reqPath.startsWith('/mdfiles/')) {
    const vPath = path.join(ROOT, reqPath);
    if (path.normalize(vPath).indexOf(path.normalize(ROOT)) !== 0) {
      res.writeHead(403); return res.end('Forbidden');
    }
    const ext = path.extname(vPath).toLowerCase();
    const mimeType = MIME[ext] || 'application/octet-stream';
    fs.stat(vPath, (err, stat) => {
      if (err) { res.writeHead(404); return res.end('Not Found'); }
      // 支持 Range（视频拖动必需）
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
        });
        fs.createReadStream(vPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(vPath).pipe(res);
      }
    });
    return;
  }

  if (reqPath === '/') reqPath = '/index.html';

  const filePath = path.join(ROOT, reqPath);
  if (path.normalize(filePath).indexOf(path.normalize(ROOT)) !== 0) {
    res.writeHead(403); return res.end('Forbidden');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
});

// ===== WebSocket =====
const wss = new WebSocketServer({ server });
let nextId = 1;

wss.on('connection', (ws) => {
  const userId = 'u' + (nextId++);
  const info = { id: userId, name: '', time: Date.now() };
  clients.set(ws, info);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (msg.type) {
      case 'join':
        // 校验 token
        const uid = tokens.get(msg.token);
        if (!uid || !users[uid]) {
          ws.send(JSON.stringify({ type: 'auth-error', error: '请重新登录' }));
          ws.close();
          break;
        }
        info.id = uid;
        info.name = users[uid].name;
        info.isAdmin = users[uid].isAdmin;
        info.time = Date.now();
        ws.send(JSON.stringify({
          type: 'welcome',
          userId: info.id,
          name: info.name,
          isAdmin: info.isAdmin,
          users: getUserList(),
          queue: speakQueue,
          currentSpeaker,
          speakerStartTime,
          videoOwner,
          videoUrl,
          videoState,
          videoTime,
          videoIsPlatform,
          videoIsScreenShare,
          videoOwnerName,
        }));
        broadcast({ type: 'user-join', user: { id: info.id, name: info.name } }, ws);
        break;

      case 'chat':
        broadcastAll({
          type: 'chat', from: info.id, fromName: info.name,
          text: (msg.text || '').slice(0, 2000), time: Date.now(),
        });
        break;

      // --- 轮麦 ---
      case 'request-speak':
        if (currentSpeaker === info.id) { ws.send(JSON.stringify({ type: 'system-msg', text: '你已经在发言中了' })); break; }
        if (speakQueue.includes(info.id)) { ws.send(JSON.stringify({ type: 'system-msg', text: '你已经在排队中了' })); break; }
        speakQueue.push(info.id);
        broadcastAll({ type: 'queue-updated', queue: [...speakQueue], currentSpeaker });
        broadcastAll({ type: 'system-msg', text: info.name + ' 🙋 举手排队，当前排队 ' + speakQueue.length + ' 人' });
        if (!currentSpeaker) startNextSpeaker();
        break;

      case 'cancel-speak':
        speakQueue = speakQueue.filter(id => id !== info.id);
        broadcastAll({ type: 'queue-updated', queue: [...speakQueue], currentSpeaker });
        broadcastAll({ type: 'system-msg', text: info.name + ' 取消了排队' });
        break;

      case 'speak-end':
        if (currentSpeaker === info.id) {
          broadcastAll({ type: 'system-msg', text: info.name + ' 主动下麦' });
          startNextSpeaker();
        }
        break;

      // --- 一起看视频 ---
      case 'video-load':
        // 只有房主能加载新视频（或当前没房主时抢占）
        if (videoOwner && videoOwner !== info.id) {
          ws.send(JSON.stringify({ type: 'system-msg', text: '只有房主可以切换视频' }));
          break;
        }
        videoOwner = info.id;
        videoUrl = msg.url || '';
        videoState = 'pause';
        videoTime = 0;
        videoIsPlatform = msg.isPlatform || false;
        videoIsScreenShare = msg.isScreenShare || false;
        videoOwnerName = info.name;
        videoSyncTime = Date.now();
        broadcastAll({
          type: 'video-sync', action: 'load',
          url: videoUrl, owner: videoOwner,
          ownerName: info.name,
          isPlatform: msg.isPlatform || false,
          isScreenShare: msg.isScreenShare || false,
        });
        broadcastAll({ type: 'system-msg', text: info.name + ' 🎬 发起了「一起看视频」' });
        break;

      case 'video-play':
        if (videoOwner !== info.id) break;
        videoState = 'play';
        videoTime = msg.time || 0;
        videoSyncTime = Date.now();
        broadcast({ type: 'video-sync', action: 'play', time: videoTime }, ws);
        break;

      case 'video-pause':
        if (videoOwner !== info.id) break;
        videoState = 'pause';
        videoTime = msg.time || 0;
        videoSyncTime = Date.now();
        broadcast({ type: 'video-sync', action: 'pause', time: videoTime }, ws);
        break;

      case 'video-seek':
        if (videoOwner !== info.id) break;
        videoTime = msg.time || 0;
        videoSyncTime = Date.now();
        broadcast({ type: 'video-sync', action: 'seek', time: videoTime }, ws);
        break;

      case 'video-end':
        if (videoOwner === info.id) {
          videoOwner = null;
          videoUrl = '';
          videoState = 'pause';
          videoTime = 0;
          videoIsPlatform = false;
          videoIsScreenShare = false;
          videoOwnerName = '';
          broadcastAll({ type: 'video-sync', action: 'end' });
          broadcastAll({ type: 'system-msg', text: info.name + ' 结束了一起看视频' });
        }
        break;

      // --- Canvas 帧广播（房主截屏发给观众）---
      case 'video-frame':
        if (videoOwner !== info.id) break;
        broadcast({ type: 'video-frame', data: msg.data }, ws);
        break;

      // --- MD 协作编辑 ---
      case 'md-open':
        broadcastAll({ type: 'md-open', path: msg.path, name: msg.name, from: info.id, fromName: info.name });
        break;
      case 'md-edit':
        broadcast({ type: 'md-edit', path: msg.path, content: msg.content, from: info.id, fromName: info.name }, ws);
        break;
      case 'md-close':
        broadcastAll({ type: 'md-close', path: msg.path, from: info.id, fromName: info.name });
        break;

      // --- WebRTC ---
      case 'call-offer':
      case 'call-answer':
      case 'call-ice':
        {
          const target = [...clients.keys()].find(cw => clients.get(cw).id === msg.target);
          if (target && target.readyState === 1) {
            target.send(JSON.stringify({ ...msg, from: info.id, fromName: info.name }));
          }
        }
        break;

      case 'call-hangup':
        {
          const ht = [...clients.keys()].find(cw => clients.get(cw).id === msg.target);
          if (ht && ht.readyState === 1) {
            ht.send(JSON.stringify({ type: 'call-hangup', from: info.id, fromName: info.name }));
          }
        }
        break;

      // --- 投屏信令 ---
      case 'screen-offer':
      case 'screen-answer':
      case 'screen-ice':
        {
          const target = [...clients.keys()].find(cw => clients.get(cw).id === msg.target);
          if (target && target.readyState === 1) {
            target.send(JSON.stringify({ ...msg, from: info.id, fromName: info.name }));
          }
        }
        break;
    }
  });

  ws.on('close', () => {
    speakQueue = speakQueue.filter(id => id !== info.id);
    if (currentSpeaker === info.id) {
      broadcastAll({ type: 'system-msg', text: info.name + ' 离开，自动下麦' });
      startNextSpeaker();
    }
    if (videoOwner === info.id) {
      videoOwner = null;
      videoUrl = '';
      videoIsPlatform = false;
      videoIsScreenShare = false;
      broadcastAll({ type: 'video-sync', action: 'end' });
      broadcastAll({ type: 'system-msg', text: info.name + ' 离开，一起看视频结束' });
    }
    if (info.name) {
      broadcastAll({ type: 'user-leave', user: { id: info.id, name: info.name }, queue: speakQueue, currentSpeaker });
    }
    clients.delete(ws);
  });

  ws.on('error', () => {});
});

// ===== 启动 =====
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const { execSync } = require('child_process');
  let ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address !== '127.0.0.1') ips.push(iface.address);
    }
  }
  if (ips.length === 0) {
    try {
      const out = execSync('ip addr show 2>/dev/null || ifconfig 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
      const matches = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/g) || [];
      for (const m of matches) {
        const ip = m.replace('inet ', '');
        if (ip !== '127.0.0.1' && !ips.includes(ip)) ips.push(ip);
      }
    } catch (_) {}
  }
  if (ips.length === 0) ips.push('0.0.0.0');
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║     💬 DMChat 多人聊天+一起看       ║');
  for (const ip of ips) {
    const u = 'http://' + ip + ':' + PORT;
    console.log('  ║     ' + u + ' '.repeat(34 - u.length) + '║');
  }
  console.log('  ║                                      ║');
  console.log('  ║  开机自启: systemctl enable dm-chat  ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
