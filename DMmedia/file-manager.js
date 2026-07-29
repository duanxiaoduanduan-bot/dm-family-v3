const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.FILE_PORT ? Number(process.env.FILE_PORT) : 8087;
const PAGE_DIR = __dirname;

// 快捷目录 / 自定义存储介质
const SHORTCUTS_PATH = path.join(PAGE_DIR, 'file-shortcuts.json');
const os = require('os');

// 安全检查：只禁止访问系统敏感目录，其余全部放行（含新增 U 盘/挂载点）
const FORBIDDEN = ['/proc', '/sys', '/dev'];

function isPathSafe(targetPath) {
  const rp = (() => { try { return fs.realpathSync(targetPath); } catch (_) { return path.resolve(targetPath); } })();
  // Windows 盘符路径放行
  if (/^[A-Za-z]:[\\/]/.test(rp) || /^[A-Za-z]:$/.test(rp)) return true;
  for (const fb of FORBIDDEN) {
    if (rp === fb || rp.startsWith(fb + path.sep)) return false;
  }
  return true;
}

function normalizeShortcut(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let p = String(entry.path || '').trim();
  if (!p) return null;
  // 历史兼容：path: "page" → 当前服务目录
  if (p === 'page' || p === '.' || p === './') p = PAGE_DIR;
  if (!path.isAbsolute(p) && !/^[A-Za-z]:[\\/]?/.test(p)) {
    p = path.resolve(PAGE_DIR, p);
  }
  p = path.resolve(p);
  const name = String(entry.name || path.basename(p) || p).trim() || p;
  const type = entry.type === 'storage' || entry.kind === 'storage' ? 'storage' : (entry.type || 'shortcut');
  return { name, path: p, type };
}

function resolveShortcutPath(p) {
  const n = normalizeShortcut({ name: '', path: p });
  return n ? n.path : path.resolve(String(p || PAGE_DIR));
}

// 读取快捷目录
function loadShortcuts() {
  try {
    if (fs.existsSync(SHORTCUTS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SHORTCUTS_PATH, 'utf8'));
      if (Array.isArray(saved) && saved.length > 0) {
        return saved.map(normalizeShortcut).filter(Boolean);
      }
    }
  } catch (_) {}
  return autoDiscover();
}

function autoDiscover() {
  const discovered = [];
  const candidates = [
    { name: '📁 当前目录', path: PAGE_DIR, type: 'shortcut' },
    { name: '🏠 用户目录', path: os.homedir(), type: 'shortcut' },
  ];

  const rootCandidates = [
    { name: '📦 /workspace', path: '/workspace' },
    { name: '🏠 /home', path: '/home' },
    { name: '🔧 /root', path: '/root' },
    { name: '📱 /storage', path: '/storage' },
    { name: '💾 /mnt', path: '/mnt' },
    { name: '📀 /media', path: '/media' },
    { name: '💿 /run/media', path: '/run/media' },
    { name: '📂 /opt', path: '/opt' },
    { name: '📊 /var', path: '/var' },
    { name: '🗂️ /srv', path: '/srv' },
  ];

  // Windows：把存在的盘符加入候选
  if (process.platform === 'win32') {
    for (let i = 67; i <= 90; i++) { // C-Z
      const letter = String.fromCharCode(i);
      const drive = letter + ':\\';
      try {
        if (fs.existsSync(drive)) {
          rootCandidates.push({
            name: (letter === 'C' ? '💻 ' : '💾 ') + letter + ':',
            path: drive,
            type: letter === 'C' ? 'shortcut' : 'storage',
          });
        }
      } catch (_) {}
    }
  }

  for (const c of candidates) {
    try { if (fs.existsSync(c.path)) discovered.push(normalizeShortcut(c)); } catch (_) {}
  }
  for (const c of rootCandidates) {
    if (discovered.find(d => d.path === path.resolve(c.path))) continue;
    try {
      if (fs.existsSync(c.path)) discovered.push(normalizeShortcut({ ...c, type: c.type || 'shortcut' }));
    } catch (_) {}
  }

  const cleaned = discovered.filter(Boolean);
  saveShortcuts(cleaned);
  return cleaned;
}

function saveShortcuts(data) {
  const list = (Array.isArray(data) ? data : []).map(normalizeShortcut).filter(Boolean);
  fs.writeFileSync(SHORTCUTS_PATH, JSON.stringify(list, null, 2), 'utf8');
  shortcuts = list;
  return list;
}

/** 新增一条存储介质 / 快捷目录（去重、校验可读） */
function addStorageEntry({ name, path: rawPath, type = 'storage' } = {}) {
  if (!rawPath || !String(rawPath).trim()) {
    return { ok: false, error: '请提供路径' };
  }
  const resolved = resolveShortcutPath(rawPath);
  if (!isPathSafe(resolved)) {
    return { ok: false, error: '禁止访问系统敏感目录' };
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return { ok: false, error: '路径不是目录' };
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (e) {
    return { ok: false, error: '目录不存在或不可读: ' + e.message };
  }

  // 盘符根目录 basename 可能为空，用 D: 这类标签
  let autoName = path.basename(resolved);
  if (!autoName || autoName === path.sep || /^[A-Za-z]:\\?$/.test(resolved)) {
    const m = String(resolved).match(/^([A-Za-z]:)/);
    autoName = m ? m[1] : resolved;
  }
  const entry = normalizeShortcut({
    name: (name && String(name).trim()) || ('💾 ' + autoName),
    path: resolved,
    type: type === 'shortcut' ? 'shortcut' : 'storage',
  });
  if (entry.type === 'storage' && !/^[💾💿📱💻]/.test(entry.name)) {
    entry.name = '💾 ' + entry.name.replace(/^💾\s*/, '');
  }

  const list = loadShortcuts().slice();
  const idx = list.findIndex(s => path.resolve(s.path) === entry.path);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...entry };
  } else {
    list.push(entry);
  }
  saveShortcuts(list);
  return { ok: true, entry, shortcuts: list };
}

let shortcuts = loadShortcuts();

// 获取父目录
function getParent(p) {
  const parent = path.dirname(p);
  if (!isPathSafe(parent)) return PAGE_DIR;
  return parent;
}

// 收集媒体库快捷入口（从 storage-config.json）—— 每次调用重新读，支持改配置后生效
function loadMediaPaths() {
  const configPath = path.join(PAGE_DIR, 'storage-config.json');
  const media = [];
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const LABELS = {
        music: '🎵 音乐', video: '🎬 视频', tvdrama: '📺 电视剧',
        album: '🖼️ 写真馆', book: '📚 书籍', pdf: '📕 PDF',
        audio: '🎧 有声书', geodata: '🗺️ 地理数据',
      };
      for (const [key, entry] of Object.entries(cfg.paths || {})) {
        const resolved = path.isAbsolute(entry.dir) ? entry.dir : path.resolve(PAGE_DIR, entry.dir);
        try {
          if (fs.existsSync(resolved)) {
            media.push({ key, name: LABELS[key] || key, path: resolved, section: 'media' });
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return media;
}

/** 扫描可挂载/外接存储（U 盘、移动硬盘、Windows 盘符等） */
function scanMounts() {
  const mounts = [];
  const seen = new Set();

  function pushMount(name, fullPath, source, extra = {}) {
    try {
      const resolved = path.resolve(fullPath);
      if (seen.has(resolved)) return;
      if (!isPathSafe(resolved)) return;
      if (!fs.existsSync(resolved)) return;
      const st = fs.statSync(resolved);
      if (!st.isDirectory()) return;
      fs.accessSync(resolved, fs.constants.R_OK);
      let count = 0;
      try { count = fs.readdirSync(resolved).length; } catch (_) { count = 0; }
      seen.add(resolved);
      mounts.push({
        name,
        path: resolved,
        source,
        size: count + ' 项',
        pinned: shortcuts.some(s => path.resolve(s.path) === resolved),
        ...extra,
      });
    } catch (_) {}
  }

  // Linux / 容器常见挂载根
  const scanRoots = ['/media', '/mnt', '/run/media', '/run/media/' + (process.env.USER || '')];
  for (const scanDir of scanRoots) {
    try {
      if (!fs.existsSync(scanDir)) continue;
      const entries = fs.readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(scanDir, entry.name);
        // /run/media/user/DISK 再下一层
        if (scanDir === '/run/media' || scanDir.startsWith('/run/media/')) {
          try {
            const subs = fs.readdirSync(fullPath, { withFileTypes: true });
            const subDirs = subs.filter(s => s.isDirectory() && !s.name.startsWith('.'));
            if (subDirs.length > 0 && scanDir === '/run/media') {
              for (const s of subDirs) {
                pushMount('💿 ' + s.name, path.join(fullPath, s.name), fullPath);
              }
              continue;
            }
          } catch (_) {}
        }
        pushMount('💿 ' + entry.name, fullPath, scanDir);
      }
    } catch (_) {}
  }

  // Android / Termux
  try {
    if (fs.existsSync('/storage')) {
      for (const entry of fs.readdirSync('/storage', { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (entry.name === 'emulated' || entry.name === 'self') continue;
        pushMount('📱 ' + entry.name, path.join('/storage', entry.name), '/storage');
      }
    }
  } catch (_) {}

  // Windows 盘符（可移动盘优先标 storage）
  if (process.platform === 'win32') {
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const drive = letter + ':\\';
      try {
        if (!fs.existsSync(drive)) continue;
        pushMount(
          (letter === 'C' ? '💻 ' : '💾 ') + letter + ':',
          drive,
          'win-drive',
          { drive: letter }
        );
      } catch (_) {}
    }
  }

  // 已固定为 storage 类型的快捷项也列出来（即使当前不在挂载扫描里）
  for (const s of shortcuts) {
    if (s.type === 'storage') {
      pushMount(s.name, s.path, 'pinned', { pinned: true });
    }
  }

  return { mounts, scanDirs: ['/media', '/mnt', '/run/media', '/storage', 'Windows 盘符 A-Z'] };
}

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript',
  '.css':'text/css','.json':'application/json',
  '.mp3':'audio/mpeg','.mp4':'video/mp4','.wav':'audio/wav','.flac':'audio/flac',
  '.ogg':'audio/ogg','.aac':'audio/aac','.m4a':'audio/mp4',
  '.webm':'video/webm','.mkv':'video/x-matroska','.mov':'video/quicktime',
  '.avi':'video/x-msvideo','.flv':'video/x-flv','.wmv':'video/x-ms-wmv',
  '.txt':'text/plain; charset=utf-8','.pdf':'application/pdf',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
  '.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp',
  '.zip':'application/zip','.tar':'application/x-tar','.gz':'application/gzip',
  '.7z':'application/x-7z-compressed','.rar':'application/vnd.rar',
  '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk':'application/vnd.android.package-archive',
  '.exe':'application/x-msdownload','.msi':'application/x-msi',
  '.iso':'application/x-iso9660-image',
};

// 格式化文件大小
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const reqPath = decodeURIComponent(url.pathname);
  const method = req.method;

  // CORS（含自定义文件名头，供流式上传）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Content-Length');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Accept-Ranges, Content-Range');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // === API: 浏览目录 ===
  if (reqPath === '/api/list' && method === 'GET') {
    let browsePath = url.searchParams.get('path') || PAGE_DIR;
    browsePath = path.resolve(browsePath);
    
    if (!isPathSafe(browsePath)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '禁止访问系统目录' }));
    }

    try {
      const stat = fs.statSync(browsePath);
      if (!stat.isDirectory()) {
        // 如果是文件，返回其所在目录
        browsePath = path.dirname(browsePath);
      }

      const entries = fs.readdirSync(browsePath, { withFileTypes: true });
      const items = [];
      
      for (const e of entries) {
        const fp = path.join(browsePath, e.name);
        try {
          const st = fs.statSync(fp);
          items.push({
            name: e.name,
            path: fp,
            isDir: e.isDirectory(),
            size: e.isDirectory() ? 0 : st.size,
            sizeFmt: e.isDirectory() ? '-' : fmtSize(st.size),
            mtime: st.mtime.toISOString(),
          });
        } catch (_) {}
      }

      // 排序：目录在前，文件在后，各自按名称排序
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
      });

      const parent = getParent(browsePath);
      // 每次重新读 shortcuts / 媒体库，支持新增存储后立刻出现
      shortcuts = loadShortcuts();
      const userRoots = shortcuts.map(s => ({
        name: s.name,
        path: s.path,
        section: s.type === 'storage' ? 'storage' : 'shortcut',
        type: s.type || 'shortcut',
      }));
      const mediaRoots = loadMediaPaths();
      const roots = [...userRoots, ...mediaRoots];

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        current: browsePath,
        parent: parent !== browsePath ? parent : null,
        items,
        roots,
      }));
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '目录不存在: ' + e.message }));
    }
  }

  // === API: 下载文件（支持 Range，大文件可断点/边下边用）===
  if (reqPath === '/api/download' && method === 'GET') {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      return res.end('Missing path');
    }
    const resolved = path.resolve(filePath);
    if (!isPathSafe(resolved)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        res.writeHead(400);
        return res.end('Cannot download directory');
      }
      const filename = path.basename(resolved);
      const ext = path.extname(filename).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      const total = stat.size;
      // 中文名：filename= 只用 ASCII 兜底，真正名字放 filename*=UTF-8''（RFC 5987），避免下载乱码
      const safeAscii = filename
        .replace(/[\\"\r\n]/g, '_')
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/_+/g, '_') || 'download';
      const disposition = `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
      const range = req.headers.range;

      if (range) {
        const m = String(range).match(/bytes=(\d*)-(\d*)/);
        if (!m) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        end = Math.min(end, total - 1);
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Disposition': disposition,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=0',
        });
        fs.createReadStream(resolved, { start, end, highWaterMark: 1024 * 1024 }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': disposition,
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=0',
        });
        fs.createReadStream(resolved, { highWaterMark: 1024 * 1024 }).pipe(res);
      }
    } catch (e) {
      res.writeHead(404);
      return res.end('File not found');
    }
    return;
  }

  // === API: 上传文件（优先原始二进制流，避免整文件进内存）===
  if (reqPath === '/api/upload' && method === 'POST') {
    const uploadDir = url.searchParams.get('dir') || PAGE_DIR;
    const resolved = path.resolve(uploadDir);
    if (!isPathSafe(resolved)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '上传目录不在允许范围内' }));
    }
    try { fs.mkdirSync(resolved, { recursive: true }); } catch (_) {}

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/i);

    // 原始流：?name= 或 X-File-Name（推荐，边收边写，无损原文件）
    // 文件名约定：前端 encodeURIComponent，服务端 decode 一次，保留中文/空格等
    if (!boundaryMatch) {
      let filename = '';
      const headerName = req.headers['x-file-name'];
      if (headerName) {
        try { filename = decodeURIComponent(String(headerName)); } catch (_) { filename = String(headerName); }
      }
      if (!filename) {
        // URLSearchParams.get 已自动 decode 一层，勿再 decodeURIComponent（防二次解码把 % 弄坏）
        filename = url.searchParams.get('name') || '';
      }
      if (!filename) filename = 'upload.bin';
      // 只取 basename，防路径穿越；保留 Unicode 文件名
      filename = path.basename(filename).replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_');
      if (!filename || filename === '.' || filename === '..') filename = 'upload.bin';

      let finalName = filename;
      let counter = 1;
      const base = path.basename(filename, path.extname(filename));
      const ext = path.extname(filename);
      while (fs.existsSync(path.join(resolved, finalName))) {
        finalName = base + '_' + (counter++) + ext;
      }
      const filePath = path.join(resolved, finalName);
      const ws = fs.createWriteStream(filePath, { highWaterMark: 1024 * 1024 });
      let written = 0;
      let finished = false;

      const fail = (msg, code = 500) => {
        if (finished) return;
        finished = true;
        try { ws.destroy(); } catch (_) {}
        try { fs.unlinkSync(filePath); } catch (_) {}
        if (!res.headersSent) {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      };

      req.on('data', (chunk) => { written += chunk.length; });
      req.on('aborted', () => fail('客户端中断上传', 499));
      req.on('error', (e) => fail(e.message));
      ws.on('error', (e) => fail(e.message));
      ws.on('finish', () => {
        if (finished) return;
        finished = true;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, name: finalName, path: filePath, size: written, files: [{ name: finalName, size: written }] }));
      });
      req.pipe(ws);
      return;
    }

    // multipart/form-data 兼容：仍支持，但大文件建议用原始流
    const chunks = [];
    let totalSize = 0;
    const MAX_MULTIPART = 512 * 1024 * 1024; // 512MB 上限，避免 OOM
    let aborted = false;
    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_MULTIPART) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'multipart 单次过大，请改用流式上传或拆分文件' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '');
        const boundaryBuf = Buffer.from('--' + boundary, 'latin1');
        const endBoundaryBuf = Buffer.from('--' + boundary + '--', 'latin1');
        const crlfcrlf = Buffer.from('\r\n\r\n', 'latin1');

        const results = [];
        let pos = 0;

        while (pos < buffer.length) {
          const nextBoundary = buffer.indexOf(boundaryBuf, pos);
          if (nextBoundary === -1) break;
          if (buffer.indexOf(endBoundaryBuf, nextBoundary) === nextBoundary) break;

          const headerStart = nextBoundary + boundaryBuf.length + 2;
          const headerEnd = buffer.indexOf(crlfcrlf, headerStart);
          if (headerEnd === -1) break;

          const headerStr = buffer.subarray(headerStart, headerEnd).toString('latin1');
          let filename = '';
          const fnStarMatch = headerStr.match(/filename\*=(?:UTF-8''|utf-8'')([^;\s]+)/i);
          if (fnStarMatch) {
            try { filename = decodeURIComponent(fnStarMatch[1]); } catch (_) { filename = fnStarMatch[1]; }
          } else {
            const fnMatch = headerStr.match(/filename="([^"]*)"/);
            if (fnMatch && fnMatch[1]) {
              try { filename = Buffer.from(fnMatch[1], 'latin1').toString('utf8'); } catch (_) { filename = fnMatch[1]; }
            }
          }
          filename = path.basename(filename).replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_');

          const contentStart = headerEnd + 4;
          const afterContent = buffer.indexOf(boundaryBuf, contentStart);
          const contentEnd = afterContent !== -1 ? afterContent - 2 : buffer.length - 2;
          const fileData = buffer.subarray(contentStart, Math.max(contentStart, contentEnd));

          if (filename && fileData.length > 0) {
            let finalName = filename;
            let counter = 1;
            const base = path.basename(filename, path.extname(filename));
            const ext = path.extname(filename);
            while (fs.existsSync(path.join(resolved, finalName))) {
              finalName = base + '_' + (counter++) + ext;
            }
            fs.writeFileSync(path.join(resolved, finalName), fileData);
            results.push({ name: finalName, size: fileData.length });
          }

          pos = contentEnd + 2;
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, files: results }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 删除文件/目录 ===
  if (reqPath === '/api/delete' && method === 'DELETE') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { paths: deletePaths } = JSON.parse(body);
        if (!Array.isArray(deletePaths) || deletePaths.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '请指定要删除的文件或目录' }));
        }

        const results = [];
        for (const p of deletePaths) {
          const resolved = path.resolve(p);
          if (!isPathSafe(resolved)) {
            results.push({ path: p, error: '不在允许范围内' });
            continue;
          }
          try {
            fs.rmSync(resolved, { recursive: true, force: true });
            results.push({ path: p, ok: true });
          } catch (e) {
            results.push({ path: p, error: e.message });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 创建目录 ===
  if (reqPath === '/api/mkdir' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { parent, name } = JSON.parse(body);
        if (!name || !parent) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '缺少参数' }));
        }
        const safeName = name.replace(/[\\\/:*?"<>|]/g, '_');
        const resolved = path.resolve(parent, safeName);
        if (!isPathSafe(resolved)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '不在允许范围内' }));
        }
        fs.mkdirSync(resolved, { recursive: true });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: resolved }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 浏览目录（供目录选择器使用）===
  if (reqPath === '/api/browse' && method === 'GET') {
    let browsePath = url.searchParams.get('path') || '/';
    browsePath = path.resolve(browsePath);
    if (!isPathSafe(browsePath)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '禁止访问' }));
    }
    try {
      const stat = fs.statSync(browsePath);
      if (!stat.isDirectory()) browsePath = path.dirname(browsePath);
      const entries = fs.readdirSync(browsePath, { withFileTypes: true });
      const dirs = [];
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) {
          dirs.push({ name: e.name, path: path.join(browsePath, e.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ current: browsePath, parent: path.dirname(browsePath), dirs }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // === API: 重命名 ===
  if (reqPath === '/api/rename' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { path: oldPath, name: newName } = JSON.parse(body);
        if (!oldPath || !newName) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '缺少参数' }));
        }
        const resolved = path.resolve(oldPath);
        if (!isPathSafe(resolved)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '不在允许范围内' }));
        }
        const newPath = path.join(path.dirname(resolved), newName);
        if (!isPathSafe(newPath)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '目标路径不在允许范围内' }));
        }
        fs.renameSync(resolved, newPath);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: newPath }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 快捷目录 ===
  if (reqPath === '/api/shortcuts' && method === 'GET') {
    shortcuts = loadShortcuts();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(shortcuts));
  }

  if (reqPath === '/api/shortcuts' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!Array.isArray(data)) throw new Error('格式错误');
        const saved = saveShortcuts(data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, shortcuts: saved }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 新增存储介质（U盘路径 / 盘符 / 任意可读目录）===
  if (reqPath === '/api/storage/add' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const result = addStorageEntry(data);
        const code = result.ok ? 200 : 400;
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 移除已固定的存储（按 path）
  if (reqPath === '/api/storage/remove' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const target = path.resolve(String(data.path || ''));
        if (!target) throw new Error('缺少 path');
        const next = loadShortcuts().filter(s => path.resolve(s.path) !== target);
        saveShortcuts(next);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, shortcuts: next }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // === API: 服务器信息 ===
  if (reqPath === '/api/info' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      pageDir: PAGE_DIR,
      platform: process.platform,
      shortcutsFile: SHORTCUTS_PATH,
    }));
  }

  // === API: 动态检测挂载点（U盘/移动硬盘/盘符） ===
  if (reqPath === '/api/mounts' && method === 'GET') {
    shortcuts = loadShortcuts();
    const result = scanMounts();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // === 静态文件: file-manager.html ===
  if (reqPath === '/' || reqPath === '/file-manager.html') {
    const htmlPath = path.join(__dirname, 'file-manager.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404);
      return res.end('file-manager.html not found');
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// 大文件传输：关闭默认超时，避免上传/下载中途被掐断
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120000;

server.listen(PORT, '0.0.0.0', () => {
  const { execSync } = require('child_process');
  let ips = [];

  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address !== '127.0.0.1') {
        ips.push(iface.address);
      }
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
    } catch(_) {}
  }

  if (ips.length === 0) ips.push('0.0.0.0');

  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║     📁 网盘文件管理                   ║');
  for (const ip of ips) {
    const url = 'http://' + ip + ':' + PORT;
    console.log('  ║     ' + url + ' '.repeat(34 - url.length) + '║');
  }
  console.log('  ║                                      ║');
  console.log('  ║  开机自启: systemctl enable dm-file   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
