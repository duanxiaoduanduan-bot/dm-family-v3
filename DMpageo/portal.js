#!/usr/bin/env node
// DMpageo 合并门户：聚合 DMmedia + DMgeo
// 端口来源: 读取 ../ports.json(由各服务 dmcore-start.sh 写入) 获得实际端口,
//   若缺失则回退默认值 8081/8084。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8085;
const ROOT = __dirname;

// 从 ports.json 获取实际端口(缺省回退)
let realPorts = { media: 8081, geo: 8084 };
try {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'ports.json'), 'utf8'));
  if (j.DMmedia) realPorts.media = j.DMmedia.media;
  if (j.DMgeo)   realPorts.geo   = j.DMgeo.port;
} catch(e) { /* 缺省回退 */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let p = req.url === '/' ? '/index.html' : req.url;
  p = decodeURIComponent(p.split('?')[0]);
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  // /api/ports — 方便排查实际端口
  if (p === '/api/ports') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(realPorts));
  }

  // index.html — 将默认端口替换为实际端口
  if (p === '/index.html') {
    try {
      let html = fs.readFileSync(fp, 'utf8');
      html = html.replace(/:8081\b/g, ':' + realPorts.media);
      html = html.replace(/:8084\b/g, ':' + realPorts.geo);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch(e) { res.writeHead(404); return res.end('Not Found'); }
  }

  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║     DMpageo 合并门户  :' + PORT + '            ║');
  console.log('  ║     媒体 :' + realPorts.media + '    地理统计 :' + realPorts.geo + '    ║');
  console.log('  ╚══════════════════════════════════════╝');
});
