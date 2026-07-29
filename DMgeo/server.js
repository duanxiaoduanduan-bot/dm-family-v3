const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8084;
const ROOT = __dirname;

// ===== PostgreSQL/PostGIS 连接池 =====
const pgPool = new Pool({        // trip — 主库(要素+边界缓存)
  database: 'trip',
  user: 'dmuser',
  password: 'dmpageo123',
  max: 10
});
const basemapPool = new Pool({   // Basemap — 底图原档(不动)
  database: 'Basemap',
  user: 'dmuser',
  password: 'dmpageo123',
  max: 10
});
// 管理连接�� — 连 postgres 库, 用于 CREATE/DROP DATABASE
const adminPool = new Pool({
  database: 'postgres',
  user: 'dmuser',
  password: 'dmpageo123',
  max: 3
});

// 启动时测试连接
pgPool.query('SELECT PostGIS_version()').then(r => {
  console.log('  🗄️  PostGIS:', r.rows[0].postgis_version.split(' ')[0]);
}).catch(e => {
  console.error('  ⚠️  PostGIS 连接失败:', e.message);
});

// ===== 存储配置 =====
function resolveDir(cfgEntry) {
  if (!cfgEntry || !cfgEntry.dir) return ROOT;
  const d = cfgEntry.dir;
  if (path.isAbsolute(d)) return d;
  return path.resolve(ROOT, d);
}



const config = { paths: { geodata: { dir: './geodata' }, album: { dir: './album' } } };

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

function scanGeodataWithCache() {
  const cfg = config.paths.geodata;
  const dir = resolveDir(cfg);
  const mediaPrefix = 'media/geodata/';
  const now = getDirMtime(dir);

  if (cache['geodata-list'] && cache['geodata-list'].mtime === now) {
    return cache['geodata-list'].data;
  }

  const items = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    // 根目录下的图片（直接放的照片）
    const rootPhotos = [];
    // 根目录下的 geojson/gpx 文件
    const geoFiles = [];
    
    for (const f of entries) {
      if (f.isFile()) {
        if (/\.(jpg|jpeg|png|gif|webp|bmp|mp4|webm|mkv|mov|avi|flv|wmv)$/i.test(f.name)) {
          rootPhotos.push({ name: f.name, file: mediaPrefix + f.name });
        } else if (/\.(geojson|json)$/i.test(f.name) && f.name !== 'map-data.geojson' && !f.name.startsWith('china_')) {
          geoFiles.push({ name: f.name, file: mediaPrefix + f.name, type: 'geojson' });
        } else if (/\.gpx$/i.test(f.name)) {
          geoFiles.push({ name: f.name, file: mediaPrefix + f.name, type: 'gpx' });
        }
      }
      if (f.isDirectory()) {
        const subs = fs.readdirSync(path.join(dir, f.name), { withFileTypes: true });
        const photos = [];
        for (const s of subs) {
          if (s.isFile() && /\.(jpg|jpeg|png|gif|webp|bmp|mp4|webm|mkv|mov|avi|flv|wmv)$/i.test(s.name)) {
            photos.push({ name: s.name, file: mediaPrefix + f.name + '/' + s.name });
          }
        }
        if (photos.length) {
          items.push({ name: f.name, file: '', type: 'photo_group', photos: photos });
        }
      }
    }
    
    // 根目录照片作为一个 photo_group 放在最前面
    if (rootPhotos.length) {
      items.unshift({ name: '根目录', file: '', type: 'photo_group', photos: rootPhotos });
    }
    // geojson/gpx 文件
    for (const gf of geoFiles) {
      items.push(gf);
    }
  } catch(e) {}

  cache['geodata-list'] = { mtime: now, data: items };
  try { fs.writeFileSync(path.join(ROOT, 'geodata-list.json'), JSON.stringify(items)); } catch(e) {}
  return items;
}

// ====== PostGIS 数据库管理工具 API ======
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handlePgApi(req, res, reqPath, method) {
  const url = new URL(req.url, 'http://localhost');
  const dbName = url.searchParams.get('db') || 'trip';
  // 按数据库名缓存连接池
  const _pools = { trip: pgPool, Basemap: basemapPool };
  const getPool = () => {
    if (!_pools[dbName]) _pools[dbName] = new Pool({ database: dbName, user: 'dmuser', password: 'dmpageo123', max: 3 });
    return _pools[dbName];
  };
  const pool = () => getPool();
  const pathParts = reqPath.replace('/api/pg/', '').split('/').filter(Boolean);
  // 规范化: /api/pg/tables/xxx → /api/pg/xxx
  if (pathParts[0] === 'tables') pathParts.shift();
  const getBody = () => new Promise((resolve) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => resolve(body));
  });

  // ===== 数据库管理 =====
  // GET /api/pg/databases → 列出所有数据库
  if (pathParts[0] === 'databases' && pathParts.length === 1 && method === 'GET') {
    try {
      const r = await adminPool.query(`SELECT datname FROM pg_database WHERE datistemplate=false AND datname NOT IN ('postgres','template0','template1') ORDER BY datname`);
      return sendJson(res, 200, r.rows.map(row => row.datname));
    } catch(e) { return sendJson(res, 500, { error: e.message }); }
  }

  // POST /api/pg/databases → 新建数据库 { name }
  if (pathParts[0] === 'databases' && pathParts.length === 1 && method === 'POST') {
    try {
      const body = JSON.parse(await getBody());
      if (!body.name) throw new Error('缺少数据库名');
      await adminPool.query(`CREATE DATABASE "${body.name}" OWNER dmuser`);
      // 新建后自动启用 PostGIS
      const newPool = new Pool({ database: body.name, user: 'dmuser', password: 'dmpageo123', max: 3 });
      await newPool.query('CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS postgis_topology;');
      // 自动建标准要素表
      await newPool.query(`CREATE TABLE IF NOT EXISTS features (
        id SERIAL PRIMARY KEY,
        name TEXT,
        type TEXT DEFAULT 'point',
        geom geometry(Geometry,4326),
        properties JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      await newPool.query('CREATE INDEX IF NOT EXISTS idx_features_geom ON features USING GIST (geom)');
      await newPool.end();
      return sendJson(res, 200, { ok: true, message: `数据库 ${body.name} 已创建(含 PostGIS)` });
    } catch(e) { return sendJson(res, 400, { error: e.message }); }
  }

  // PUT /api/pg/databases/:name → 重命名数据库 { newName }
  if (pathParts[0] === 'databases' && pathParts.length === 2 && method === 'PUT') {
    try {
      const body = JSON.parse(await getBody());
      if (!body.newName) throw new Error('缺少新库名');
      if (pathParts[1] === 'dmpageo') throw new Error('不能重命名主数据库 dmpageo');
      await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [pathParts[1]]);
      await adminPool.query(`ALTER DATABASE "${pathParts[1]}" RENAME TO "${body.newName}"`);
      return sendJson(res, 200, { ok: true, message: `已重命名为 ${body.newName}` });
    } catch(e) { return sendJson(res, 400, { error: e.message }); }
  }

  // DELETE /api/pg/databases/:name → 删除数据库
  if (pathParts[0] === 'databases' && pathParts.length === 2 && method === 'DELETE') {
    try {
      // 禁止删除当前连接的库
      if (pathParts[1] === 'dmpageo') throw new Error('不能删除主数据库 dmpageo');
      // 断开所有其他连接
      await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [pathParts[1]]);
      await adminPool.query(`DROP DATABASE IF EXISTS "${pathParts[1]}"`);
      return sendJson(res, 200, { ok: true, message: `数据库 ${pathParts[1]} 已删除` });
    } catch(e) { return sendJson(res, 400, { error: e.message }); }
  }

  // GET /api/pg/tables or /api/pg/ → 列出 public schema 下所有表
  if ((pathParts.length === 0 || pathParts[0] === 'tables') && method === 'GET') {
    try {
      const r = await pool().query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
      return sendJson(res, 200, r.rows.map(row => row.table_name));
    } catch(e) { return sendJson(res, 500, { error: e.message }); }
  }

  // POST /api/pg/tables or /api/pg/ → 新建表
  if ((pathParts.length === 0 || pathParts[0] === 'tables') && method === 'POST') {
    try {
      const body = JSON.parse(await getBody());
      if (!body.name) throw new Error('缺少表名');
      const cols = (body.columns || [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'name', type: 'TEXT' }, { name: 'geom', type: 'geometry(Geometry,4326)' }, { name: 'properties', type: 'JSONB DEFAULT \'{}\'' }]);
      const colDefs = cols.map(c => `"${c.name}" ${c.type}`).join(', ');
      await pool().query(`CREATE TABLE "${body.name}" (${colDefs})`);
      // 如果有 geometry 列, 建空间索引
      const hasGeom = cols.some(c => c.type.toLowerCase().includes('geometry'));
      if (hasGeom) {
        const geomCol = cols.find(c => c.type.toLowerCase().includes('geometry')).name;
        await pool().query(`CREATE INDEX IF NOT EXISTS "idx_${body.name}_${geomCol}" ON "${body.name}" USING GIST ("${geomCol}")`);
      }
      return sendJson(res, 200, { ok: true, message: `表 ${body.name} 已创建` });
    } catch(e) { return sendJson(res, 400, { error: e.message }); }
  }

  // DELETE /api/pg/tables/:name → 删除表(含外部表)
  if (pathParts.length === 1 && method === 'DELETE') {
    try {
      await pool().query(`DROP TABLE IF EXISTS "${pathParts[0]}" CASCADE`);
      return sendJson(res, 200, { ok: true, message: `表 ${pathParts[0]} 已删除` });
    } catch(e) {
      // 普通 DROP TABLE 失败时尝试 DROP FOREIGN TABLE
      try {
        await pool().query(`DROP FOREIGN TABLE IF EXISTS "${pathParts[0]}" CASCADE`);
        return sendJson(res, 200, { ok: true, message: `外部表 ${pathParts[0]} 已删除` });
      } catch(e2) { return sendJson(res, 500, { error: e2.message }); }
    }
  }

  // PUT /api/pg/tables/:name → 重命名表 { newName }
  if (pathParts.length === 1 && method === 'PUT') {
    try {
      const body = JSON.parse(await getBody());
      if (!body.newName) throw new Error('缺少新表名');
      await pool().query(`ALTER TABLE "${pathParts[0]}" RENAME TO "${body.newName}"`);
      return sendJson(res, 200, { ok: true, message: `已重命名为 ${body.newName}` });
    } catch(e) { return sendJson(res, 400, { error: e.message }); }
  }

  const tableName = pathParts[0];
  if (!tableName) { sendJson(res, 404, { error: '未指定表名' }); return; }

  // GET /api/pg/tables/:name/schema → 列信息
  if (pathParts[1] === 'schema' && method === 'GET') {
    try {
      const r = await pool().query(`SELECT column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [tableName]);
      return sendJson(res, 200, r.rows);
    } catch(e) { return sendJson(res, 500, { error: e.message }); }
  }

  // GET /api/pg/tables/:name/rows?page=1&limit=50&q=&order=&type=
  if (pathParts[1] === 'rows' && pathParts.length === 2 && method === 'GET') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const page = parseInt(url.searchParams.get('page')) || 1;
      const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 500);
      const q = (url.searchParams.get('q') || '').trim();
      const filterType = (url.searchParams.get('type') || '').trim();
      const order = url.searchParams.get('order') || 'id';
      const offset = (page - 1) * limit;

      // 先取列信息(区分 geometry 列)
      const cols = await pool().query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [tableName]);
      const geomCols = cols.rows.filter(c => c.udt_name === 'geometry').map(c => c.column_name);
      const colNames = cols.rows.map(c => c.column_name);

      let whereClause = '';
      const params = [];
      if (q) {
        const textCols = colNames.filter(c => !geomCols.includes(c));
        if (textCols.length > 0) {
          whereClause = ' WHERE ' + textCols.map(c => `CAST("${c}" AS TEXT) ILIKE $1`).join(' OR ');
          params.push(`%${q}%`);
        }
      }
      // 要素类别过滤(仅对 features 表有效)
      if (filterType && tableName === 'features') {
        const prefix = whereClause ? ' AND' : ' WHERE';
        const idx = params.length + 1;
        if (filterType === 'marker') { whereClause += `${prefix} type IN ($${idx},$${idx + 1})`; params.push('point', 'marker'); }
        else if (filterType === 'path') { whereClause += `${prefix} type IN ($${idx},$${idx + 1})`; params.push('line', 'path'); }
        else if (filterType === 'polygon') { whereClause += `${prefix} type = $${idx}`; params.push('polygon'); }
        else if (filterType === 'photo') { whereClause += `${prefix} (type = $${idx} OR properties ? 'photo')`; params.push('photo'); }
      }

      // 构建 SELECT: geometry 列转 GeoJSON
      const selectParts = colNames.map(c => {
        if (geomCols.includes(c)) return `ST_AsGeoJSON("${c}") AS "${c}_geojson"`;
        return `"${c}"`;
      });

      const countR = await pool().query(`SELECT COUNT(*) FROM "${tableName}"${whereClause}`, params);
      const total = parseInt(countR.rows[0].count);

      const safeOrder = colNames.includes(order) ? `"${order}"` : `"${colNames[0]}"`;
      const dataParams = [...params, limit, offset];
      const dataR = await pool().query(
        `SELECT ${selectParts.join(', ')} FROM "${tableName}"${whereClause} ORDER BY ${safeOrder} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        dataParams
      );

      return sendJson(res, 200, { rows: dataR.rows, total, page, limit });
    } catch(e) { return sendJson(res, 500, { error: e.message }); }
  }

  // POST /api/pg/tables/:name/rows → 插入行 { data: {col: val, ...} }
  if (pathParts[1] === 'rows' && pathParts.length === 2 && method === 'POST') {
    try {
      const body = JSON.parse(await getBody());
      if (!body.data) throw new Error('缺少 data');
      const entries = Object.entries(body.data);
      const cols = entries.map(([k]) => `"${k}"`);
      const vals = entries.map(([, v]) => {
        if (v && typeof v === 'object' && v.type === 'Point' && v.coordinates) {
          return `ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(v)}'), 4326)`;
        }
        return typeof v === 'object' ? `'${JSON.stringify(v)}'` : `'${String(v).replace(/'/g, "''")}'`;
      });
      const r = await pool().query(`INSERT INTO "${tableName}" (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING *`);
      return sendJson(res, 200, { ok: true, row: r.rows[0] });
    } catch(e) { return sendJson(res, 400, { error: e.message }); }
  }

  // PUT /api/pg/tables/:name/rows/:id → 更新行 { data: {col: val} }
  if (pathParts[2] && pathParts[1] === 'rows' && method === 'PUT') {
    try {
      const body = JSON.parse(await getBody());
      if (!body.data) throw new Error('缺少 data');
      const entries = Object.entries(body.data);
      const sets = entries.map(([k, v], i) => {
        if (v && typeof v === 'object' && v.type === 'Point' && v.coordinates)
          return `"${k}" = ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(v)}'), 4326)`;
        return `"${k}" = '${String(v).replace(/'/g, "''")}'`;
      });
      await pool().query(`UPDATE "${tableName}" SET ${sets.join(', ')} WHERE id = $1`, [pathParts[2]]);
      return sendJson(res, 200, { ok: true });
    } catch(e) { return sendJson(res, 400, { error: e.message }); }
  }

  // DELETE /api/pg/tables/:name/rows/:id → 删除行 (id='all' 清空表)
  if (pathParts[2] && pathParts[1] === 'rows' && method === 'DELETE') {
    try {
      if (pathParts[2] === 'all') {
        await pool().query(`DELETE FROM "${tableName}"`);
        return sendJson(res, 200, { ok: true, message: '表已清空' });
      }
      await pool().query(`DELETE FROM "${tableName}" WHERE id = $1`, [pathParts[2]]);
      return sendJson(res, 200, { ok: true });
    } catch(e) { return sendJson(res, 500, { error: e.message }); }
  }

  // GET /api/pg/tables/:name/download?format=geojson|csv
  if (pathParts[1] === 'download' && method === 'GET') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const format = url.searchParams.get('format') || 'geojson';

      // 取列信息
      const cols = await pool().query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [tableName]);
      const geomCols = cols.rows.filter(c => c.udt_name === 'geometry').map(c => c.column_name);
      const colNames = cols.rows.map(c => c.column_name);

      const selectParts = colNames.map(c => {
        if (geomCols.includes(c)) return `ST_AsGeoJSON("${c}") AS "${c}_geojson"`;
        return `"${c}"`;
      });

      const r = await pool().query(`SELECT ${selectParts.join(', ')} FROM "${tableName}"`);

      if (format === 'csv') {
        const textCols = colNames.filter(c => !geomCols.includes(c));
        const header = '\uFEFF' + textCols.join(',') + '\n';  // BOM 防乱码
        const rows = r.rows.map(row =>
          textCols.map(c => {
            const v = row[c];
            if (v === null || v === undefined) return '';
            return '"' + String(v).replace(/"/g, '""') + '"';
          }).join(',')
        ).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(tableName)}.csv"` });
        return res.end(header + rows);
      }

      // GeoJSON
      const features = r.rows.map(row => {
        let geom = null;
        for (const gc of geomCols) {
          if (row[gc + '_geojson']) { geom = JSON.parse(row[gc + '_geojson']); break; }
        }
        const props = {};
        for (const c of colNames) { if (!geomCols.includes(c)) props[c] = row[c]; }
        return { type: 'Feature', geometry: geom, properties: props };
      });
      res.writeHead(200, { 'Content-Type': 'application/geo+json; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(tableName)}.geojson"` });
      return res.end(JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
    } catch(e) { return sendJson(res, 500, { error: e.message }); }
  }

  // POST /api/pg/tables/:name/upload → 上传 GeoJSON/CSV
  if (pathParts[1] === 'upload' && method === 'POST') {
    try {
      const body = JSON.parse(await getBody());
      if (!body.features && !body.rows) throw new Error('需要 features(GeoJSON) 或 rows(CSV)');

      const cols = await pool().query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [tableName]);
      const colNames = cols.rows.map(c => c.column_name);

      let inserted = 0, errors = [];

      if (body.features) {
        for (const feat of body.features) {
          try {
            const props = feat.properties || {};
            const entries = Object.entries(props).filter(([k]) => colNames.includes(k));
            const keys = entries.map(([k]) => `"${k}"`);
            const vals = entries.map(([, v]) => `'${String(v).replace(/'/g, "''")}'`);
            if (feat.geometry) {
              keys.push('geom');
              vals.push(`ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(feat.geometry)}'), 4326)`);
            }
            const geomColName = colNames.find(c => c === 'geom');
            if (!feat.geometry && geomColName) {
              keys.push('geom'); vals.push('NULL');
            }
            if (keys.length) {
              await pool().query(`INSERT INTO "${tableName}" (${keys.join(',')}) VALUES (${vals.join(',')})`);
              inserted++;
            }
          } catch(inner) { errors.push(inner.message); }
        }
      }

      return sendJson(res, 200, { ok: true, inserted, errors: errors.slice(0, 10) });
    } catch(e) { return sendJson(res, 400, { error: e.message }); }
  }

  sendJson(res, 404, { error: '未知 API' });
}

// ===== 服务器 =====
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let reqPath = decodeURIComponent(url.pathname);

  // POST /api/pg/query → 执行原始 SQL（只读，安全限制）
  if (reqPath === '/api/pg/query' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { sql } = JSON.parse(body);
        if (!sql) throw new Error('SQL 不能为空');
        // 安全限制: 只允许 SELECT
        const trimmed = sql.trim().toUpperCase();
        if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('EXPLAIN') && !trimmed.startsWith('SHOW')) {
          throw new Error('仅允许 SELECT / EXPLAIN / SHOW 查询');
        }
        const result = await pgPool.query(sql);
        const columns = result.fields.map(f => f.name);
        sendJson(res, 200, { columns, rows: result.rows });
      } catch(e) {
        sendJson(res, 400, { error: e.message });
      }
    });
    return;
  }

  // JSON 请求 → 缓存扫描（每次请求都检查 mtime，变化时重新扫描）
  if (reqPath === '/geodata-list.json') {
    const data = scanGeodataWithCache();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
    return res.end(JSON.stringify(data));
  }

  // 代理 DMmedia 媒体列表到 8081（dashboard 大数据屏需要）
  const MEDIA_PROXY = ['/tvdrama-list.json','/music-list.json','/video-list.json','/album-list.json','/book-list.json','/audio-list.json'];
  if (MEDIA_PROXY.includes(reqPath)) {
    http.get('http://127.0.0.1:8081' + reqPath, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }).on('error', () => {
      res.writeHead(502); res.end('Proxy Error');
    });
    return;
  }

  // ============================================================
  //  地理数据库 API（RESTful）
  //  底层存储：geodata/map-data.geojson (GeoJSON FeatureCollection)
  //  支持：标记点 CRUD、路径 CRUD、照片定位、批量操作、导入导出
  // ============================================================

  const geodataDir = resolveDir(config.paths.geodata);
  const MAP_DATA_FILE = path.join(geodataDir, 'map-data.geojson');

  // 确保 geodata 目录存在
  if (!fs.existsSync(geodataDir)) fs.mkdirSync(geodataDir, { recursive: true });

  // 读取完整数据库
  function loadMapDB() {
    try {
      if (fs.existsSync(MAP_DATA_FILE)) {
        const raw = fs.readFileSync(MAP_DATA_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
          return data;
        }
      }
    } catch(e) { console.error('loadMapDB error:', e.message); }
    return { type: 'FeatureCollection', features: [] };
  }

  // 保存数据库并清除缓存
  function saveMapDB(db) {
    fs.writeFileSync(MAP_DATA_FILE, JSON.stringify(db, null, 2));
    delete cache['geodata-list'];
  }

  // 生成唯一 ID
  function genId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ====== 中国行政区划坐标参考数据 ======
  // 每个条目: { province, city, lng, lat } — 用于反向地理编码
  const ADMIN_REGIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'admin-regions.json'), 'utf8'));

  // ====== GET /api/geo → 从选定库读取要素 ======
  if (reqPath === '/api/geo' && req.method === 'GET') {
    (async () => {
      try {
        const featDb = url.searchParams.get('db') || 'trip';
        const featPool = featDb === 'trip' ? pgPool : featDb === 'Basemap' ? basemapPool : new Pool({ database: featDb, user: 'dmuser', password: 'dmpageo123', max: 3 });
        const filter = url.searchParams.get('type');
        let sql = 'SELECT id, name, type, ST_AsGeoJSON(geom)::json AS geometry, properties FROM features';
        const params = [];
        if (filter === 'marker') { sql += ' WHERE type = $1'; params.push('point'); }
        else if (filter === 'path') { sql += ' WHERE type IN ($1,$2)'; params.push('line','polygon'); }
        else if (filter === 'photo') { sql += " WHERE properties->>'type' = $1"; params.push('photo'); }
        sql += ' ORDER BY id';
        const result = await featPool.query(sql, params);
        const features = result.rows.map(r => ({
          type: 'Feature',
          id: 'f_'+r.id,
          geometry: r.geometry,
          properties: { name: r.name, type: r.type, ...(r.properties || {}) }
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ type: 'FeatureCollection', features }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // ====== POST /api/geo/marker → 创建标记（写入 PostGIS） ======
  if (reqPath === '/api/geo/marker' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);
        if (input.lat == null || input.lng == null) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '缺少 lat/lng' }));
        }
        const props = {
          name: input.name || '标记点',
          desc: input.desc || '',
          media: input.media || '',
          mediaType: input.mediaType || '',
          note: input.note || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        const result = await pgPool.query(
          `INSERT INTO features (name, type, geom, properties)
           VALUES ($1, 'point', ST_SetSRID(ST_MakePoint($2,$3),4326), $4) RETURNING id`,
          [props.name, input.lng, input.lat, JSON.stringify(props)]
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: result.rows[0].id, feature: {
          type:'Feature', id:'f_'+result.rows[0].id,
          geometry:{type:'Point',coordinates:[input.lng,input.lat]},
          properties: props
        }}));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  // ====== PUT /api/geo/marker/:id → 更新标记（PostGIS） ======
  if (reqPath.startsWith('/api/geo/marker/') && req.method === 'PUT') {
    const markerId = reqPath.split('/').pop();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);
        const id = parseInt(markerId.replace('f_',''));
        if (isNaN(id)) throw new Error('无效ID');
        const updates = [], params = [], idx = 1;
        if (input.name !== undefined) { updates.push('name=$'+idx); params.push(input.name); idx++; }
        if (input.desc !== undefined || input.note !== undefined) {
          // merge into properties JSONB
          updates.push("properties = properties || $"+idx+"::jsonb");
          const merge = {};
          if (input.desc !== undefined) merge.desc = input.desc;
          if (input.note !== undefined) merge.note = input.note;
          if (input.media !== undefined) merge.media = input.media;
          if (input.mediaType !== undefined) merge.mediaType = input.mediaType;
          merge.updatedAt = new Date().toISOString();
          params.push(JSON.stringify(merge)); idx++;
        }
        if (input.lat != null && input.lng != null) {
          updates.push('geom = ST_SetSRID(ST_MakePoint($'+idx+',$'+(idx+1)+'),4326)');
          params.push(input.lng, input.lat); idx+=2;
        }
        params.push(id);
        await pgPool.query(`UPDATE features SET ${updates.join(',')} WHERE id=$${idx}`, params);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ====== DELETE /api/geo/marker/:id → 删除要素(支持?db=) ======
  if (reqPath.startsWith('/api/geo/marker/') && req.method === 'DELETE') {
    const markerId = reqPath.split('/').pop();
    (async () => {
      try {
        const dbName = url.searchParams.get('db') || 'trip';
        const p = dbName === 'trip' ? pgPool : dbName === 'Basemap' ? basemapPool : new Pool({ database: dbName, user: 'dmuser', password: 'dmpageo123', max: 3 });
        const id = parseInt(markerId.replace('f_',''));
        if (isNaN(id)) throw new Error('无效ID');
        await p.query('DELETE FROM features WHERE id=$1', [id]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // ====== POST /api/geo/path → 创建路径/区域（PostGIS） ======
  if (reqPath === '/api/geo/path' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);
        if (!input.coords || !Array.isArray(input.coords) || input.coords.length < 2) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'coords 至少需要 2 个点' }));
        }
        const isPolygon = input.type === 'polygon';
        if (isPolygon && input.coords.length < 3) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '多边形至少需要 3 个点' }));
        }
        const coords = input.coords.map(c => [c.lng, c.lat]);
        const geom = isPolygon
          ? { type: 'Polygon', coordinates: [coords] }
          : { type: 'LineString', coordinates: coords };
        const props = {
          name: input.name || (isPolygon ? '区域' : '路径'),
          color: input.color || ('#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0')),
          type: isPolygon ? 'polygon' : 'line',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        const result = await pgPool.query(
          'INSERT INTO features (name, type, geom, properties) VALUES ($1, $2, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326))), $4) RETURNING id',
          [props.name, props.type, JSON.stringify(geom), JSON.stringify(props)]
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: result.rows[0].id }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ====== PUT /api/geo/path/:id → 更新路径 ======
  if (reqPath.startsWith('/api/geo/path/') && req.method === 'PUT') {
    const pathId = reqPath.split('/').pop();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        const db = loadMapDB();
        const idx = db.features.findIndex(f => f.id === pathId);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '路径不存在' }));
        }
        const f = db.features[idx];
        if (input.coords && Array.isArray(input.coords)) {
          const coords = input.coords.map(c => [c.lng, c.lat]);
          if (f.geometry.type === 'Polygon') f.geometry.coordinates = [coords];
          else f.geometry.coordinates = coords;
        }
        if (input.name !== undefined) f.properties.name = input.name;
        if (input.color !== undefined) f.properties.color = input.color;
        f.properties.updatedAt = new Date().toISOString();
        saveMapDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, feature: f }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ====== DELETE /api/geo/path/:id → 删除路径 ======
  if (reqPath.startsWith('/api/geo/path/') && req.method === 'DELETE') {
    const pathId = reqPath.split('/').pop();
    const db = loadMapDB();
    const idx = db.features.findIndex(f => f.id === pathId);
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '路径不存在' }));
    }
    const removed = db.features.splice(idx, 1)[0];
    saveMapDB(db);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, removed }));
    return;
  }

  // ====== GET /api/geo/photo-exif → 读取照片 EXIF GPS ======
  if (reqPath === '/api/geo/photo-exif' && req.method === 'GET') {
    const photoName = url.searchParams.get('photo');
    if (!photoName) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '缺少 photo 参数' }));
    }
    // 在 album 目录中搜索照片
    const cfg = config.paths.album;
    const albumDir = resolveDir(cfg);
    let foundPath = null;
    try {
      // 递归搜索 album 目录
      const searchDir = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) { searchDir(fp); if (foundPath) return; }
          else if (e.name === photoName || e.name === path.basename(photoName)) { foundPath = fp; return; }
        }
      };
      searchDir(albumDir);
    } catch(_) {}

    if (!foundPath || !fs.existsSync(foundPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, gps: null, message: '照片未找到' }));
    }

    try {
      const exifReader = require('exif-reader');
      const buf = fs.readFileSync(foundPath);
      // 查找 EXIF 标记
      let gps = null;
      // JPEG EXIF 解析：查找 0xFFE1 标记
      for (let i = 0; i < Math.min(buf.length - 4, 65536); i++) {
        if (buf[i] === 0xFF && buf[i+1] === 0xE1) {
          const exifLen = (buf[i+2] << 8) | buf[i+3];
          const exifStart = i + 4;
          const exifBuf = buf.subarray(exifStart, exifStart + exifLen);
          // 检查 Exif\0\0 header
          if (exifBuf.length > 6 && exifBuf.toString('ascii', 0, 6) === 'Exif\x00\x00') {
            try {
              const exif = exifReader(exifBuf.subarray(6));
              if (exif.gps && exif.gps.GPSLatitude && exif.gps.GPSLongitude) {
                gps = {
                  lat: exif.gps.GPSLatitude,
                  lng: exif.gps.GPSLongitude,
                  altitude: exif.gps.GPSAltitude || null,
                  latRef: exif.gps.GPSLatitudeRef || 'N',
                  lngRef: exif.gps.GPSLongitudeRef || 'E'
                };
              }
            } catch(_) {}
          }
          break;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, gps, file: foundPath }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, gps: null, error: e.message }));
    }
    return;
  }

  // ====== POST /api/geo/photo-location → 设置照片定位（写入 PostGIS） ======
  if (reqPath === '/api/geo/photo-location' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);
        if (!input.photoName || input.lat == null || input.lng == null) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '缺少 photoName/lat/lng' }));
        }
        const props = {
          name: input.name || input.photoName,
          photo: input.photoName,
          desc: input.desc || '',
          type: 'photo',
          updatedAt: new Date().toISOString()
        };
        // 查找已有照片要素
        const existing = await pgPool.query(
          `SELECT id FROM features WHERE properties->>'photo' = $1 AND type = 'photo' LIMIT 1`,
          [input.photoName]
        );
        if (existing.rows.length > 0) {
          props.createdAt = (await pgPool.query(`SELECT properties->>'createdAt' as c FROM features WHERE id=$1`, [existing.rows[0].id])).rows[0]?.c || props.updatedAt;
          await pgPool.query(
            `UPDATE features SET geom=ST_SetSRID(ST_MakePoint($1,$2),4326), properties=$3, name=$4, updated_at=NOW() WHERE id=$5`,
            [input.lng, input.lat, JSON.stringify(props), input.name || input.photoName, existing.rows[0].id]
          );
        } else {
          props.createdAt = props.updatedAt;
          await pgPool.query(
            `INSERT INTO features (name, type, geom, properties) VALUES ($1,'photo',ST_SetSRID(ST_MakePoint($2,$3),4326),$4)`,
            [input.name || input.photoName, input.lng, input.lat, JSON.stringify(props)]
          );
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ====== DELETE /api/geo/photo-location → 删除照片定位（按 photoName，PostGIS） ======
  if (reqPath === '/api/geo/photo-location' && req.method === 'DELETE') {
    const photoName = url.searchParams.get('photoName');
    if (!photoName) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '缺少 photoName' }));
    }
    (async () => {
      try {
        const result = await pgPool.query(
          `DELETE FROM features WHERE properties->>'photo' = $1 AND type = 'photo' RETURNING id`,
          [photoName]
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, deleted: result.rowCount }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // ====== POST /api/geo/import → 导入 GeoJSON/GPX ======
  if (reqPath === '/api/geo/import' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        if (!input.features || !Array.isArray(input.features)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '无效的 GeoJSON 格式' }));
        }
        const db = loadMapDB();
        let added = 0;
        const mode = input.mode || 'append'; // append | replace
        if (mode === 'replace') db.features = [];

        for (const f of input.features) {
          if (!f.geometry || !f.type) continue;
          // 给每个要素分配 ID
          if (!f.id) f.id = genId('im');
          if (!f.properties) f.properties = {};
          if (!f.properties.createdAt) f.properties.createdAt = new Date().toISOString();
          f.properties.updatedAt = new Date().toISOString();
          // 推断 type
          if (!f.properties.type) {
            if (f.geometry.type === 'Point') f.properties.type = f.properties.photo ? 'photo' : 'marker';
            else if (f.geometry.type === 'Polygon') f.properties.type = 'polygon';
            else f.properties.type = 'path';
          }
          db.features.push(f);
          added++;
        }
        saveMapDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, added, total: db.features.length }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ====== GET /api/geo/export → 导出 GeoJSON ======
  if (reqPath === '/api/geo/export' && req.method === 'GET') {
    const db = loadMapDB();
    const filter = url.searchParams.get('type');
    let features = db.features;
    if (filter === 'marker') features = features.filter(f => f.properties && f.properties.type === 'marker');
    if (filter === 'path') features = features.filter(f => f.properties && (f.properties.type === 'path' || f.properties.type === 'polygon'));
    if (filter === 'photo') features = features.filter(f => f.properties && f.properties.type === 'photo');

    const format = url.searchParams.get('format') || 'geojson';
    if (format === 'gpx') {
      // 导出 GPX（仅路径和标记点）
      let gpx = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="DMpage">\n';
      for (const f of features) {
        if (f.geometry.type === 'Point') {
          gpx += `  <wpt lat="${f.geometry.coordinates[1]}" lon="${f.geometry.coordinates[0]}">\n`;
          gpx += `    <name>${(f.properties.name||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</name>\n`;
          gpx += '  </wpt>\n';
        } else if (f.geometry.type === 'LineString') {
          gpx += '  <trk>\n';
          gpx += `    <name>${(f.properties.name||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</name>\n`;
          gpx += '    <trkseg>\n';
          for (const c of f.geometry.coordinates) {
            gpx += `      <trkpt lat="${c[1]}" lon="${c[0]}"></trkpt>\n`;
          }
          gpx += '    </trkseg>\n  </trk>\n';
        }
      }
      gpx += '</gpx>';
      res.writeHead(200, {
        'Content-Type': 'application/gpx+xml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="export.gpx"'
      });
      return res.end(gpx);
    }

    res.writeHead(200, {
      'Content-Type': 'application/geo+json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="export.geojson"'
    });
    res.end(JSON.stringify({ type: 'FeatureCollection', features }));
    return;
  }

  // ====== GET /api/geo/stats → 统计信息 ======
  if (reqPath === '/api/geo/stats' && req.method === 'GET') {
    const db = loadMapDB();
    const stats = {
      markers: 0, paths: 0, polygons: 0, photos: 0, videos: 0,
      totalFeatures: db.features.length,
      totalPathKm: 0,
      bounds: null
    };

    const lats = [], lngs = [];
    for (const f of db.features) {
      const props = f.properties || {};
      if (props.type === 'marker') stats.markers++;
      else if (props.type === 'path') stats.paths++;
      else if (props.type === 'polygon') stats.polygons++;
      if (props.type === 'photo' || props.photo) stats.photos++;
      if (props.mediaType === 'video') stats.videos++;

      // 计算范围
      if (f.geometry.type === 'Point') {
        lats.push(f.geometry.coordinates[1]);
        lngs.push(f.geometry.coordinates[0]);
      } else if (f.geometry.type === 'LineString') {
        for (const c of f.geometry.coordinates) {
          lats.push(c[1]); lngs.push(c[0]);
        }
        // 计算路径长度
        if (props.type === 'path') {
          let len = 0;
          for (let i = 1; i < f.geometry.coordinates.length; i++) {
            const [lng1, lat1] = f.geometry.coordinates[i-1];
            const [lng2, lat2] = f.geometry.coordinates[i];
            const dLat = (lat2-lat1)*Math.PI/180, dLon = (lng2-lng1)*Math.PI/180;
            const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
            len += 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          }
          stats.totalPathKm += len;
        }
      }
    }

    if (lats.length > 0) {
      stats.bounds = {
        north: Math.max(...lats), south: Math.min(...lats),
        east: Math.max(...lngs), west: Math.min(...lngs)
      };
    }

    // 也统计 geodata 目录里的媒体文件
    try {
      if (fs.existsSync(geodataDir)) {
        const scanDir = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) { scanDir(path.join(dir, e.name)); continue; }
            if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(e.name)) stats.photos++;
            else if (/\.(mp4|webm|mkv|mov|avi)$/i.test(e.name)) stats.videos++;
          }
        };
        scanDir(geodataDir);
      }
    } catch(_) {}

    stats.totalPathKm = Math.round(stats.totalPathKm * 100) / 100;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(stats));
    return;
  }

  // ====== POST /save-admin-regions → 保存行政区划数据 ======
  if (reqPath === '/save-admin-regions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!Array.isArray(data)) throw new Error('需要数组');
        fs.writeFileSync(path.join(ROOT, 'admin-regions.json'), JSON.stringify(data, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: data.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ====== GET /api/geo/regional-stats → 选库要素 + Basemap边界 ======
  if (reqPath === '/api/geo/regional-stats' && req.method === 'GET') {
    (async () => {
    try {
      const featDb = url.searchParams.get('db') || 'trip';
      const featPool = featDb === 'trip' ? pgPool : featDb === 'Basemap' ? basemapPool : new Pool({ database: featDb, user: 'dmuser', password: 'dmpageo123', max: 3 });
      // 读要素(来自选的库)
      const feats = await featPool.query("SELECT id, name, type, ST_X(ST_Centroid(geom)) AS lng, ST_Y(ST_Centroid(geom)) AS lat FROM features");
      // 边界始终从 Basemap 读
      const provs = await basemapPool.query("SELECT name, geom FROM provinces");
      const cities = await basemapPool.query("SELECT name, geom FROM cities");
      const dists = await basemapPool.query("SELECT name, geom FROM districts");

      const pMap = {};
      for (const f of feats.rows) {
        // 找省
        let pn = '海外/未知', cn = '海外/未知', dn = '海外/未知';
        for (const p of provs.rows) {
          const r = await basemapPool.query("SELECT ST_Contains($1, ST_SetSRID(ST_MakePoint($2,$3),4326)) AS ok", [p.geom, f.lng, f.lat]);
          if (r.rows[0].ok) { pn = p.name; break; }
        }
        // 找市
        for (const c of cities.rows) {
          const r = await basemapPool.query("SELECT ST_Contains($1, ST_SetSRID(ST_MakePoint($2,$3),4326)) AS ok", [c.geom, f.lng, f.lat]);
          if (r.rows[0].ok) { cn = c.name; break; }
        }
        // 找区县
        for (const d of dists.rows) {
          const r = await basemapPool.query("SELECT ST_Contains($1, ST_SetSRID(ST_MakePoint($2,$3),4326)) AS ok", [d.geom, f.lng, f.lat]);
          if (r.rows[0].ok) { dn = d.name; break; }
        }
        if (!pMap[pn]) pMap[pn] = {};
        if (!pMap[pn][cn]) pMap[pn][cn] = {};
        if (!pMap[pn][cn][dn]) pMap[pn][cn][dn] = { points:0, lines:0, polygons:0, timePaths:0, total:0, coords:[] };
        const rc = pMap[pn][cn][dn];
        if (f.type === 'point') rc.points++; else if (f.type === 'line') rc.lines++; else if (f.type === 'polygon') rc.polygons++;
        rc.total++;
        if (f.lng) rc.coords.push({lng: Math.round(f.lng*10000)/10000, lat: Math.round(f.lat*10000)/10000, name: f.name});
      }

      const provinces = [];
      for (const pn of Object.keys(pMap).sort()) {
        const cityList = [];
        for (const cn of Object.keys(pMap[pn]).sort()) {
          const distList = [];
          for (const dn of Object.keys(pMap[pn][cn]).sort()) {
            const d = pMap[pn][cn][dn];
            if (dn === '海外/未知') continue;
            if (d.total === 0) continue;
            distList.push({name:dn, points:d.points, lines:d.lines, polygons:d.polygons, timePaths:d.timePaths, total:d.total, coords:d.coords});
          }
          const ct = distList.reduce((s,x)=>s+x.total,0);
          if (cn !== '海外/未知' && ct > 0)
            cityList.push({name:cn, points:distList.reduce((s,x)=>s+x.points,0), lines:distList.reduce((s,x)=>s+x.lines,0), polygons:distList.reduce((s,x)=>s+x.polygons,0), timePaths:0, total:ct, coords:distList.flatMap(x=>x.coords), districts:distList});
        }
        const ct2 = cityList.reduce((s,x)=>s+x.total,0);
        if (pn !== '海外/未知' && ct2 > 0)
          provinces.push({name:pn, cities:cityList, total:ct2, points:cityList.reduce((s,x)=>s+x.points,0), lines:cityList.reduce((s,x)=>s+x.lines,0), polygons:cityList.reduce((s,x)=>s+x.polygons,0)});
      }
      provinces.sort((a,b)=>b.total-a.total);
      const countries = [];
      const coveredProvs = provinces.filter(p=>p.total>0);
      const coveredCities = new Set(), coveredDistricts = new Set();
      for (const p of coveredProvs) {
        for (const c of p.cities) { if (c.total>0) coveredCities.add(c.name);
          for (const d of (c.districts||[])) { if (d.total>0) coveredDistricts.add(d.name); }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ provinces, countries, summary: { totalFeatures: feats.rows.length, totalProvinces: coveredProvs.length, totalCities: coveredCities.size, totalDistricts: coveredDistricts.size, totalCountries: countries.length } }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    })();
    return;
  }


  // ====== DELETE /api/geo/clear → 清空全部数据 ======
  if (reqPath === '/api/geo/clear' && req.method === 'DELETE') {
    const confirmKey = url.searchParams.get('confirm');
    if (confirmKey !== 'yes') {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '需要 ?confirm=yes 确认清空' }));
    }
    saveMapDB({ type: 'FeatureCollection', features: [] });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: '全部地理数据已清空' }));
    return;
  }

  // ====== 兼容旧接口（保留向后兼容） ======

  // POST /save-geodata → 写入数据库(支持 ?db=)
  if (reqPath === '/save-geodata' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const dbName = url.searchParams.get('db') || 'trip';
        const p = dbName === 'trip' ? pgPool : dbName === 'Basemap' ? pgPool : new Pool({ database: dbName, user: 'dmuser', password: 'dmpageo123', max: 3 });
        const geojson = JSON.parse(body);
        if (!geojson.features) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '缺少 features 数组' }));
        }
        // 按 clientId 做 UPSERT（兼容旧数据无 clientId 时用 name+type 匹配）
        let added = 0;
        if (geojson.features.length === 0) {
          // 空数组 → 全量清空
          await p.query('DELETE FROM features');
        } else {
          for (const f of geojson.features) {
            const props = f.properties || {};
            const cid = props.clientId;
            const type = props.type || (f.geometry.type === 'Point' ? 'point' : f.geometry.type === 'LineString' ? 'line' : 'polygon');
            if (cid) {
              await p.query("DELETE FROM features WHERE properties->>'clientId' = $1", [cid]);
            } else {
              // 无 clientId 的旧数据：按 name + type 去重
              await p.query("DELETE FROM features WHERE properties->>'name' = $1 AND type = $2", [props.name || '', type]);
            }
            await p.query(
              'INSERT INTO features (name, type, geom, properties) VALUES ($1, $2, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326))), $4)',
              [props.name || '', type, JSON.stringify(f.geometry), JSON.stringify(props)]
            );
            added++;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, added, total: added }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/update-photo-location → 兼容旧照片定位接口
  if (reqPath === '/api/update-photo-location' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        const db = loadMapDB();
        const existingIdx = db.features.findIndex(f =>
          f.properties && f.properties.photo === input.photoName
        );
        const feature = {
          type: 'Feature',
          id: genId('ph'),
          geometry: { type: 'Point', coordinates: [input.lng, input.lat] },
          properties: {
            name: input.newName || input.photoName,
            photo: input.photoName,
            type: 'photo',
            updatedAt: new Date().toISOString()
          }
        };
        if (existingIdx >= 0) {
          feature.id = db.features[existingIdx].id;
          feature.properties.createdAt = db.features[existingIdx].properties.createdAt || feature.properties.updatedAt;
          db.features[existingIdx] = feature;
        } else {
          feature.properties.createdAt = feature.properties.updatedAt;
          db.features.push(feature);
        }
        saveMapDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/geodata-stats → 兼容旧统计接口
  if (reqPath === '/api/geodata-stats' && req.method === 'GET') {
    const db = loadMapDB();
    const stats = { photos: 0, videos: 0, groups: 0, markers: 0, paths: 0, geoFiles: [] };
    for (const f of db.features) {
      const p = f.properties || {};
      if (f.geometry.type === 'Point') stats.markers++;
      else stats.paths++;
      if (p.type === 'photo' || p.photo) stats.photos++;
      if (p.mediaType === 'video') stats.videos++;
    }
    try {
      if (fs.existsSync(geodataDir)) {
        const entries = fs.readdirSync(geodataDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) { stats.groups++; continue; }
          if (/\.(geojson|json|gpx)$/i.test(e.name) && e.name !== 'map-data.geojson') stats.geoFiles.push(e.name);
        }
      }
    } catch(_) {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(stats));
    return;
  }

  // POST /upload-photo → 上传媒体到要素专属目录
  if (reqPath === '/upload-photo' && req.method === 'POST') {
    const gdDir = resolveDir(config.paths.geodata);
    if (!fs.existsSync(gdDir)) fs.mkdirSync(gdDir, { recursive: true });

    // 支持 ?feature=xxx 参数指定要素 ID 子目录
    const featureId = url.searchParams.get('feature') || 'general';

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        let filename = 'upload.bin';
        let fileData = buffer;

        if (boundaryMatch) {
          const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '');
          const boundaryBuf = Buffer.from('--' + boundary, 'latin1');
          const endBoundaryBuf = Buffer.from('--' + boundary + '--', 'latin1');
          const crlfcrlf = Buffer.from('\r\n\r\n', 'latin1');

          const firstBoundary = buffer.indexOf(boundaryBuf);
          if (firstBoundary !== -1) {
            const headerStart = firstBoundary + boundaryBuf.length + 2;
            const headerEnd = buffer.indexOf(crlfcrlf, headerStart);
            if (headerEnd !== -1) {
              const headerStr = buffer.subarray(headerStart, headerEnd).toString('latin1');
              const fnStarMatch = headerStr.match(/filename\*=UTF-8''([^;\s]+)/i);
              if (fnStarMatch) {
                try { filename = decodeURIComponent(fnStarMatch[1]); } catch(_) { filename = fnStarMatch[1]; }
              } else {
                const fnMatch = headerStr.match(/filename="([^"]+)"/);
                if (fnMatch) {
                  try { filename = Buffer.from(fnMatch[1], 'latin1').toString('utf8'); } catch(_) { filename = fnMatch[1]; }
                }
              }
              filename = filename.replace(/[\\\/:*?"<>|]/g, '_');

              const contentStart = headerEnd + 4;
              const nextBoundary = buffer.indexOf(boundaryBuf, contentStart);
              if (nextBoundary !== -1) {
                fileData = buffer.subarray(contentStart, nextBoundary - 2);
              } else {
                const endBoundary = buffer.indexOf(endBoundaryBuf, contentStart);
                fileData = endBoundary !== -1 ? buffer.subarray(contentStart, endBoundary - 2) : buffer.subarray(contentStart);
              }
            }
          }
        }

        // 按要素 ID 分目录
        const featureDir = path.join(gdDir, featureId);
        if (!fs.existsSync(featureDir)) fs.mkdirSync(featureDir, { recursive: true });

        const base = filename.replace(/\.\w+$/, '');
        const ext = path.extname(filename) || '.bin';
        let finalName = filename;
        let counter = 1;
        while (fs.existsSync(path.join(featureDir, finalName))) {
          finalName = base + '_' + (counter++) + ext;
        }

        fs.writeFileSync(path.join(featureDir, finalName), fileData);
        delete cache['geodata-list'];

        const relPath = 'media/geodata/' + featureId + '/' + finalName;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, file: relPath, name: finalName, featureId: featureId }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ====== GET /api/geo/media → 浏览要素媒体文件 ======
  if (reqPath === '/api/geo/media' && req.method === 'GET') {
    const gdDir = resolveDir(config.paths.geodata);
    const featureFilter = url.searchParams.get('feature');
    const result = [];

    try {
      if (!fs.existsSync(gdDir)) { res.end(JSON.stringify([])); return; }
      const entries = fs.readdirSync(gdDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const featureId = e.name;
        if (featureFilter && featureId !== featureFilter) continue;
        const featureDir = path.join(gdDir, featureId);
        const files = fs.readdirSync(featureDir).filter(f => /\.(jpg|jpeg|png|gif|webp|mp4|webm|mkv|mov)$/i.test(f));
        for (const f of files) {
          const stat = fs.statSync(path.join(featureDir, f));
          result.push({
            featureId,
            file: 'media/geodata/' + featureId + '/' + f,
            name: f,
            size: stat.size,
            isVideo: /\.(mp4|webm|mkv|mov)$/i.test(f),
            mtime: stat.mtime.toISOString()
          });
        }
      }
      result.sort((a, b) => b.mtime.localeCompare(a.mtime));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ====== DELETE /api/geo/media → 删除要素媒体目录 ======
  if (reqPath === '/api/geo/media' && req.method === 'DELETE') {
    const gdDir = resolveDir(config.paths.geodata);
    const featureId = url.searchParams.get('feature');
    if (!featureId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '需要 feature 参数' }));
    }
    try {
      const targetDir = path.join(gdDir, featureId);
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true });
        delete cache['geodata-list'];
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ====== GET /api/geo/boundaries → 获取省/市/国矢量边界 ======
  if (reqPath === '/api/geo/boundaries' && req.method === 'GET') {
    const type = url.searchParams.get('type') || 'provinces'; // provinces | cities | countries
    const province = url.searchParams.get('province'); // 筛选某省的城市
    (async () => {
      try {
        let sql, params=[];
        if (type === 'countries') {
          sql = 'SELECT id, name, ST_AsGeoJSON(ST_Simplify(geom,0.05))::json AS geometry FROM countries ORDER BY name';
        } else if (type === 'cities') {
          if (province) {
            sql = `SELECT c.id, c.name, c.province_code, ST_AsGeoJSON(ST_Simplify(c.geom,0.01))::json AS geometry
                   FROM cities c, provinces p
                   WHERE p.name = $1
                     AND (c.province_code LIKE (p.code || '%') OR p.code = '' OR p.code IS NULL)
                   ORDER BY c.name`;
            params.push(province);
          } else {
            sql = 'SELECT id, name, province_code, ST_AsGeoJSON(ST_Simplify(geom,0.01))::json AS geometry FROM cities ORDER BY name';
          }
        } else {
          sql = 'SELECT id, name, code, ST_AsGeoJSON(ST_Simplify(geom,0.02))::json AS geometry FROM provinces ORDER BY name';
        }
        const result = await basemapPool.query(sql, params);
        const features = result.rows.map(r => ({
          type: 'Feature',
          id: r.id,
          properties: { name: r.name, code: r.code || r.province_code || '' },
          geometry: r.geometry
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ type: 'FeatureCollection', features }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // ====== 行政区划 CRUD API（PostGIS） ======

  // POST /api/geo/boundaries → 创建新区域
  if (reqPath === '/api/geo/boundaries' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);
        const table = input.type; // countries | provinces | cities
        if (!['countries','provinces','cities'].includes(table)) throw new Error('无效 type，需为 countries/provinces/cities');
        if (!input.name) throw new Error('缺少 name');
        if (!input.geometry || !input.geometry.coordinates) throw new Error('缺少 geometry');

        const geom = input.geometry.type === 'Polygon'
          ? { type: 'MultiPolygon', coordinates: [input.geometry.coordinates] }
          : input.geometry;

        if (table === 'cities') {
          const result = await pgPool.query(
            `INSERT INTO cities (name, province_code, geom) VALUES ($1, $2, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)),3))) RETURNING id`,
            [input.name, input.code || '', JSON.stringify(geom)]
          );
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, id: result.rows[0].id, table }));
        } else if (table === 'provinces') {
          const result = await pgPool.query(
            `INSERT INTO provinces (name, code, geom) VALUES ($1, $2, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)),3))) RETURNING id`,
            [input.name, input.code || '', JSON.stringify(geom)]
          );
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, id: result.rows[0].id, table }));
        } else {
          const result = await pgPool.query(
            `INSERT INTO countries (name, geom) VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2),4326)) RETURNING id`,
            [input.name, JSON.stringify(geom)]
          );
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, id: result.rows[0].id, table }));
        }
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // PUT /api/geo/boundaries/:id → 更新区域
  if (reqPath.match(/^\/api\/geo\/boundaries\/\d+$/) && req.method === 'PUT') {
    const id = parseInt(reqPath.split('/').pop());
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);
        const table = input.type; // countries | provinces | cities
        if (!['countries','provinces','cities'].includes(table)) throw new Error('无效 type');

        const updates = [], params = [];
        let idx = 1;

        if (input.name) { updates.push('name=$'+idx); params.push(input.name); idx++; }
        if (input.code !== undefined && table !== 'countries') {
          updates.push(table==='cities'?'province_code=$'+idx:'code=$'+idx);
          params.push(input.code); idx++;
        }
        if (input.geometry && input.geometry.coordinates) {
          const geom = input.geometry.type === 'Polygon'
            ? { type: 'MultiPolygon', coordinates: [input.geometry.coordinates] }
            : input.geometry;
          updates.push('geom=ST_SetSRID(ST_GeomFromGeoJSON($'+idx+'),4326)');
          params.push(JSON.stringify(geom)); idx++;
        }

        if (!updates.length) throw new Error('无更新字段');
        params.push(id);
        await pgPool.query(`UPDATE ${table} SET ${updates.join(',')} WHERE id=$${idx}`, params);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/geo/boundaries/upload → 批量上传 GeoJSON 导入边界
  if (reqPath === '/api/geo/boundaries/upload' && req.method === 'POST') {
    const table = url.searchParams.get('type'); // countries | provinces | cities
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        if (!['countries','provinces','cities'].includes(table)) throw new Error('需要 ?type=countries|provinces|cities');
        const geojson = JSON.parse(body);
        if (!geojson.features || !geojson.features.length) throw new Error('GeoJSON 无 features');

        let inserted = 0, skipped = 0, errors = [];
        for (const feat of geojson.features) {
          try {
            const name = (feat.properties && feat.properties.name) || feat.properties.Name || feat.properties.NAME || '未命名';
            const code = (feat.properties && (feat.properties.code || feat.properties.Code || feat.properties.CODE || feat.properties.province_code || '')) || '';
            if (!feat.geometry) { skipped++; continue; }
            const geom = feat.geometry.type === 'Polygon'
              ? { type: 'MultiPolygon', coordinates: [feat.geometry.coordinates] }
              : feat.geometry;

            if (table === 'cities') {
              await pgPool.query(
                `INSERT INTO cities (name, province_code, geom) VALUES ($1,$2,ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)),3))) ON CONFLICT DO NOTHING`,
                [name, code, JSON.stringify(geom)]
              );
            } else if (table === 'provinces') {
              await pgPool.query(
                `INSERT INTO provinces (name, code, geom) VALUES ($1,$2,ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)),3))) ON CONFLICT DO NOTHING`,
                [name, code, JSON.stringify(geom)]
              );
            } else {
              await pgPool.query(
                `INSERT INTO countries (name, geom) VALUES ($1,ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2),4326)),3))) ON CONFLICT DO NOTHING`,
                [name, JSON.stringify(geom)]
              );
            }
            inserted++;
          } catch(feErr) { errors.push(feErr.message); skipped++; }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, inserted, skipped, errors: errors.slice(0, 5) }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // DELETE /api/geo/boundaries/:id → 删除区域
  if (reqPath.match(/^\/api\/geo\/boundaries\/\d+$/) && req.method === 'DELETE') {
    const id = parseInt(reqPath.split('/').pop());
    const table = url.searchParams.get('type'); // countries | provinces | cities
    (async () => {
      try {
        if (!['countries','provinces','cities'].includes(table)) throw new Error('需要 ?type=countries|provinces|cities');
        await pgPool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // GET /api/browse → 浏览目录

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

  // ====== PostGIS 数据库管理 API (/api/pg/) ======
  if (reqPath.startsWith('/api/pg/')) {
    handlePgApi(req, res, reqPath, req.method);
    return;
  }

  // 虚拟挂载：/media/geodata/ → geodata 实际目录
  if (reqPath.startsWith('/media/geodata/')) {
    const realDir = resolveDir(config.paths.geodata);
    const relative = reqPath.slice('/media/geodata/'.length);
    const realPath = path.join(realDir, relative);
    if (path.normalize(realPath).startsWith(path.normalize(realDir) + path.sep) || path.normalize(realPath) === path.normalize(realDir)) {
      return serveFile(realPath, res);
    }
    res.writeHead(403); return res.end('Forbidden');
  }

  // 静态文件（支持 Range 请求，视频播放必需）
  if (reqPath === '/') reqPath = '/index.html';


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
  console.log('  ║     DMgeo 地理统计                     ║');
  for (const ip of ips) {
    const url = 'http://' + ip + ':' + PORT;
    console.log('  ║     ' + url + ' '.repeat(34 - url.length) + '║');
  }
  console.log('  ║                                      ║');
  console.log('  ║  开机自启: systemctl enable dm-page   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
