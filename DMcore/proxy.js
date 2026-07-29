// 统一入口反向代理 — 配置驱动，改端口只需编辑 routes.json
const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── 加载配置 ──
const configPath = path.join(__dirname, 'routes.json');
let config = { port: 8080, default: 'http://127.0.0.1:8088', routes: {} };

try {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  config.port    = parsed.port    || config.port;
  config.default = parsed.default || config.default;
  config.routes  = parsed.routes  || config.routes;
  console.log('📋 已加载路由配置: ' + configPath);
} catch (e) {
  console.warn('⚠️  无法读取 routes.json，使用内置默认值: ' + e.message);
}

// ── 构建路由表（按路径长度降序，保证 /geo 匹配在 / 之前） ──
const ROUTES = Object.entries(config.routes)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([p, t]) => ({ path: p, target: t }));

// ── 代理转发（流式 pipe，适合网盘大文件上下传）──
function proxy(req, res, target, stripPrefix) {
  const targetUrl = new URL(target);
  let newPath = req.url;
  if (stripPrefix) {
    if (newPath === stripPrefix || newPath === stripPrefix + '/') {
      newPath = '/';
    } else if (newPath.startsWith(stripPrefix + '/')) {
      newPath = newPath.substring(stripPrefix.length);
    }
  }
  // 去掉可能被中间层改坏的 hop-by-hop 头，保留 Content-Length / Range
  const headers = { ...req.headers, host: targetUrl.host };
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers.te;
  delete headers.trailer;
  delete headers.upgrade;

  const opts = {
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    path: newPath,
    method: req.method,
    headers,
    timeout: 0,
  };
  const pr = http.request(opts, (prr) => {
    // 透传状态与头，便于 Range 206 / 大文件下载
    res.writeHead(prr.statusCode || 502, prr.headers);
    prr.pipe(res);
  });
  pr.setTimeout(0);
  pr.on('timeout', () => { try { pr.destroy(); } catch (_) {} });
  pr.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Service unavailable');
    } else {
      try { res.destroy(); } catch (_) {}
    }
  });
  req.on('aborted', () => { try { pr.destroy(); } catch (_) {} });
  req.pipe(pr);
}

// ── 启动 ──
const server = http.createServer((req, res) => {
  // 优先级 1: Referer 推断 —— 处理同源页面 JS 发起的无前缀 API/资源请求
  const referer = (req.headers.referer || '');
  if (referer) {
    try {
      const refPath = new URL(referer).pathname;
      for (const r of ROUTES) {
        if (refPath === r.path || refPath.startsWith(r.path + '/')) {
          return proxy(req, res, r.target);  // 不 strip，路径本身不含前缀
        }
      }
    } catch (_) {}
  }

  // 优先级 2: 显式路径前缀 —— 浏览器直接访问 /show/xxx 或 /geo/xxx
  for (const r of ROUTES) {
    if (req.url === r.path || req.url.startsWith(r.path + '/') || req.url.startsWith(r.path + '?')) {
      return proxy(req, res, r.target, r.path);
    }
  }

  // 优先级 3: 兜底 → DMcore
  proxy(req, res, config.default);
});

// 网盘大文件：避免 Node 默认 requestTimeout 中断长传
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120000;

server.listen(config.port, '0.0.0.0', () => {
  console.log('🔄 统一入口: http://0.0.0.0:' + config.port);
  console.log('   ' + ROUTES.length + ' 条路由, 默认 → ' + config.default);
});
