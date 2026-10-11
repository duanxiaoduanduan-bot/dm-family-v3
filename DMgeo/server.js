const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Pool, Client } = require('pg');

const PORT = process.env.PORT || 8084;
const ROOT = __dirname;
const { loadStorageConfig, resolveDir } = require('./storage');
const config = loadStorageConfig();
const dbCfg = config.database;

// ===== PostgreSQL/PostGIS 连接池 =====
const pgPool = new Pool({        // trip — 主库(要素+边界缓存)
  host: dbCfg.host, port: dbCfg.port,
  database: dbCfg.featureDb,
  user: dbCfg.user,
  password: dbCfg.password,
  max: 10
});
const basemapPool = new Pool({   // Basemap — 底图原档(不动)
  host: dbCfg.host, port: dbCfg.port,
  database: dbCfg.basemapDb,
  user: dbCfg.user,
  password: dbCfg.password,
  max: 10
});
// 管理连接�� — 连 postgres 库, 用于 CREATE/DROP DATABASE
const adminPool = new Pool({     // 连 postgres 库, 用于 CREATE/DROP DATABASE
  host: dbCfg.host, port: dbCfg.port,
  database: dbCfg.adminDb,
  user: dbCfg.user,
  password: dbCfg.password,
  max: 3
});

// ===== 要素库连接池缓存 =====
// 之前多处 `new Pool({database:dbName})` 每请求新建且不 end，既泄漏连接，
// 又出现 `db=Basemap` 误落到 pgPool(trip) 的写库事故。统一走这里。
const _featPools = { trip: pgPool, Basemap: basemapPool };
function getFeaturePool(dbName) {
  const db = dbName || 'trip';
  if (!_featPools[db]) _featPools[db] = new Pool({ host: dbCfg.host, port: dbCfg.port, database: db, user: dbCfg.user, password: dbCfg.password, max: 3 });
  return _featPools[db];
}
// 库名/标识符加引号（库名可能含空格，如 "Financial Assets"）
const qIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';

// ===== 超级用户探测 =====
// dmuser 只有 LOGIN+CREATEDB，没有 SUPERUSER，`CREATE EXTENSION postgis` 必然失败。
// 新建库时该失败被 catch 吞掉，导致库建出来了却既无 postgis 也无 features 表
// （表现为“新库的数据不进统计”）。这里探测一个真正的超级用户来做扩展/授权。
let _superUser; // undefined=未探测 / string=用户名 / false=没有可用超级用户
async function resolveSuperUser() {
  if (_superUser !== undefined) return _superUser;
  const cands = [];
  if (process.env.PGSUPERUSER) cands.push(process.env.PGSUPERUSER);
  try { cands.push(os.userInfo().username); } catch (_) {}
  cands.push('postgres');
  for (const u of cands.filter(Boolean)) {
    const c = new Client({ host: dbCfg.host, port: dbCfg.port, database: dbCfg.adminDb, user: u });
    try {
      await c.connect();
      const r = await c.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
      if (r.rows[0] && r.rows[0].rolsuper) { _superUser = u; console.log('  🔑 PG 超级用户:', u); return u; }
    } catch (_) { /* 换下一个候选 */ }
    finally { try { await c.end(); } catch (_) {} }
  }
  _superUser = false;
  console.warn('  ⚠️  未找到 PG 超级用户，新建库可能缺少 postgis 扩展');
  return false;
}

// ===== 库结构自愈：确保目标库有 postgis 扩展 + 标准 features 表 + dmuser 权限 =====
// 既用于新建库，也用于修复历史上“建了但没建全”的库（首次访问时自动补齐）。
const _ensuredDbs = new Set();
async function ensureFeatureStore(dbName, force) {
  const db = dbName || 'trip';
  if (!force && _ensuredDbs.has(db)) return { ok: true, cached: true };
  const notes = [];
  const su = await resolveSuperUser();
  const DDL_TABLE = `CREATE TABLE IF NOT EXISTS features (
    id SERIAL PRIMARY KEY,
    name TEXT,
    type TEXT DEFAULT 'point',
    geom geometry(Geometry,4326),
    properties JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
  )`;
  const DDL_INDEX = 'CREATE INDEX IF NOT EXISTS idx_features_geom ON features USING GIST (geom)';
  // 计划任务表（补充时间计划）：创建时即带计划时间 plan_at
  // 可挂钩地图要素（feature_id/feature_name），并对地点/时间/任务分别备注
  // parent_id：全链计划的父子关系——路径主计划为空，沿途每个节点子任务指向主计划
  const DDL_PLANS = `CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    detail TEXT DEFAULT '',
    plan_at TIMESTAMP,
    done BOOLEAN DEFAULT FALSE,
    priority TEXT DEFAULT 'normal',
    feature_id TEXT,
    feature_name TEXT,
    place_note TEXT DEFAULT '',
    time_note TEXT DEFAULT '',
    task_note TEXT DEFAULT '',
    parent_id INTEGER REFERENCES plans(id) ON DELETE CASCADE,
    stop_seq INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`;
  const DDL_PLANS_IDX = 'CREATE INDEX IF NOT EXISTS idx_plans_at ON plans (plan_at)';
  const DDL_PLANS_PARENT_IDX = 'CREATE INDEX IF NOT EXISTS idx_plans_parent ON plans (parent_id, stop_seq)';
  // 计划任务「途经点明细」：挂钩路径后，按路径顶点逐点排期（时间/任务/补充）
  const DDL_PLAN_STOPS = `CREATE TABLE IF NOT EXISTS plan_stops (
    id SERIAL PRIMARY KEY,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    seq INTEGER DEFAULT 0,
    stop_name TEXT DEFAULT '',
    lng DOUBLE PRECISION,
    lat DOUBLE PRECISION,
    stop_at TIMESTAMP,
    stop_task TEXT DEFAULT '',
    stop_note TEXT DEFAULT ''
  )`;
  const DDL_PLAN_STOPS_IDX = 'CREATE INDEX IF NOT EXISTS idx_plan_stops_plan ON plan_stops (plan_id, seq)';
  // 兼容旧表：补列（老库已建有旧结构 plans 表时）
  const DDL_PLANS_MIGRATE = [
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS feature_id TEXT',
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS feature_name TEXT',
    "ALTER TABLE plans ADD COLUMN IF NOT EXISTS place_note TEXT DEFAULT ''",
    "ALTER TABLE plans ADD COLUMN IF NOT EXISTS time_note TEXT DEFAULT ''",
    "ALTER TABLE plans ADD COLUMN IF NOT EXISTS task_note TEXT DEFAULT ''",
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS parent_id INTEGER',
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS stop_seq INTEGER',
    // 自引用外键：老库补列时只有裸列、没有约束，删除父计划会留下孤儿子任务
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_parent_fk') THEN
         ALTER TABLE plans ADD CONSTRAINT plans_parent_fk
           FOREIGN KEY (parent_id) REFERENCES plans(id) ON DELETE CASCADE;
       END IF;
     END $$`
  ];
  if (su) {
    const c = new Client({ host: dbCfg.host, port: dbCfg.port, database: db, user: su });
    try {
      await c.connect();
      await c.query('CREATE EXTENSION IF NOT EXISTS postgis');
      await c.query(DDL_TABLE);
      await c.query(DDL_INDEX);
      await c.query(DDL_PLANS);
      await c.query(DDL_PLANS_IDX);
      await c.query(DDL_PLANS_PARENT_IDX);
      await c.query(DDL_PLAN_STOPS);
      await c.query(DDL_PLAN_STOPS_IDX);
      for (const m of DDL_PLANS_MIGRATE) { try { await c.query(m); } catch (_) {} }
      // dmuser 是各服务的运行账号，必须能读写；否则 regional-stats/列要素会 permission denied
      await c.query('GRANT ALL ON SCHEMA public TO dmuser');
      await c.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO dmuser');
      await c.query('GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO dmuser');
      await c.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO dmuser');
      await c.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO dmuser');
      _ensuredDbs.add(db);
      return { ok: true, superuser: su };
    } catch (e) {
      notes.push('超级用户初始化失败: ' + e.message);
    } finally { try { await c.end(); } catch (_) {} }
  }
  // 降级：用 dmuser 尽力而为（postgis 可能已由 template1 继承而来）
  try {
    const p = getFeaturePool(db);
    try { await p.query('CREATE EXTENSION IF NOT EXISTS postgis'); }
    catch (e) { notes.push('postgis 扩展需超级用户: ' + e.message); }
    await p.query(DDL_TABLE);
    await p.query(DDL_INDEX);
    await p.query(DDL_PLANS);
    await p.query(DDL_PLANS_IDX);
    await p.query(DDL_PLANS_PARENT_IDX);
    await p.query(DDL_PLAN_STOPS);
    await p.query(DDL_PLAN_STOPS_IDX);
    for (const m of DDL_PLANS_MIGRATE) { try { await p.query(m); } catch (_) {} }
    _ensuredDbs.add(db);
    return { ok: true, degraded: true, notes };
  } catch (e) {
    notes.push(e.message);
    return { ok: false, notes };
  }
}

// 统计镜像表：**必须独立于 Basemap.features**。
// 早期把镜像直接写进 Basemap.features，导致 Basemap 自己被选为数据库时形成自引用——
// 源表就是镜像表，读到的是“上一次查询的那个库”的残留，选 Basemap 时统计会跟着别的库变。
// 独立成 Basemap.stats_features 后：Basemap.features 只代表 Basemap 自己的要素（源），
// stats_features 只做镜像（目标），任何库（含 Basemap）都严格按库独立统计。
const STATS_MIRROR = 'stats_features';
let _mirrorReady = false;
async function ensureStatsMirror() {
  if (_mirrorReady) return;
  await basemapPool.query(`CREATE TABLE IF NOT EXISTS ${STATS_MIRROR} (
    id SERIAL PRIMARY KEY,
    name TEXT,
    type TEXT DEFAULT 'point',
    geom geometry(Geometry,4326),
    properties JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await basemapPool.query(`CREATE INDEX IF NOT EXISTS idx_${STATS_MIRROR}_geom ON ${STATS_MIRROR} USING GIST (geom)`);
  // 边界表 GIST 索引：regional-stats 的空间 JOIN(ST_Contains) 依赖它才能走索引，
  // 否则退化为“要素数 × 边界数”的全表扫描，几百要素就分钟级卡死。
  await basemapPool.query(`CREATE INDEX IF NOT EXISTS idx_provinces_geom ON provinces USING GIST (geom)`);
  await basemapPool.query(`CREATE INDEX IF NOT EXISTS idx_cities_geom ON cities USING GIST (geom)`);
  await basemapPool.query(`CREATE INDEX IF NOT EXISTS idx_districts_geom ON districts USING GIST (geom)`);
  await basemapPool.query(`CREATE INDEX IF NOT EXISTS idx_countries_geom ON countries USING GIST (geom)`);
  _mirrorReady = true;
}

// 串行化“选中库要素 → Basemap.stats_features”的同步：regional-stats 是 GET 但有清写副作用，
// 并发调用（切库/多面板重渲）可能互相覆盖或重复清写；用模块级 promise 链串行化，
// 任一同步失败不影响后续调用链。
let _statsSyncChain = Promise.resolve();
async function syncFeaturesToBasemap(featPool, dbName) {
  const run = _statsSyncChain.then(async () => {
    await ensureStatsMirror();
    let rows = [];
    try {
      // “放进来”：把选中库的要素同步进 Basemap.stats_features（统计镜像表），
      // 统计统一从镜像读——对应“trip/其他数据库放进来会点亮底图并统计”的架构。
      rows = (await featPool.query(
        "SELECT name, type, COALESCE(properties,'{}'::jsonb) AS properties, ST_AsGeoJSON(geom) AS geom FROM features"
      )).rows;
    } catch (e) {
      // 源库没有 features 表（新建库常见）→ 先自愈补建，再重试一次
      console.warn('[regional-stats] 读取源库要素失败，尝试补建 features 表:', e.message);
      try {
        await ensureFeatureStore(dbName);
        rows = (await featPool.query(
          "SELECT name, type, COALESCE(properties,'{}'::jsonb) AS properties, ST_AsGeoJSON(geom) AS geom FROM features"
        )).rows;
      } catch (e2) {
        // 仍失败：视为“该库无要素”。**不能沿用上一个库的镜像**，否则切库后统计显示的是
        // 别的库的数据（新建库“数据不进统计”的直接原因）。按库独立 → 同步为空集。
        console.warn('[regional-stats] 源库无可用要素，按空集统计:', e2.message);
        rows = [];
      }
    }
    // 镜像写入（含空集：空集即代表“该库没有要素”，必须真的把镜像清空）
    const bc = await basemapPool.connect();
    try {
      await bc.query('BEGIN');
      await bc.query(`DELETE FROM ${STATS_MIRROR}`);
      for (const sf of rows) {
        await bc.query(
          `INSERT INTO ${STATS_MIRROR} (name, type, geom, properties) VALUES ($1,$2,ST_SetSRID(ST_GeomFromGeoJSON($3),4326),$4)`,
          [sf.name, sf.type, sf.geom, sf.properties]
        );
      }
      await bc.query('COMMIT');
    } catch (e) {
      try { await bc.query('ROLLBACK'); } catch (_) {}
      console.warn(`[regional-stats] 写入 Basemap.${STATS_MIRROR} 镜像失败:`, e.message);
    } finally {
      bc.release();
    }
  });
  // 吞掉链内错误，保证后续同步可继续；run 本身仍反映本次是否成功
  _statsSyncChain = run.then(() => {}, () => {});
  return run;
}

// 启动时测试连接
pgPool.query('SELECT PostGIS_version()').then(r => {
  console.log('  🗄️  PostGIS:', r.rows[0].postgis_version.split(' ')[0]);
}).catch(e => {
  console.error('  ⚠️  PostGIS 连接失败:', e.message);
});

// ===== 存储配置（见 storage.js：loadStorageConfig / resolveDir）=====

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
  const cfg = config.paths.data;
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
  // 按数据库名缓存连接池（统一走模块级缓存，避免每请求新建 Pool 泄漏连接）
  const pool = () => getFeaturePool(dbName);
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
      await adminPool.query(`CREATE DATABASE ${qIdent(body.name)} OWNER dmuser`);
      // 建库后补齐 postgis 扩展 + 标准 features 表 + dmuser 授权。
      // 注意：CREATE EXTENSION 必须超级用户，dmuser 干不了 —— 旧代码在这里静默失败，
      // 结果库建出来却没有 features 表，该库的数据永远进不了统计。
      const st = await ensureFeatureStore(body.name, true);
      if (!st.ok) {
        return sendJson(res, 200, { ok: true, warning: true, message: `数据库 ${body.name} 已创建，但初始化不完整: ${(st.notes || []).join('; ')}` });
      }
      return sendJson(res, 200, { ok: true, message: `数据库 ${body.name} 已创建(含 PostGIS + features 表)` });
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
        if (v && typeof v === 'object') {
          if (v.type === 'Point' && v.coordinates)
            return `"${k}" = ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(v)}'), 4326)`;
          return `"${k}" = '${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
        }
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

  // ===== 整库导出 / 导入（zsql JSON 归档）=====
  // 设计要点：
  //  1. 不用 pg_dump/pg_restore —— 纯 Node 实现，跨机器、跨 PG 版本都能用。
  //  2. 表名/列名/列顺序/几何列名全部按原样还原，不做任何猜测。
  //  3. 导入走单事务，失败整体回滚，不留半截库。

  // 把归档里的列信息还原成可执行的列定义（字段名须与 dumpDatabase 产出一致）
  const buildColumnDef = (c) => {
    const u = (c.udt || '').toLowerCase();
    if (u === 'geometry') {
      const gt = c.geometryType || 'Geometry';
      const srid = c.srid === null || c.srid === undefined ? 4326 : c.srid;
      return `geometry(${gt},${srid})`;
    }
    if (u === 'jsonb') return 'JSONB';
    if (u === 'json') return 'JSON';
    // 关键：SERIAL 列（默认值形如 nextval('xxx_seq')）不能原样带 DEFAULT——
    // 旧序列名在新库里不存在，建表会直接失败（relation "xxx_id_seq" does not exist）。
    // 改成显式 SERIAL/BIGSERIAL，让 PostgreSQL 自己建对应的新序列，导入后由 setval 归位。
    // 用原始类型名判大小（int4→SERIAL / int8→BIGSERIAL / int2→SMALLSERIAL）。
    const isSerial = /^nextval\(/i.test(String(c.columnDefault || '').trim());
    if (isSerial) {
      const base = /^int8$/i.test(u) ? 'BIGSERIAL' : /^int2$/i.test(u) ? 'SMALLSERIAL' : 'SERIAL';
      let sdef = base;
      if (c.isNullable === 'NO') sdef += ' NOT NULL';
      return sdef;
    }
    // 用 format_type 的完整类型最稳（varchar(n)/numeric(10,2)/timestamp without time zone 全都对）
    let def = c.fullType || c.dataType || 'TEXT';
    if (c.isNullable === 'NO') def += ' NOT NULL';
    if (c.columnDefault) def += ` DEFAULT ${c.columnDefault}`;
    return def;
  };

  // 读取某库的完整结构 + 数据
  async function dumpDatabase(dbName, opts) {
    const o = opts || {};
    const p = getFeaturePool(dbName);
    const tblR = await p.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
    );
    const tables = {};
    for (const { table_name: tn } of tblR.rows) {
      if (o.skip && o.skip.includes(tn)) continue;
      // 列信息：从 pg_catalog 取，才能拿到几何子类型与 SRID（information_schema 看不到）
      const colR = await p.query(
        `SELECT a.attname AS column_name,
                format_type(a.atttypid, a.atttypmod) AS full_type,
                t.typname AS udt_name,
                CASE WHEN t.typname='geometry' THEN (SELECT gc.type FROM geometry_columns gc WHERE gc.f_table_schema='public' AND gc.f_table_name=$1 AND gc.f_geometry_column=a.attname LIMIT 1) END AS geometry_type,
                CASE WHEN t.typname='geometry' THEN (SELECT gc.srid FROM geometry_columns gc WHERE gc.f_table_schema='public' AND gc.f_table_name=$1 AND gc.f_geometry_column=a.attname LIMIT 1) END AS srid,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS column_default
         FROM pg_attribute a
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [tn]
      ).catch(() => ({ rows: [] }));

      const cols = colR.rows.map(c => ({
        name: c.column_name,
        udt: (c.udt_name || '').toLowerCase(),
        fullType: c.full_type,
        dataType: c.full_type,
        geometryType: c.geometry_type,
        srid: c.srid === null || c.srid === undefined ? 4326 : Number(c.srid),
        isNullable: c.nullable ? 'YES' : 'NO',
        columnDefault: c.column_default
      }));
      const geomCols = cols.filter(c => c.udt === 'geometry').map(c => c.name);

      // 主键列（还原时补 PRIMARY KEY，保住数据完整性）
      const pkR = await p.query(
        `SELECT a.attname AS col FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attnum`,
        [tn]
      ).catch(() => ({ rows: [] }));
      const primaryKey = pkR.rows.map(r => r.col);

      // 数据：几何列转 GeoJSON 文本
      const selectParts = cols.map(c =>
        geomCols.includes(c.name) ? `ST_AsGeoJSON("${c.name}") AS "${c.name}__geojson"` : qIdent(c.name)
      );
      const dataR = await p.query(`SELECT ${selectParts.join(', ')} FROM ${qIdent(tn)}`);

      tables[tn] = { columns: cols, geomColumns: geomCols, primaryKey, rows: dataR.rows };
    }
    return {
      format: 'dmgeo-zsql',
      version: 1,
      exportedAt: new Date().toISOString(),
      database: dbName,
      tables
    };
  }

  // GET /api/pg/databases/:name/export → 整库导出（zsql JSON 归档）
  //   查询串：?skip=表1,表2  排除某些表
  if (pathParts[0] === 'databases' && pathParts[2] === 'export' && method === 'GET') {
    try {
      const target = pathParts[1];
      if (!target) throw new Error('未指定数据库');
      const skip = (url.searchParams.get('skip') || '').split(',').map(s => s.trim()).filter(Boolean);
      const archive = await dumpDatabase(target, { skip });
      const body = JSON.stringify(archive, null, 2);
      const fname = `${target}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now().toString(36)}.zsql`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fname)}"`,
        'Content-Length': Buffer.byteLength(body)
      });
      return res.end(body);
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // POST /api/pg/databases/:name/import → 整库导入
  //   body: { archive, onConflict: 'ask'|'overwrite'|'skip'|'backup', decisions: {表名: 'overwrite'|'skip'|'backup'}, dryRun?: bool }
  if (pathParts[0] === 'databases' && pathParts[2] === 'import' && method === 'POST') {
    try {
      const target = pathParts[1];
      if (!target) throw new Error('未指定数据库');
      const body = JSON.parse(await getBody());
      const archive = body.archive;
      if (!archive || archive.format !== 'dmgeo-zsql') throw new Error('不是有效的 zsql 归档文件');
      const tables = archive.tables || {};
      const decisions = body.decisions || {};
      const onConflict = body.onConflict || 'ask';

      // dryRun：只回报冲突情况，前端据此弹窗让用户逐表决定（此阶段不建库、不改任何东西）
      if (body.dryRun) {
        const dbR = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname=$1`, [target]);
        let existing = new Set();
        if (dbR.rows.length) {
          const tblR0 = await getFeaturePool(target).query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
          );
          existing = new Set(tblR0.rows.map(r => r.table_name));
        }
        return sendJson(res, 200, {
          ok: true, dryRun: true, database: target,
          databaseExists: dbR.rows.length > 0,
          tables: Object.keys(tables).map(n => ({
            name: n,
            rows: (tables[n].rows || []).length,
            columns: (tables[n].columns || []).length,
            conflict: existing.has(n)
          }))
        });
      }

      // 目标库不存在则先建（ensureFeatureStore 只补 postgis/表，不负责 CREATE DATABASE）
      const dbExistsR = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname=$1`, [target]);
      let autoCreated = false;
      if (!dbExistsR.rows.length) {
        await adminPool.query(`CREATE DATABASE ${qIdent(target)} OWNER dmuser`);
        autoCreated = true;
      }

      // 确保目标库结构齐备（含 PostGIS + features + 授权）
      const created = await ensureFeatureStore(target, true);

      // 前置检查：归档里若有几何列，目标库必须已装 postgis，否则建表会在
      // `type "geometry" does not exist` 上报错（信息很误导）。这里提前给出可操作提示。
      const needsPostgis = Object.keys(tables).some(tn =>
        (tables[tn].geomColumns || []).length > 0 ||
        (tables[tn].columns || []).some(c => (c.udt || '').toLowerCase() === 'geometry')
      );
      if (needsPostgis) {
        const extR = await getFeaturePool(target).query(
          `SELECT 1 FROM pg_extension WHERE extname='postgis'`
        ).catch(() => ({ rows: [] }));
        if (!extR.rows.length) {
          return sendJson(res, 400, {
            error: `目标库 ${target} 缺少 PostGIS 扩展，无法还原几何列。` +
              `请在服务器上以超级用户执行： sudo -u postgres psql -d "${target}" -c "CREATE EXTENSION postgis;"` +
              ` 然后重试导入。（服务以 dmuser 运行，无权限自行安装扩展）`
          });
        }
      }

      const p = getFeaturePool(target);
      const tblR = await p.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
      );
      const existing = new Set(tblR.rows.map(r => r.table_name));
      const names = Object.keys(tables);

      const results = [];
      // 单事务：全部成功才提交，失败整体回滚
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        for (const tn of names) {
          const t = tables[tn];
          const cols = t.columns || [];
          const geomCols = t.geomColumns || cols.filter(c => c.udt === 'geometry').map(c => c.name);
          const conflict = existing.has(tn);
          let action = decisions[tn] || (conflict
            ? (onConflict === 'skip' ? 'skip' : onConflict === 'overwrite' ? 'overwrite' : onConflict === 'backup' ? 'backup' : 'ask')
            : 'create');
          if (action === 'ask') { results.push({ name: tn, action: 'skipped', reason: '未决定' }); continue; }
          if (action === 'skip') { results.push({ name: tn, action: 'skipped', rows: 0 }); continue; }

          let workName = tn;
          if (conflict) {
            if (action === 'backup') {
              const bak = `${tn}_bak_${new Date().toISOString().slice(0, 17).replace(/[-:T]/g, '')}`;
              await client.query(`ALTER TABLE ${qIdent(tn)} RENAME TO ${qIdent(bak)}`);
              results.push({ name: tn, action: 'backup', backupName: bak });
            } else {
              await client.query(`DROP TABLE ${qIdent(tn)} CASCADE`);
            }
          }

          // 建表：列定义原样还原
          const colDefs = cols.map(c => `${qIdent(c.name)} ${buildColumnDef(c)}`).join(', ');
          await client.query(`CREATE TABLE ${qIdent(workName)} (${colDefs || 'id SERIAL PRIMARY KEY'})`);
          // 还原主键（pn 去重：SERIAL 列在 buildColumnDef 里没带 PRIMARY KEY，这里统一加）
          const pk = (t.primaryKey || []).filter(c => cols.some(x => x.name === c));
          if (pk.length) {
            await client.query(`ALTER TABLE ${qIdent(workName)} ADD PRIMARY KEY (${pk.map(qIdent).join(', ')})`);
          }
          // 几何列补空间索引（照抄原表习惯）
          for (const gc of geomCols) {
            await client.query(`CREATE INDEX IF NOT EXISTS ${qIdent('idx_' + workName + '_' + gc)} ON ${qIdent(workName)} USING GIST (${qIdent(gc)})`);
          }
          // 导数据：逐行参数化插入（几何走 ST_GeomFromGeoJSON，避免拼接注入与转义地狱）
          let n = 0;
          for (const row of (t.rows || [])) n += await insertArchivedRow(client, workName, cols, geomCols, row);
          // 序列归位：SERIAL 主键导入后要 setval，否则下一条插入撞主键
          const serialCols = cols.filter(c => (c.columnDefault || '').startsWith('nextval('));
          for (const sc of serialCols) {
            await client.query(
              `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${qIdent(sc.name)}) FROM ${qIdent(workName)}), 1))`,
              [`public.${workName}`, sc.name]
            );
          }
          // 授权 dmuser（保障各服务能读写）
          try {
            await client.query(`GRANT ALL ON ${qIdent(workName)} TO dmuser`);
            await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO dmuser`);
          } catch (_) {}
          results.push({ name: tn, action: conflict ? action : 'created', rows: n });
        }
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw new Error('导入失败，已整体回滚：' + e.message);
      } finally {
        client.release();
      }

      return sendJson(res, 200, { ok: true, database: target, autoCreated, restored: results, initWarning: created && created.ok === false ? created.notes : undefined });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  // 写入一行（几何列转 ST_GeomFromGeoJSON），列名按归档原样
  async function insertArchivedRow(client, table, cols, geomCols, row) {
    const keys = [], vals = [], params = [];
    for (const c of cols) {
      if (geomCols.includes(c.name)) {
        const gj = row[c.name + '__geojson'];
        if (gj === null || gj === undefined || gj === '') { keys.push(qIdent(c.name)); vals.push('NULL'); }
        else { keys.push(qIdent(c.name)); vals.push(`ST_SetSRID(ST_GeomFromGeoJSON($${params.push(gj)}), ${c.srid || 4326})`); }
      } else {
        const v = row[c.name];
        if (v === null || v === undefined) { keys.push(qIdent(c.name)); vals.push('NULL'); }
        else { keys.push(qIdent(c.name)); vals.push(`$${params.push(v)}`); }
      }
    }
    if (!keys.length) return 0;
    await client.query(`INSERT INTO ${qIdent(table)} (${keys.join(',')}) VALUES (${vals.join(',')})`, params);
    return 1;
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

  // GET /api/storage-config → 读取存储/连接配置（root + paths + database）
  if (reqPath === '/api/storage-config' && req.method === 'GET') {
    const cfg = loadStorageConfig();
    const paths = {};
    for (const [k, v] of Object.entries(cfg.paths)) {
      const resolved = resolveDir(v);
      paths[k] = { dir: v.dir, resolved, exists: fs.existsSync(resolved) };
    }
    sendJson(res, 200, { root: ROOT, paths, database: cfg.database });
    return;
  }

  // POST /api/storage-config → 保存存储/连接配置，写回 storage-config.json 后重启生效
  if (reqPath === '/api/storage-config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        if (!input.database && !input.paths) throw new Error('缺少 database 或 paths 配置');
        const cfgPath = path.join(ROOT, 'storage-config.json');
        let cur = {};
        try { cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
        if (input.database) cur.database = { ...(cur.database || {}), ...input.database };
        if (input.paths) {
          cur.paths = { ...(cur.paths || {}) };
          for (const [k, v] of Object.entries(input.paths)) {
            cur.paths[k] = { ...(cur.paths[k] || {}), ...v };
          }
        }
        fs.writeFileSync(cfgPath, JSON.stringify(cur, null, 2));
        sendJson(res, 200, { ok: true, message: '已保存，服务重启中' });
        setTimeout(() => process.exit(0), 600);
      } catch (e) {
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

  const dataRoot = resolveDir(config.paths.data);
  const MAP_DATA_FILE = path.join(dataRoot, 'map-data.geojson');

  // 确保 geodata 目录存在
  if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot, { recursive: true });

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
        const featPool = getFeaturePool(featDb);
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

  // ====== 计划任务（补充时间计划）CRUD，支持 ?db= ======
  // 收集请求体
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }
  function normPlanTime(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim().replace('T', ' ');
    // 接受 'YYYY-MM-DD HH:mm' / 'YYYY-MM-DD HH:mm:ss'；无效则原样丢弃（存 NULL）
    return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s) ? s : null;
  }
  // 整体替换某任务的途经点明细（先删后插，保持前端提交的顺序）
  async function replacePlanStops(pool, planId, stops) {
    await pool.query('DELETE FROM plan_stops WHERE plan_id=$1', [planId]);
    if (!Array.isArray(stops) || !stops.length) return;
    let seq = 0;
    for (const s of stops) {
      if (!s) continue;
      const name = String(s.stop_name != null ? s.stop_name : (s.name || ''));
      const lng = (s.lng != null && !isNaN(parseFloat(s.lng))) ? parseFloat(s.lng) : null;
      const lat = (s.lat != null && !isNaN(parseFloat(s.lat))) ? parseFloat(s.lat) : null;
      await pool.query(
        `INSERT INTO plan_stops (plan_id, seq, stop_name, lng, lat, stop_at, stop_task, stop_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [planId, seq++, name, lng, lat, normPlanTime(s.stop_at),
         String(s.stop_task || ''), String(s.stop_note || '')]
      );
    }
  }

  // 把一条顶层计划的途经点物化成 N 条节点子任务（幂等：已有子任务则跳过，除非 force）
  // 返回新建的子任务行数组；无途经点或已存在（非 force）返回 []
  async function materializeChildren(pool, parent, opts) {
    const force = opts && opts.force;
    const chk = await pool.query('SELECT id FROM plans WHERE parent_id=$1 LIMIT 1', [parent.id]);
    if (chk.rows.length && !force) return [];
    // 先读途经点（无论 force 与否），绝不能先删再读
    let stops = [];
    if (force && opts && Array.isArray(opts.stops)) {
      stops = opts.stops;
    } else {
      const sr = await pool.query(
        `SELECT seq, stop_name, lng, lat, stop_at, stop_task, stop_note
         FROM plan_stops WHERE plan_id=$1 ORDER BY seq, id`, [parent.id]
      );
      stops = sr.rows;
    }
    // force：清空旧子任务，并按（可能更新过的）stops 重建 plan_stops
    if (force) {
      await pool.query('DELETE FROM plans WHERE parent_id=$1', [parent.id]);
      if (opts && Array.isArray(opts.stops)) {
        await pool.query('DELETE FROM plan_stops WHERE plan_id=$1', [parent.id]);
        let sq = 0;
        for (const s of stops) {
          if (!s) continue;
          await pool.query(
            `INSERT INTO plan_stops (plan_id, seq, stop_name, lng, lat, stop_at, stop_task, stop_note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [parent.id, sq++, String(s.stop_name || ''), s.lng != null ? parseFloat(s.lng) : null,
             s.lat != null ? parseFloat(s.lat) : null, normPlanTime(s.stop_at),
             String(s.stop_task || ''), String(s.stop_note || '')]
          );
        }
      }
    }
    const children = [];
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const nm = String(s.stop_name || ('点' + (i + 1)));
      const cr = await pool.query(
        `INSERT INTO plans (title, detail, plan_at, done, priority,
                            feature_id, feature_name, place_note, time_note, task_note,
                            parent_id, stop_seq)
         VALUES ($1, '', $2, FALSE, 'normal', $3, $4, $5, '', $6, $7, $8)
         RETURNING id, title, detail, plan_at, done, priority,
                   feature_id, feature_name, place_note, time_note, task_note,
                   parent_id, stop_seq, created_at, updated_at`,
        [nm, normPlanTime(s.stop_at), parent.feature_id, nm,
         String(s.stop_note || ''), String(s.stop_task || ''), parent.id, i]
      );
      children.push(cr.rows[0]);
    }
    return children;
  }

  // 把一条「路径类」计划的所有途经点刷成节点子任务（幂等 + 自愈）。
  // 与 materializeChildren 的区别：不看「有没有子任务」就跳过，而是比对节点数量；
  // 数量一致才算已拆解，否则整批重建 —— 这样线要素能随路径顶点一起被统计。
  // 仅供内部自动同步使用（顶层计划详情处不再暴露手动按钮）。
  async function syncPathChildren(pool, parent, stops) {
    if (!parent || parent.parent_id) return [];
    if (!Array.isArray(stops) || !stops.length) return [];
    const chk = await pool.query('SELECT COUNT(*)::int AS n FROM plans WHERE parent_id=$1', [parent.id]);
    if (chk.rows[0] && chk.rows[0].n === stops.length) return [];
    await pool.query('DELETE FROM plans WHERE parent_id=$1', [parent.id]);
    const children = [];
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i] || {};
      const nm = String(s.stop_name || ('点' + (i + 1)));
      const cr = await pool.query(
        `INSERT INTO plans (title, detail, plan_at, done, priority,
                            feature_id, feature_name, place_note, time_note, task_note,
                            parent_id, stop_seq)
         VALUES ($1, '', $2, FALSE, 'normal', $3, $4, $5, '', $6, $7, $8)
         RETURNING id, title, detail, plan_at, done, priority,
                   feature_id, feature_name, place_note, time_note, task_note,
                   parent_id, stop_seq, created_at, updated_at`,
        [nm, normPlanTime(s.stop_at), parent.feature_id, nm,
         String(s.stop_note || ''), String(s.stop_task || ''), parent.id, i]
      );
      children.push(cr.rows[0]);
    }
    return children;
  }

  // GET /api/plans?db= → 列出计划任务（顶层计划 + 各计划下的节点子任务）
  // 全链计划：路径主计划(parent_id IS NULL)+ 沿途每个节点子任务(parent_id 指向主计划)
  if (reqPath === '/api/plans' && req.method === 'GET') {
    (async () => {
      try {
        const planDb = url.searchParams.get('db') || 'trip';
        const p = getFeaturePool(planDb);
        await ensureFeatureStore(planDb);
        const r = await p.query(
          `SELECT id, title, detail, plan_at, done, priority,
                  feature_id, feature_name, place_note, time_note, task_note,
                  parent_id, stop_seq, created_at, updated_at
           FROM plans
           ORDER BY (plan_at IS NULL), plan_at ASC, id ASC`
        );
        const rows = r.rows;
        // 附带逐点明细（plan_stops）
        const ids = rows.map(x => x.id);
        let stopsByPlan = {};
        if (ids.length) {
          const sr = await p.query(
            `SELECT id, plan_id, seq, stop_name, lng, lat, stop_at, stop_task, stop_note
             FROM plan_stops WHERE plan_id = ANY($1::int[])
             ORDER BY plan_id, seq, id`,
            [ids]
          );
          sr.rows.forEach(s => { (stopsByPlan[s.plan_id] = stopsByPlan[s.plan_id] || []).push(s); });
        }
        const byId = {};
        rows.forEach(x => { byId[x.id] = Object.assign({}, x, { stops: stopsByPlan[x.id] || [], children: [] }); });
        const top = [];
        rows.forEach(x => {
          const node = byId[x.id];
          if (x.parent_id && byId[x.parent_id]) byId[x.parent_id].children.push(node);
          else top.push(node);
        });
        // 子任务按 stop_seq 排序
        top.forEach(t => t.children.sort((a, b) => (a.stop_seq == null ? 1e9 : a.stop_seq) - (b.stop_seq == null ? 1e9 : b.stop_seq)));
        const plans = top.map(x => Object.assign({}, x, { stops: x.stops }));
        sendJson(res, 200, { ok: true, plans });
      } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
    })();
    return;
  }

  // POST /api/plans?db= → 新建计划任务
  // body.parent_id 有值 = 建节点子任务；顶层计划带 stops 时自动为每个途经点生一条子任务
  if (reqPath === '/api/plans' && req.method === 'POST') {
    (async () => {
      try {
        const planDb = url.searchParams.get('db') || 'trip';
        const input = await readBody(req);
        const title = String(input.title || '').trim();
        if (!title) return sendJson(res, 400, { ok: false, error: '缺少标题 title' });
        const p = getFeaturePool(planDb);
        await ensureFeatureStore(planDb);
        const parentId = (input.parent_id != null && input.parent_id !== '') ? parseInt(input.parent_id, 10) : null;
        const stopSeq = (input.stop_seq != null && input.stop_seq !== '') ? parseInt(input.stop_seq, 10) : null;
        const r = await p.query(
          `INSERT INTO plans (title, detail, plan_at, done, priority,
                              feature_id, feature_name, place_note, time_note, task_note,
                              parent_id, stop_seq)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id, title, detail, plan_at, done, priority,
                     feature_id, feature_name, place_note, time_note, task_note,
                     parent_id, stop_seq, created_at, updated_at`,
          [title, String(input.detail || ''), normPlanTime(input.plan_at),
           !!input.done, String(input.priority || 'normal'),
           input.feature_id != null ? String(input.feature_id) : null,
           input.feature_name != null ? String(input.feature_name) : null,
           String(input.place_note || ''), String(input.time_note || ''), String(input.task_note || ''),
           (Number.isNaN(parentId) ? null : parentId), (Number.isNaN(stopSeq) ? null : stopSeq)]
        );
        const plan = r.rows[0];
        if (input.stops !== undefined) await replacePlanStops(p, plan.id, input.stops);
        // 全链计划：顶层计划（非子任务）带途经点时，自动为每个节点生成一条子任务
        // （幂等：已拆解过的路径不会重复生成；节点数变化时由 PUT 侧的 syncPathChildren 自愈）
        const children = (!plan.parent_id && Array.isArray(input.stops) && input.stops.length)
          ? await materializeChildren(p, plan) : [];
        sendJson(res, 200, { ok: true, plan, children });
      } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
    })();
    return;
  }

  // POST /api/plans/:id/materialize?db= → 把已有计划的途经点补物化成节点子任务
  // body.force=true → 先清空旧子任务再重建（用于 stops 变更后重新拆解）
  if (reqPath.startsWith('/api/plans/') && reqPath.endsWith('/materialize') && req.method === 'POST') {
    (async () => {
      try {
        const id = parseInt(reqPath.split('/')[3].replace(/\D/g, ''), 10);
        if (isNaN(id)) return sendJson(res, 400, { ok: false, error: '无效ID' });
        const planDb = url.searchParams.get('db') || 'trip';
        const input = await readBody(req).catch(() => ({}));
        const p = getFeaturePool(planDb);
        await ensureFeatureStore(planDb);
        const pr = await p.query('SELECT id, feature_id FROM plans WHERE id=$1', [id]);
        if (!pr.rows.length) return sendJson(res, 404, { ok: false, error: '任务不存在' });
        const parent = pr.rows[0];
        const children = await materializeChildren(p, parent, { force: !!input.force });
        sendJson(res, 200, { ok: true, created: children.length, children });
      } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
    })();
    return;
  }

  // PUT /api/plans/:id?db= → 更新计划任务
  if (reqPath.startsWith('/api/plans/') && req.method === 'PUT') {
    (async () => {
      try {
        const id = parseInt(reqPath.split('/').pop().replace(/\D/g, ''), 10);
        if (isNaN(id)) return sendJson(res, 400, { ok: false, error: '无效ID' });
        const planDb = url.searchParams.get('db') || 'trip';
        const input = await readBody(req);
        const p = getFeaturePool(planDb);
        const fields = [];
        const vals = [];
        let n = 1;
        if (input.title != null) { fields.push(`title=$${n++}`); vals.push(String(input.title)); }
        if (input.detail != null) { fields.push(`detail=$${n++}`); vals.push(String(input.detail)); }
        if (input.plan_at !== undefined) { fields.push(`plan_at=$${n++}`); vals.push(normPlanTime(input.plan_at)); }
        if (input.done !== undefined) { fields.push(`done=$${n++}`); vals.push(!!input.done); }
        if (input.priority != null) { fields.push(`priority=$${n++}`); vals.push(String(input.priority)); }
        if (input.feature_id !== undefined) { fields.push(`feature_id=$${n++}`); vals.push(input.feature_id != null ? String(input.feature_id) : null); }
        if (input.feature_name !== undefined) { fields.push(`feature_name=$${n++}`); vals.push(input.feature_name != null ? String(input.feature_name) : null); }
        if (input.place_note != null) { fields.push(`place_note=$${n++}`); vals.push(String(input.place_note)); }
        if (input.time_note != null) { fields.push(`time_note=$${n++}`); vals.push(String(input.time_note)); }
        if (input.task_note != null) { fields.push(`task_note=$${n++}`); vals.push(String(input.task_note)); }
        if (input.parent_id !== undefined) { const pv = (input.parent_id == null || input.parent_id === '') ? null : parseInt(input.parent_id, 10); fields.push(`parent_id=$${n++}`); vals.push(Number.isNaN(pv) ? null : pv); }
        if (input.stop_seq !== undefined) { const sv = (input.stop_seq == null || input.stop_seq === '') ? null : parseInt(input.stop_seq, 10); fields.push(`stop_seq=$${n++}`); vals.push(Number.isNaN(sv) ? null : sv); }
        const hasStops = input.stops !== undefined;
        if (!fields.length && !hasStops) return sendJson(res, 400, { ok: false, error: '无可更新字段' });
        let updated = null;
        if (fields.length) {
          fields.push('updated_at=NOW()');
          vals.push(id);
          const r = await p.query(
            `UPDATE plans SET ${fields.join(', ')} WHERE id=$${n}
             RETURNING id, title, detail, plan_at, done, priority,
                       feature_id, feature_name, place_note, time_note, task_note,
                       parent_id, stop_seq, created_at, updated_at`,
            vals
          );
          if (!r.rows.length) return sendJson(res, 404, { ok: false, error: '任务不存在' });
          updated = r.rows[0];
        } else {
          // 仅更新途经点：确认任务存在
          const chk = await p.query('SELECT id FROM plans WHERE id=$1', [id]);
          if (!chk.rows.length) return sendJson(res, 404, { ok: false, error: '任务不存在' });
        }
        if (hasStops) {
          await replacePlanStops(p, id, input.stops);
          // 路径类计划：途经点变了就把节点子任务同步刷成一致
          // （媒体等单节点计划同样适用：1 个节点 = 1 条子任务，于是「照片连线」也能被统计）
          const fchk = await p.query('SELECT id, parent_id, feature_id FROM plans WHERE id=$1', [id]);
          if (fchk.rows.length && !fchk.rows[0].parent_id) {
            await syncPathChildren(p, fchk.rows[0], input.stops);
          }
        }
        sendJson(res, 200, { ok: true, plan: updated || { id } });
      } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
    })();
    return;
  }

  // DELETE /api/plans/:id?db= → 删除计划任务
  if (reqPath.startsWith('/api/plans/') && req.method === 'DELETE') {
    (async () => {
      try {
        const id = parseInt(reqPath.split('/').pop().replace(/\D/g, ''), 10);
        if (isNaN(id)) return sendJson(res, 400, { ok: false, error: '无效ID' });
        const planDb = url.searchParams.get('db') || 'trip';
        const r = await getFeaturePool(planDb).query('DELETE FROM plans WHERE id=$1 RETURNING id', [id]);
        sendJson(res, 200, { ok: true, deleted: r.rowCount });
      } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
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
        const p = getFeaturePool(dbName);
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
    // 在 data 目录中搜索照片（含各库要素媒体）
    const cfg = config.paths.data;
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
        const isVideo = input.isVideo === true ||
          /\.(mp4|webm|mkv|mov|avi|flv|wmv)$/i.test(input.photoName || '');
        const props = {
          name: input.name || input.photoName,
          photo: input.photoName,
          desc: input.desc || '',
          type: isVideo ? 'video' : 'photo',
          mediaType: isVideo ? 'video' : 'photo',
          updatedAt: new Date().toISOString()
        };
        if (isVideo) props.video = input.photoName;
        else delete props.video;
        // 支持 ?db= 指定库（与其它要素接口一致；缺省 trip）
        const photoDb = url.searchParams.get('db') || 'trip';
        const photoPool = getFeaturePool(photoDb);
        // 查找已有照片要素
        const existing = await photoPool.query(
          `SELECT id FROM features WHERE properties->>'photo' = $1 AND type = 'photo' LIMIT 1`,
          [input.photoName]
        );
        if (existing.rows.length > 0) {
          props.createdAt = (await photoPool.query(`SELECT properties->>'createdAt' as c FROM features WHERE id=$1`, [existing.rows[0].id])).rows[0]?.c || props.updatedAt;
          await photoPool.query(
            `UPDATE features SET geom=ST_SetSRID(ST_MakePoint($1,$2),4326), properties=$3, name=$4 WHERE id=$5`,
            [input.lng, input.lat, JSON.stringify(props), input.name || input.photoName, existing.rows[0].id]
          );
        } else {
          props.createdAt = props.updatedAt;
          await photoPool.query(
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
        const photoDb = url.searchParams.get('db') || 'trip';
        const result = await getFeaturePool(photoDb).query(
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
      if (fs.existsSync(dataRoot)) {
        const scanDir = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) { scanDir(path.join(dir, e.name)); continue; }
            if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(e.name)) stats.photos++;
            else if (/\.(mp4|webm|mkv|mov|avi)$/i.test(e.name)) stats.videos++;
          }
        };
        scanDir(dataRoot);
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
      const featPool = getFeaturePool(featDb);
      // “放进来”：把选中库的要素同步进 Basemap.stats_features（统计镜像表），
      // 统计统一从镜像表读（精密后端统计源）。串行锁+容错已封装在辅助函数内。
      await syncFeaturesToBasemap(featPool, featDb);
      // 统计要素统一读镜像表（与 Basemap.features 分离，避免选 Basemap 时自引用串库），边界几何仍从 Basemap 读
      const feats = await basemapPool.query(`SELECT id, name, type, ST_X(ST_Centroid(geom)) AS lng, ST_Y(ST_Centroid(geom)) AS lat FROM ${STATS_MIRROR}`);

      const pMap = {};   // 中国省/市/区层级
      const cMap = {};   // 海外国家层级
      // —— 性能修复：原实现对每个要素 × 每张边界表逐行发 ST_Contains 往返(≈要素数×3500 次 SQL)，
      // 32 个要素就 55s。改为用空间 JOIN 一次性算出每个要素的省/市/区县/国家归属(共 4 次 SQL)，
      // 边界表 GIST 索引见 ensureStatsMirror。判定点与原逻辑一致：均取要素质心 ST_Centroid(geom)。
      const joinSql = (table, alias) => `SELECT DISTINCT ON (s.id) s.id, ${alias}.name AS bname
        FROM ${STATS_MIRROR} s
        JOIN ${table} ${alias} ON ST_Contains(${alias}.geom, ST_Centroid(s.geom))`;
      const [provR, cityR, distR, countryR] = await Promise.all([
        basemapPool.query(joinSql('provinces', 'p')),
        basemapPool.query(joinSql('cities', 'c')),
        basemapPool.query(joinSql('districts', 'd')),
        basemapPool.query(`SELECT DISTINCT ON (s.id) s.id,
          CASE WHEN c.name = 'Taiwan' THEN 'China' ELSE c.name END AS bname
          FROM ${STATS_MIRROR} s
          JOIN countries c ON ST_Contains(c.geom, ST_Centroid(s.geom))`)
      ]);
      const provMap = new Map(provR.rows.map(r => [r.id, r.bname]));
      const cityMap = new Map(cityR.rows.map(r => [r.id, r.bname]));
      const distMap = new Map(distR.rows.map(r => [r.id, r.bname]));
      const countryMap = new Map(countryR.rows.map(r => [r.id, r.bname]));

      for (const f of feats.rows) {
        const pn = provMap.get(f.id);   // 境内：落在某省多边形内
        if (pn) {
          const cn = cityMap.get(f.id) || '海外/未知';
          const dn = distMap.get(f.id) || '海外/未知';
          if (!pMap[pn]) pMap[pn] = {};
          if (!pMap[pn][cn]) pMap[pn][cn] = {};
          if (!pMap[pn][cn][dn]) pMap[pn][cn][dn] = { points:0, lines:0, polygons:0, timePaths:0, total:0, coords:[] };
          const rc = pMap[pn][cn][dn];
          if (f.type === 'point') rc.points++; else if (f.type === 'line') rc.lines++; else if (f.type === 'polygon') rc.polygons++;
          rc.total++;
          if (f.lng) rc.coords.push({lng: Math.round(f.lng*10000)/10000, lat: Math.round(f.lat*10000)/10000, name: f.name});
        } else {
          const countryName = countryMap.get(f.id);
          if (countryName) {
            if (!cMap[countryName]) cMap[countryName] = { points:0, lines:0, polygons:0, total:0, coords:[] };
            const rc = cMap[countryName];
            if (f.type === 'point') rc.points++; else if (f.type === 'line') rc.lines++; else if (f.type === 'polygon') rc.polygons++;
            rc.total++;
            if (f.lng) rc.coords.push({lng: Math.round(f.lng*10000)/10000, lat: Math.round(f.lat*10000)/10000, name: f.name});
          }
        }
      }

      const provinces = [];
      for (const pn of Object.keys(pMap).sort()) {
        const cityList = [];
        for (const cn of Object.keys(pMap[pn]).sort()) {
          const distList = [];
          const buckets = Object.values(pMap[pn][cn]);
          // 城市总数按全市点计算(含落在"未知区"的点)；否则无区级多边形的市
          // (如省直辖县级市济源) 会被整市隐藏 —— 见济源建点不显示 bug
          const cityTotal = buckets.reduce((s,d)=>s+(d.total||0),0);
          const cityPoints = buckets.reduce((s,d)=>s+(d.points||0),0);
          const cityLines = buckets.reduce((s,d)=>s+(d.lines||0),0);
          const cityPolys = buckets.reduce((s,d)=>s+(d.polygons||0),0);
          const cityCoords = buckets.flatMap(d=>d.coords||[]);
          for (const dn of Object.keys(pMap[pn][cn]).sort()) {
            const d = pMap[pn][cn][dn];
            if (dn === '海外/未知') continue;   // 不把"未知区"当成区列出
            if (d.total === 0) continue;
            distList.push({name:dn, points:d.points, lines:d.lines, polygons:d.polygons, timePaths:d.timePaths, total:d.total, coords:d.coords});
          }
          if (cn !== '海外/未知' && cityTotal > 0)
            cityList.push({name:cn, points:cityPoints, lines:cityLines, polygons:cityPolys, timePaths:0, total:cityTotal, coords:cityCoords, districts:distList});
        }
        const ct2 = cityList.reduce((s,x)=>s+x.total,0);
        if (pn !== '海外/未知' && ct2 > 0)
          provinces.push({name:pn, cities:cityList, total:ct2, points:cityList.reduce((s,x)=>s+x.points,0), lines:cityList.reduce((s,x)=>s+x.lines,0), polygons:cityList.reduce((s,x)=>s+x.polygons,0)});
      }
      provinces.sort((a,b)=>b.total-a.total);
      const countries = [];
      let chinaTotal = 0;
      for (const p of provinces) chinaTotal += (p.total||0);
      const taiwanAdd = cMap['China'] ? cMap['China'].total : 0;
      if (chinaTotal + taiwanAdd > 0) {
        // 分类计数要与 total 对得上：汇总各省 + 直接落在 China 面内但没落进任何省的要素。
        // 旧版硬编码 points/lines/polygons 全 0，世界层级点开中国分类明细全是 0，
        // 而 total 却有值——看着像“统计没算进去”。
        const cnExtra = cMap['China'] || { points:0, lines:0, polygons:0 };
        countries.push({
          name:'China',
          total: chinaTotal + taiwanAdd,
          points:   provinces.reduce((s,p)=>s+(p.points||0),0)   + (cnExtra.points||0),
          lines:    provinces.reduce((s,p)=>s+(p.lines||0),0)    + (cnExtra.lines||0),
          polygons: provinces.reduce((s,p)=>s+(p.polygons||0),0) + (cnExtra.polygons||0),
          cities:[],
          coords: (cMap['China']?cMap['China'].coords:[])
        });
      }
      for (const cn of Object.keys(cMap).sort()) {
        if (cn === 'China') continue; // 已与省级合计合并
        const c = cMap[cn];
        if (c.total > 0) countries.push({ name: cn, total: c.total, points: c.points, lines: c.lines, polygons: c.polygons, cities: [], coords: c.coords });
      }
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
        const p = getFeaturePool(dbName);
        const geojson = JSON.parse(body);
        if (!geojson.features) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '缺少 features 数组' }));
        }
        await ensureFeatureStore(dbName);
        // 整表覆盖是破坏性操作，必须显式声明 ?mode=replace。
        // 历史 bug：前端自动保存时先发一个空 features 数组“清库”再全量写，
        // 一旦此时内存快照不完整（加载失败/只画了一个面/照片视频不参与回写），
        // 库里的旧数据就被永久抹掉 —— 这是“新写入替掉旧数据”的根因。
        const replaceMode = url.searchParams.get('mode') === 'replace';
        let added = 0, removed = 0;
        if (replaceMode) {
          const r = await p.query('DELETE FROM features');
          removed += r.rowCount || 0;
        } else if (geojson.features.length === 0 && !Array.isArray(geojson.deleted)) {
          // 非 replace 模式下的空提交 = 无事发生（绝不再清库）
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: true, added: 0, removed: 0, skipped: 'empty payload ignored (use ?mode=replace to wipe)' }));
        }
        // 显式删除同步：前端把删掉的要素 clientId 放进 deleted 数组，只删这些
        if (Array.isArray(geojson.deleted) && geojson.deleted.length) {
          const r = await p.query("DELETE FROM features WHERE properties->>'clientId' = ANY($1::text[])", [geojson.deleted.map(String)]);
          removed += r.rowCount || 0;
        }
        // 按「库主键偏好」做 UPSERT，避免自动保存把整份数据反复复制入库。
        // 匹配优先级：dbId（库主键，形如 f_2186）> clientId（前端会话 id）> name+type（旧数据兜底）。
        // 历史 bug：前端每次 buildGeoJSON 都会为「从库里读回来的要素」生成一个新的 clientId，
        // 而库里存的是旧 clientId → 两边对不上 → 老逻辑 DELETE 删不到、于是每次保存都 INSERT 一份，
        // 反复刷新+自动保存就指数级堆积重复要素。
        for (const f of geojson.features) {
          if (!f || !f.geometry) continue;
          const props = f.properties || {};
          // 库主键：兼容 'f_2186' / '2186' / 数字三种写法
          let dbId = props.dbId;
          if (dbId != null) {
            const m = String(dbId).match(/(\d+)\s*$/);
            dbId = m ? parseInt(m[1], 10) : null;
          } else {
            dbId = null;
          }
          const cid = props.clientId;
          const type = props.type || (f.geometry.type === 'Point' ? 'point' : f.geometry.type === 'LineString' ? 'line' : 'polygon');

          let existing = null;
          if (dbId) {
            const r0 = await p.query('SELECT id FROM features WHERE id = $1', [dbId]);
            if (r0.rowCount) existing = r0.rows[0].id;
          }
          if (!existing && cid) {
            const r1 = await p.query("SELECT id FROM features WHERE properties->>'clientId' = $1", [cid]);
            if (r1.rowCount) existing = r1.rows[0].id;
          }
          if (!existing) {
            // 兜底：按 name + type 找（同一 name 可能有多条，取最早一条合并）
            const r2 = await p.query(
              "SELECT id FROM features WHERE properties->>'name' = $1 AND type = $2 ORDER BY id LIMIT 1",
              [props.name || '', type]
            );
            if (r2.rowCount) existing = r2.rows[0].id;
          }

          if (existing) {
            // 更新：保留原 id，改几何与属性（把库主键回写进 properties，供下次匹配）
            props.dbId = 'f_' + existing;
            await p.query(
              'UPDATE features SET name=$1, type=$2, geom=ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326))), properties=$4 WHERE id=$5',
              [props.name || '', type, JSON.stringify(f.geometry), JSON.stringify(props), existing]
            );
          } else {
            const ins = await p.query(
              'INSERT INTO features (name, type, geom, properties) VALUES ($1, $2, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326))), $4) RETURNING id',
              [props.name || '', type, JSON.stringify(f.geometry), JSON.stringify(props)]
            );
            if (ins.rowCount) {
              const newId = ins.rows[0].id;
              // 回写 dbId，前端下次保存即可精确命中同一条
              await p.query("UPDATE features SET properties = properties || jsonb_build_object('dbId', $1) WHERE id = $2", ['f_' + newId, newId]);
            }
          }
          added++;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, added, removed, total: added }));
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
      if (fs.existsSync(dataRoot)) {
        const entries = fs.readdirSync(dataRoot, { withFileTypes: true });
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
    const featDb = url.searchParams.get('db') || 'trip';
    const gdDir = path.join(resolveDir(config.paths.database), featDb);
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

        const relPath = 'media/geodata/' + featDb + '/' + featureId + '/' + finalName;
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
    const featDb = url.searchParams.get('db') || 'trip';
    const gdDir = path.join(resolveDir(config.paths.database), featDb);
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
            file: 'media/geodata/' + featDb + '/' + featureId + '/' + f,
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
    const featDb = url.searchParams.get('db') || 'trip';
    const gdDir = path.join(resolveDir(config.paths.database), featDb);
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
    const realDir = resolveDir(config.paths.database);
    const relative = reqPath.slice('/media/geodata/'.length);
    const realPath = path.join(realDir, relative);
    if (path.normalize(realPath).startsWith(path.normalize(realDir) + path.sep) || path.normalize(realPath) === path.normalize(realDir)) {
      return serveFile(realPath, res);
    }
    res.writeHead(403); return res.end('Forbidden');
  }

  // 虚拟挂载：/boundaries/ → 边界数据实际目录（map-boundaries，见 storage-config.json）
  if (reqPath.startsWith('/boundaries/')) {
    const realDir = resolveDir(config.paths.boundaries);
    const relative = reqPath.slice('/boundaries/'.length);
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

// ── 启动初始化：确保运行时目录骨架存在（幂等） ──
// data/ 与 data/boundaries/、照片媒体库 data/database/<featureDb>/
// map-player 照片区扫描 data/database/<库名>/；全新安装若不预建，照片目录缺失会导致列表恒空。
(function ensureRuntimeDirs(){
  const dirs = [
    resolveDir(config.paths.data),
    resolveDir(config.paths.boundaries),
    resolveDir(config.paths.database),
    path.join(resolveDir(config.paths.database), (config.database && config.database.featureDb) || 'trip')
  ];
  for (const d of dirs) {
    try { if (d && !fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
    catch (e) { console.error('ensure dir failed:', d, e.message); }
  }
})();

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
