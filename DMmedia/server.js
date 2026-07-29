const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8081;
const ROOT = __dirname;

// ===== PostgreSQL/PostGIS 连接池 =====

// ===== 存储配置 =====
const CONFIG_PATH = path.join(ROOT, 'storage-config.json');
const DEFAULT_PATHS = {
  music:    { dir: './music',    scanType: 'flatWithSubdirs', exts: ['.mp3','.wav','.flac','.ogg','.aac','.m4a'] },
  video:    { dir: './video',    scanType: 'flatWithSubdirs', exts: ['.mp4','.webm','.mkv','.mov','.avi','.flv','.wmv'] },
  tvdrama:  { dir: './tvdrama',  scanType: 'series',         exts: ['.mp4','.webm','.mkv','.mov','.avi'] },
  album:    { dir: './album',    scanType: 'album',          exts: [] },
  book:     { dir: './book',     scanType: 'flatWithSubdirs', exts: ['.txt','.epub'] },
  pdf:      { dir: './pdf',      scanType: 'flat',           exts: ['.pdf'] },
  audio:    { dir: './Audio',    scanType: 'flatWithSubdirs', exts: ['.mp3','.wav','.flac','.ogg','.aac','.m4a'] },
  geodata:  { dir: './geodata',  scanType: 'geodata',        exts: [] }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const merged = {};
      for (const key of Object.keys(DEFAULT_PATHS)) {
        merged[key] = { ...DEFAULT_PATHS[key], ...(raw.paths?.[key] || {}) };
      }
      return { paths: merged, siteName: raw.siteName || '杨鑫瑞资料合集' };
    }
  } catch (e) { console.error('Failed to load config, using defaults:', e.message); }
  return { paths: { ...DEFAULT_PATHS }, siteName: '杨鑫瑞资料合集' };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function resolveDir(cfgEntry) {
  if (!cfgEntry || !cfgEntry.dir) return ROOT;
  const d = cfgEntry.dir;
  if (path.isAbsolute(d)) return d;
  return path.resolve(ROOT, d);
}

let config = loadConfig();

// 虚拟挂载点映射：URL 前缀 → 实际目录解析函数
const MEDIA_MOUNTS = {
  '/media/music/':    () => resolveDir(config.paths.music),
  '/media/video/':    () => resolveDir(config.paths.video),
  '/media/tvdrama/':  () => resolveDir(config.paths.tvdrama),
  '/media/album/':    () => resolveDir(config.paths.album),
  '/media/book/':     () => resolveDir(config.paths.book),
  '/media/pdf/':      () => resolveDir(config.paths.pdf),
  '/media/audio/':    () => resolveDir(config.paths.audio),
  '/media/geodata/':  () => resolveDir(config.paths.geodata),
};

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript',
  '.css':'text/css','.json':'application/json',
  '.mp3':'audio/mpeg','.mp4':'video/mp4','.wav':'audio/wav','.flac':'audio/flac',
  '.ogg':'audio/ogg','.aac':'audio/aac','.m4a':'audio/mp4',
  '.webm':'video/webm','.mkv':'video/mp4','.mov':'video/quicktime',
  '.avi':'video/x-msvideo','.flv':'video/x-flv','.wmv':'video/x-ms-wmv',
  '.txt':'text/plain','.pdf':'application/pdf',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
  '.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp',
};

// ===== 带缓存的扫描器 =====
// 缓存结构: { 'music': { mtime: 1234567890, data: [...] } }
const cache = {};

// 获取目录的最新修改时间（快速判断是否有变化）
// 递归获取目录及其所有子目录的最新修改时间
function getDirMtime(dirPath) {
  try {
    let latest = 0;
    const stack = [dirPath];
    while (stack.length) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > latest) latest = stat.mtimeMs;
        if (entry.isDirectory()) {
          stack.push(fullPath);
        }
      }
    }
    return latest;
  } catch (e) { return 0; }
}

// 通用的无缓存响应头（用于合并到 writeHead）
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};

function scanWithCache(dir, exts, cacheKey, subdirs, mediaPrefix) {
  const now = getDirMtime(dir);

  // 如果缓存存在且目录没变化，直接返回缓存
  if (cache[cacheKey] && cache[cacheKey].mtime === now) {
    return cache[cacheKey].data;
  }

  // 否则重新扫描（递归：subdirs 为真时深入任意层级子目录，支持如 歌手/专辑/曲目.mp3）
  const items = [];
  function walk(currentDir) {
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const f of entries) {
      const full = path.join(currentDir, f.name);
      if (f.isFile() && exts.some(e => f.name.toLowerCase().endsWith(e))) {
        const relFromBase = path.relative(dir, full).replace(/\\/g, '/');
        const rel = mediaPrefix
          ? (mediaPrefix + relFromBase)
          : path.relative(ROOT, full).replace(/\\/g, '/');
        // artist 取第一层子目录名（如 歌手/专辑/曲目.mp3 → artist=歌手）
        const artist = relFromBase.includes('/') ? relFromBase.split('/')[0] : '';
        items.push({ name: f.name, artist, file: rel });
      } else if (subdirs && f.isDirectory()) {
        walk(path.join(currentDir, f.name));
      }
    }
  }
  try { walk(dir); } catch (e) {}

  // 写入缓存
  cache[cacheKey] = { mtime: now, data: items };

  // 同时写 JSON 文件到磁盘（供浏览器直接读取）
  try { fs.writeFileSync(path.join(ROOT, cacheKey + '.json'), JSON.stringify(items)); } catch(e) {}

  return items;
}

function scanSeriesWithCache() {
  const cfg = config.paths.tvdrama;
  const dir = resolveDir(cfg);
  const mediaPrefix = 'media/tvdrama/';
  const now = getDirMtime(dir);
  
  if (cache['tvdrama-list'] && cache['tvdrama-list'].mtime === now) {
    return cache['tvdrama-list'].data;
  }

  const series = [];
  const natSort = function(a, b) {
    var na = a.title ? a.title.match(/\d+/g) : a.name.match(/\d+/g);
    var nb = b.title ? b.title.match(/\d+/g) : b.name.match(/\d+/g);
    if (na && nb) {
      for (var i = 0; i < Math.min(na.length, nb.length); i++) {
        var diff = parseInt(na[i]) - parseInt(nb[i]);
        if (diff !== 0) return diff;
      }
      return na.length - nb.length;
    }
    return (a.title || a.name).localeCompare((b.title || b.name), 'zh');
  };

  // 递归：任意层级含视频的文件夹 = 一个剧集（支持 剧名/第1季/第1集 这类多层结构）
  function walk(currentDir) {
    const eps = [];
    const subDirs = [];
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        subDirs.push(entry.name);
      } else if (entry.isFile() && cfg.exts.some(e => entry.name.toLowerCase().endsWith(e))) {
        eps.push({ title: entry.name.replace(/\.\w+$/, ''), file: mediaPrefix + path.relative(dir, full).replace(/\\/g, '/') });
      }
    }
    eps.sort(natSort);
    if (eps.length) {
      const relPath = path.relative(dir, currentDir).replace(/\\/g, '/');
      const name = relPath === '' ? '未分类' : relPath;
      const id = 's_' + (relPath === '' ? 'unsorted' : relPath.replace(/[\/\\]/g, '_'));
      series.push({ id, name, episodes: eps });
    }
    subDirs.sort((a, b) => a.localeCompare(b, 'zh'));
    for (const sd of subDirs) walk(path.join(currentDir, sd));
  }

  try { walk(dir); } catch(e) {}

  cache['tvdrama-list'] = { mtime: now, data: series };
  try { fs.writeFileSync(path.join(ROOT, 'tvdrama-list.json'), JSON.stringify({ series })); } catch(e) {}
  return series;
}

// album 写真馆：扫描 album 目录，每个子文件夹作为一个相册
// 同时支持根目录直接放图片/视频（归类为「默认相册」）
// 返回 { name, photos: [...], videos: [...] }
function scanAlbumWithCache() {
  const cfg = config.paths.album;
  const dir = resolveDir(cfg);
  const mediaPrefix = 'media/album/';
  const now = getDirMtime(dir);

  if (cache['album-list'] && cache['album-list'].mtime === now) {
    return cache['album-list'].data;
  }

  const IMG_EXTS = ['.jpg','.jpeg','.png','.gif','.webp','.bmp','.svg'];
  const VID_EXTS = ['.mp4','.webm','.mkv','.mov','.avi'];
  const albums = [];

  // 自然排序
  const natSort = (a, b) => {
    const na = a.name.match(/\d+/g), nb = b.name.match(/\d+/g);
    if (na && nb) {
      for (let i = 0; i < Math.min(na.length, nb.length); i++) {
        const diff = parseInt(na[i]) - parseInt(nb[i]);
        if (diff !== 0) return diff;
      }
      return na.length - nb.length;
    }
    return a.name.localeCompare(b.name, 'zh');
  };

  // 递归扫描：任意层级的文件夹，只要含图片/视频就成为一个独立相册
  // （相册名 = 相对于 album 根目录的相对路径，如「旅行/2024」；根目录散图归「默认相册」）
  function walk(currentDir) {
    const photos = [], videos = [];
    const subDirs = [];
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(currentDir, e.name);
      if (e.isDirectory()) {
        subDirs.push(e.name);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        const rel = mediaPrefix + path.relative(dir, full).replace(/\\/g, '/');
        if (IMG_EXTS.includes(ext)) {
          photos.push({ name: e.name, file: rel });
        } else if (VID_EXTS.includes(ext)) {
          videos.push({ name: e.name, file: rel });
        }
      }
    }
    photos.sort(natSort);
    videos.sort(natSort);
    if (photos.length || videos.length) {
      const relPath = path.relative(dir, currentDir).replace(/\\/g, '/');
      albums.push({ name: relPath === '' ? '默认相册' : relPath, photos, videos });
    }
    subDirs.sort((a, b) => a.localeCompare(b, 'zh'));
    for (const sd of subDirs) walk(path.join(currentDir, sd));
  }

  try { walk(dir); } catch (e) {}

  cache['album-list'] = { mtime: now, data: albums };
  try { fs.writeFileSync(path.join(ROOT, 'album-list.json'), JSON.stringify(albums)); } catch(e) {}
  return albums;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let reqPath = decodeURIComponent(url.pathname);

  // JSON 请求 → 缓存扫描（每次请求都检查 mtime，变化时重新扫描）
  if (reqPath === '/music-list.json') {
    const cfg = config.paths.music;
    const data = scanWithCache(resolveDir(cfg), cfg.exts, 'music-list', true, 'media/music/');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
    return res.end(JSON.stringify(data));
  }
  if (reqPath === '/book-list.json') {
    const cfg = config.paths.book;
    const data = scanWithCache(resolveDir(cfg), cfg.exts, 'book-list', true, 'media/book/');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
    return res.end(JSON.stringify(data));
  }
  if (reqPath === '/pdf-list.json') {
    const cfg = config.paths.pdf;
    const data = scanWithCache(resolveDir(cfg), cfg.exts, 'pdf-list', false, 'media/pdf/');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
    return res.end(JSON.stringify(data));
  }
  if (reqPath === '/audio-list.json') {
    const cfg = config.paths.audio;
    const data = scanWithCache(resolveDir(cfg), cfg.exts, 'audio-list', true, 'media/audio/');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
    return res.end(JSON.stringify(data));
  }
  if (reqPath === '/tvdrama-list.json') {
    const data = scanSeriesWithCache();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
    return res.end(JSON.stringify({ series: data }));
  }
  if (reqPath === '/video-list.json') {
    const cfg = config.paths.video;
    const data = scanWithCache(resolveDir(cfg), cfg.exts, 'video-list', true, 'media/video/');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
    return res.end(JSON.stringify(data));
  }
  if (reqPath === '/album-list.json') {
    const data = scanAlbumWithCache();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
    return res.end(JSON.stringify(data));
  }

  // GET /api/browse → 浏览目录
  if (reqPath === '/api/browse' && req.method === 'GET') {
    const browsePath = url.searchParams.get('path') || ROOT;
    const resolved = path.isAbsolute(browsePath) ? browsePath : path.resolve(ROOT, browsePath);
    try {
      const parent = resolved === '/' ? null : path.dirname(resolved);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = [];
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) {
          dirs.push({ name: e.name, path: path.join(resolved, e.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ current: resolved, parent, dirs, root: ROOT }));
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // GET /api/config → 返回存储配置
  if (reqPath === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const view = {};
    for (const [k, v] of Object.entries(config.paths)) {
      view[k] = { dir: v.dir, scanType: v.scanType, resolved: resolveDir(v) };
    }
    return res.end(JSON.stringify({ paths: view, root: ROOT, siteName: config.siteName || '杨鑫瑞资料合集' }));
  }

  // POST /api/config → 更新存储配置
  if (reqPath === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        if (typeof update.siteName === 'string' && update.siteName.trim()) {
          config.siteName = update.siteName.trim();
        }
        for (const [key, entry] of Object.entries(update.paths || {})) {
          if (!DEFAULT_PATHS[key]) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: false, error: 'Unknown media type: ' + key }));
          }
          if (!entry.dir || typeof entry.dir !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: false, error: 'Invalid dir for ' + key }));
          }
          const resolved = path.isAbsolute(entry.dir) ? entry.dir : path.resolve(ROOT, entry.dir);
          if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: false, error: key + ': path exists but is not a directory' }));
          }
          config.paths[key] = { ...DEFAULT_PATHS[key], ...entry, dir: entry.dir };
        }
        saveConfig(config);
        Object.keys(cache).forEach(k => delete cache[k]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 辅助函数
  function sendError(res, code, msg) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: msg }));
  }

  function serveFile(filePath, res) {
    fs.stat(filePath, (err, stat) => {
      if (err) {
        if (err.code === 'ENOENT') { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(500); return res.end('Server Error');
      }
      if (stat.isDirectory()) {
        return fs.readFile(path.join(filePath, 'index.html'), (err2, data2) => {
          if (err2) { res.writeHead(404); return res.end('Not Found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'], ...NO_CACHE_HEADERS });
          res.end(data2);
        });
      }

      const ext = path.extname(filePath);
      const mimeType = MIME[ext] || 'application/octet-stream';
      const total = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        const chunkSize = (end - start) + 1;

        if (start >= total || end >= total) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + total });
          return res.end();
        }

        const stream = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
        });
        stream.pipe(res);
      } else {
        const extraHeaders = ext === '.html' ? NO_CACHE_HEADERS : { 'Accept-Ranges': 'bytes' };
        res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': total, ...extraHeaders });
        fs.createReadStream(filePath).pipe(res);
      }
    });
  }

  // ====== GET /api/ip → 获取本机 IP ======
  if (reqPath === '/api/ip' && req.method === 'GET') {
    const os = require('os');
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) ips.push({ iface: name, ip: net.address });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ips, hostname: os.hostname(), port: PORT }));
    return;
  }

  // 静态文件（支持 Range 请求，视频播放必需）
  if (reqPath === '/') reqPath = '/index.html';

  // 检查虚拟挂载点：URL 如 /media/music/xxx → 映射到实际路径
  for (const [prefix, getDir] of Object.entries(MEDIA_MOUNTS)) {
    if (reqPath.startsWith('/' + prefix) || reqPath.startsWith(prefix)) {
      const realDir = getDir();
      const relativePart = reqPath.slice(prefix.length);
      const realPath = path.join(realDir, relativePart);
      // 安全检查：确保解析后的路径在挂载目录内
      if (path.normalize(realPath).startsWith(path.normalize(realDir) + path.sep) || path.normalize(realPath) === path.normalize(realDir)) {
        return serveFile(realPath, res);
      }
      res.writeHead(403); return res.end('Forbidden');
    }
  }

  const filePath = path.join(ROOT, reqPath);
  
  // 安全检查：防止目录穿越
  if (path.normalize(filePath).indexOf(path.normalize(ROOT)) !== 0) {
    res.writeHead(403); return res.end('Forbidden');
  }

  serveFile(filePath, res);
});

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const { execSync } = require('child_process');
  let ips = [];

  // 方式1: Node.js API
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address !== '127.0.0.1') {
        ips.push(iface.address);
      }
    }
  }

  // 方式2: 如果 Node.js API 没拿到，尝试系统命令
  if (ips.length === 0) {
    try {
      const out = execSync('ip addr show 2>/dev/null || ifconfig 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
      const matches = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/g) || [];
      for (const m of matches) {
        const ip = m.replace('inet ', '');
        if (ip !== '127.0.0.1' && !ips.includes(ip)) ips.push(ip);
      }
    } catch(_) {}
  }

  // 方式3: 兜底
  if (ips.length === 0) ips.push('0.0.0.0');

  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║     DMmedia 媒体与网盘                 ║');
  for (const ip of ips) {
    const url = 'http://' + ip + ':' + PORT;
    console.log('  ║     ' + url + ' '.repeat(34 - url.length) + '║');
  }
  console.log('  ║                                      ║');
  console.log('  ║  开机自启: systemctl enable dm-page   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
