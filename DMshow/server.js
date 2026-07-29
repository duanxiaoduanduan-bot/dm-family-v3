const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || process.env.DM_PORT || 8086);
const ROOT = __dirname;
const LIBRARY = path.join(ROOT, 'library');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mkv': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i;
const VIDEO_EXTS = /\.(mp4|webm|mkv|mov|avi)$/i;
const MEDIA_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|webm|mkv|mov|avi)$/i;
const TEXT_EXTS = /\.(md|txt)$/i;
const COVER_NAMES = /^(cover|poster|thumb|thumbnail|preview|封面|海报)\./i;
const PROFILE_TEXT = /^(about|bio|intro|readme|简介|介绍|关于)\.(md|txt)$/i;

function ensureLibrary() {
  const dirs = [
    LIBRARY,
    path.join(LIBRARY, 'works'),
    path.join(LIBRARY, 'albums'),
    path.join(LIBRARY, 'videos'),
    path.join(LIBRARY, 'gallery'),
  ];
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

function safeRead(filePath, max = 200000) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

function safeJson(filePath) {
  const raw = safeRead(filePath);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function firstParagraph(text, maxLen = 180) {
  if (!text) return '';
  const cleaned = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/^#+\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const para = cleaned.split('\n').map(s => s.trim()).filter(Boolean)[0] || cleaned;
  if (para.length <= maxLen) return para;
  return para.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

function mediaType(name) {
  if (VIDEO_EXTS.test(name)) return 'video';
  if (IMAGE_EXTS.test(name)) return 'image';
  return 'file';
}

function publicUrl(absPath) {
  const rel = path.relative(LIBRARY, absPath).split(path.sep).join('/');
  return '/library/' + rel.split('/').map(encodeURIComponent).join('/');
}

function listEntries(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== '__MACOSX');
  } catch (_) {
    return [];
  }
}

function collectMedia(dirPath, { recursive = true, depth = 0, maxDepth = 4 } = {}) {
  const items = [];
  const texts = [];
  let cover = null;

  for (const e of listEntries(dirPath)) {
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      if (recursive && depth < maxDepth) {
        const nested = collectMedia(full, { recursive, depth: depth + 1, maxDepth });
        items.push(...nested.items);
        texts.push(...nested.texts);
        if (!cover && nested.cover) cover = nested.cover;
      }
      continue;
    }
    if (!e.isFile()) continue;

    if (TEXT_EXTS.test(e.name)) {
      const content = safeRead(full);
      if (content) {
        texts.push({
          name: e.name,
          path: full,
          content,
          summary: firstParagraph(content),
        });
      }
      continue;
    }

    if (!MEDIA_EXTS.test(e.name)) continue;
    const type = mediaType(e.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch (_) {}

    const item = {
      name: e.name,
      type,
      size,
      mtime,
      url: publicUrl(full),
    };
    items.push(item);
    if (!cover && (COVER_NAMES.test(e.name) || type === 'image')) {
      cover = item.url;
    }
  }

  items.sort((a, b) => {
    const aCover = COVER_NAMES.test(a.name) ? 0 : 1;
    const bCover = COVER_NAMES.test(b.name) ? 0 : 1;
    if (aCover !== bCover) return aCover - bCover;
    return a.name.localeCompare(b.name, 'zh');
  });

  return { items, texts, cover };
}

function folderMeta(dirPath, folderName) {
  const metaJson = safeJson(path.join(dirPath, 'meta.json'))
    || safeJson(path.join(dirPath, 'info.json'))
    || {};
  const collected = collectMedia(dirPath, { recursive: true });
  const preferredText = collected.texts.find(t => PROFILE_TEXT.test(t.name))
    || collected.texts[0]
    || null;

  const title = metaJson.title || metaJson.name || folderName;
  const summary = metaJson.summary
    || metaJson.description
    || (preferredText ? preferredText.summary : '')
    || '';
  const tags = Array.isArray(metaJson.tags) ? metaJson.tags : [];
  const date = metaJson.date || '';
  const cover = metaJson.cover
    ? (metaJson.cover.startsWith('/') ? metaJson.cover : publicUrl(path.join(dirPath, metaJson.cover)))
    : collected.cover;

  const images = collected.items.filter(i => i.type === 'image');
  const videos = collected.items.filter(i => i.type === 'video');

  return {
    id: folderName,
    title,
    summary,
    tags,
    date,
    cover: cover || (videos[0] ? videos[0].url : null),
    path: dirPath,
    text: preferredText ? preferredText.content : (metaJson.body || ''),
    items: collected.items,
    counts: {
      total: collected.items.length,
      images: images.length,
      videos: videos.length,
    },
  };
}

function loadProfile() {
  const defaults = {
    avatar: '👤',
    avatarUrl: '',
    name: '你的名字',
    title: '创作者 · 作品集',
    bio: '把照片、视频和文字丢进 library 文件夹，主页会自动完善。',
    tags: ['摄影', '影像', '作品集'],
    links: [],
    location: '',
    email: '',
  };

  const cfg = safeJson(path.join(LIBRARY, 'profile.json')) || {};
  const profile = { ...defaults, ...cfg };

  // avatar image in library root
  if (!profile.avatarUrl) {
    for (const name of listEntries(LIBRARY)) {
      if (!name.isFile()) continue;
      if (/^avatar\./i.test(name.name) && IMAGE_EXTS.test(name.name)) {
        profile.avatarUrl = publicUrl(path.join(LIBRARY, name.name));
        break;
      }
    }
  } else if (profile.avatarUrl && !profile.avatarUrl.startsWith('/') && !profile.avatarUrl.startsWith('http')) {
    profile.avatarUrl = publicUrl(path.join(LIBRARY, profile.avatarUrl));
  }

  // long about text
  let about = '';
  for (const name of listEntries(LIBRARY)) {
    if (!name.isFile()) continue;
    if (PROFILE_TEXT.test(name.name)) {
      about = safeRead(path.join(LIBRARY, name.name)) || '';
      if (about) break;
    }
  }
  if (!about && cfg.about) about = String(cfg.about);
  profile.about = about;
  if (about && (!cfg.bio || cfg.bio === defaults.bio)) {
    profile.bio = firstParagraph(about, 220);
  }

  if (!Array.isArray(profile.tags)) profile.tags = defaults.tags;
  if (!Array.isArray(profile.links)) profile.links = defaults.links;

  return profile;
}

function scanSection(sectionName, kind) {
  const base = path.join(LIBRARY, sectionName);
  const result = [];
  for (const e of listEntries(base)) {
    const full = path.join(base, e.name);
    if (e.isDirectory()) {
      const meta = folderMeta(full, e.name);
      meta.kind = kind;
      meta.section = sectionName;
      if (meta.counts.total > 0 || meta.summary || meta.text) result.push(meta);
      continue;
    }
    if (e.isFile() && MEDIA_EXTS.test(e.name)) {
      // loose files under section root → single-item collection
      const type = mediaType(e.name);
      const url = publicUrl(full);
      result.push({
        id: e.name,
        title: path.basename(e.name, path.extname(e.name)),
        summary: '',
        tags: [],
        date: '',
        cover: type === 'image' ? url : null,
        path: full,
        text: '',
        items: [{ name: e.name, type, url, size: 0, mtime: 0 }],
        counts: { total: 1, images: type === 'image' ? 1 : 0, videos: type === 'video' ? 1 : 0 },
        kind,
        section: sectionName,
        loose: true,
      });
    }
  }
  result.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return String(b.date).localeCompare(String(a.date));
    return a.title.localeCompare(b.title, 'zh');
  });
  return result;
}

function buildPortfolio() {
  ensureLibrary();
  const profile = loadProfile();
  const works = scanSection('works', 'work');
  const albums = scanSection('albums', 'album');
  const videos = scanSection('videos', 'video');
  const galleryDir = path.join(LIBRARY, 'gallery');
  const galleryCollected = collectMedia(galleryDir, { recursive: true });
  const gallery = galleryCollected.items;

  // also include loose root media (except avatar) into gallery
  for (const e of listEntries(LIBRARY)) {
    if (!e.isFile() || !MEDIA_EXTS.test(e.name)) continue;
    if (/^avatar\./i.test(e.name)) continue;
    gallery.push({
      name: e.name,
      type: mediaType(e.name),
      url: publicUrl(path.join(LIBRARY, e.name)),
      size: 0,
      mtime: 0,
    });
  }

  const stats = {
    works: works.length,
    albums: albums.length,
    videos: videos.reduce((n, c) => n + c.counts.videos, 0)
      + gallery.filter(i => i.type === 'video').length,
    images: works.reduce((n, c) => n + c.counts.images, 0)
      + albums.reduce((n, c) => n + c.counts.images, 0)
      + gallery.filter(i => i.type === 'image').length,
    collections: works.length + albums.length + videos.length,
    media: 0,
  };
  stats.media = stats.images + stats.videos;

  return {
    profile,
    works,
    albums,
    videos,
    gallery,
    stats,
    libraryPath: LIBRARY,
    generatedAt: new Date().toISOString(),
  };
}

// ===== legacy scan helpers (sources / USB) =====
function scanMounts() {
  const mounts = [];
  const dirs = ['/media', '/mnt', '/run/media', '/storage'];
  for (const base of dirs) {
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() || e.isSymbolicLink()) {
          const full = path.join(base, e.name);
          try {
            fs.accessSync(full, fs.constants.R_OK);
            mounts.push({ name: e.name, path: full, type: 'usb' });
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return mounts;
}

function scanDir(dirPath) {
  const items = [];
  const dirs = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX') {
        dirs.push(e.name);
      } else if (e.isFile() && MEDIA_EXTS.test(e.name)) {
        const isVideo = VIDEO_EXTS.test(e.name);
        const fullPath = path.join(dirPath, e.name);
        let size = 0;
        try { size = fs.statSync(fullPath).size; } catch (_) {}
        items.push({
          name: e.name,
          url: '/media/' + encodeURIComponent(e.name),
          type: isVideo ? 'video' : 'image',
          size,
        });
      }
    }
    dirs.sort((a, b) => a.localeCompare(b, 'zh'));
    return { items, subDirs: dirs, path: dirPath };
  } catch (e) {
    return { items: [], subDirs: [], path: dirPath, error: e.message };
  }
}

function serveFile(filePath, req, res) {
  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    if (stat.isDirectory()) {
      return fs.readFile(path.join(filePath, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const total = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (Number.isNaN(start) || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      const safeEnd = Math.min(end, total - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${safeEnd}/${total}`,
        'Content-Length': safeEnd - start + 1,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=60',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

function sendJson(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

// ===== HTTP =====
ensureLibrary();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let reqPath = decodeURIComponent(url.pathname);

  // CORS for proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Portfolio API — auto from library/
  if (reqPath === '/api/portfolio') {
    try {
      return sendJson(res, buildPortfolio());
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }

  // Save profile (optional web edit → library/profile.json)
  if (reqPath === '/api/profile' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        ensureLibrary();
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const allowed = ['avatar', 'avatarUrl', 'name', 'title', 'bio', 'tags', 'links', 'location', 'email', 'about'];
        const next = {};
        for (const k of allowed) {
          if (body[k] !== undefined) next[k] = body[k];
        }
        const prev = safeJson(path.join(LIBRARY, 'profile.json')) || {};
        const merged = { ...prev, ...next };
        fs.writeFileSync(path.join(LIBRARY, 'profile.json'), JSON.stringify(merged, null, 2), 'utf8');
        if (typeof body.about === 'string' && body.about.trim()) {
          fs.writeFileSync(path.join(LIBRARY, 'about.md'), body.about, 'utf8');
        }
        sendJson(res, { ok: true, profile: loadProfile() });
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  if (reqPath === '/api/sources') {
    const sources = [];
    const added = new Set();
    function addSource(name, p, type) {
      if (added.has(p)) return;
      try {
        fs.accessSync(p, fs.constants.R_OK);
        sources.push({ name, path: p, type });
        added.add(p);
      } catch (_) {}
    }
    function subDirs(base, prefix, type) {
      try {
        for (const e of fs.readdirSync(base, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith('.')) continue;
          addSource(prefix + e.name, path.join(base, e.name), type);
        }
      } catch (_) {}
    }

    addSource('⭐ 作品库 library', LIBRARY, 'library');
    subDirs(LIBRARY, '  └ ', 'library');
    ['works', 'albums', 'videos', 'gallery'].forEach(n => {
      addSource('  📁 ' + n, path.join(LIBRARY, n), 'library');
    });

    const desktop = path.join(__dirname, '..');
    addSource('🏠 DM 家族', desktop, 'dm');
    subDirs(desktop, '  └ ', 'dm');

    const dmmedia = path.join(__dirname, '..', 'DMmedia');
    ['music', 'video', 'album', 'tvdrama'].forEach(dir => {
      addSource('📷 ' + dir, path.join(dmmedia, dir), 'media');
    });

    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      addSource('🏠 Home', home, 'home');
      ['Desktop', 'Downloads', 'Pictures', 'Videos', 'Music', 'Documents'].forEach(name => {
        addSource('  📁 ' + name, path.join(home, name), 'home');
      });
    }

    for (const u of scanMounts()) addSource('💾 ' + u.name, u.path, 'usb');

    return sendJson(res, sources);
  }

  if (reqPath === '/api/scan') {
    const srcPath = url.searchParams.get('path') || LIBRARY;
    return sendJson(res, scanDir(srcPath));
  }

  // Serve library files
  if (reqPath.startsWith('/library/')) {
    const rel = reqPath.slice('/library/'.length);
    const realPath = path.join(LIBRARY, rel);
    if (!path.normalize(realPath).startsWith(path.normalize(LIBRARY))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    return serveFile(realPath, req, res);
  }

  // Virtual mount for external sources
  if (reqPath.startsWith('/media/')) {
    const base = url.searchParams.get('base');
    if (base) {
      const relative = reqPath.slice('/media/'.length);
      const realPath = path.join(base, decodeURIComponent(relative));
      if (path.normalize(realPath).startsWith(path.normalize(base))) {
        return serveFile(realPath, req, res);
      }
    }
    return serveFile(path.join(ROOT, reqPath), req, res);
  }

  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(ROOT, reqPath);
  if (!path.normalize(filePath).startsWith(path.normalize(ROOT))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  serveFile(filePath, req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`  DMshow 作品集主页 :${PORT}`);
  console.log(`  素材库: ${LIBRARY}`);
  console.log(`  丢文件进 library/works|albums|videos|gallery 即可自动上线`);
});
