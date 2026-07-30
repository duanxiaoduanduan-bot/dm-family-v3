#!/usr/bin/env node
// import-datav.js — 把本地缓存 geodata/china/{provinces,cities,districts} 的全国省/市/区
// 行政边界 upsert 进 PostGIS 的 Basemap.provinces/cities/districts 表。
//
// 设计（与 fetch-datav.js 解耦）：
//  - 本脚本【只读本地缓存、不联网】。拉取最新数据由 fetch-datav.js 负责。
//  - 离线优先：缓存齐全直接导入，零网络。缓存缺失则明确报错退出（提示先跑 fetch）。
//  - 增量 upsert：按 adcode（code 列唯一）ON CONFLICT DO UPDATE，重复运行安全、可刷新不丢结构。
//    首次运行会为旧结构（cities/districts 无 code 列）做一次性全量重建。
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = __dirname;

// 几何规范化：将 DataV 返回的 Polygon / MultiPolygon / GeometryCollection
// 统一转为 MultiPolygon。北京/广东/天津等省级边界 DataV 返回 GeometryCollection（Polygon + LineString），
// 若不做 CollectionExtract 会携带 LINESTRING，前端 getCentroid 只取第一个子多边形导致质心(0,0)、标签错位。
const GEOM = (n) =>
  `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($${n}),4326)),3))`;

function fc(features) {
  return { type: 'FeatureCollection', features };
}

// 离线构建：读本地 geodata/china/{provinces,cities,districts} 缓存，零网络。缺失返回 null。
// 直辖市处理：区的 parent.adcode 直接是省 adcode，该区同时作为"市"进入 cities（供大屏下钻）。
function offlineBuild() {
  const provDir = path.join(ROOT, 'geodata/china/provinces');
  const cityDir = path.join(ROOT, 'geodata/china/cities');
  const distDir = path.join(ROOT, 'geodata/china/districts');
  if (![provDir, cityDir, distDir].every(d => fs.existsSync(d))) return null;
  const read = dir => fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const provJson = read(provDir), cityJson = read(cityDir), distJson = read(distDir);
  if (!provJson.length || !cityJson.length) return null;

  const provCodes = new Set(provJson.map(p => String(p.properties.adcode)));
  const provinces = provJson.map(p => ({ properties: p.properties, geometry: p.geometry }));
  const parentOf = (props) => (props.parent && props.parent.adcode != null)
    ? String(props.parent.adcode)
    : String(props.adcode);
  const cities = cityJson.map(c => ({
    properties: c.properties, geometry: c.geometry, _province: parentOf(c.properties)
  }));
  const districts = distJson.map(d => ({
    properties: d.properties, geometry: d.geometry, _city: parentOf(d.properties)
  }));
  for (const d of districts) {
    if (provCodes.has(parentOf(d.properties))) {
      cities.push({ properties: d.properties, geometry: d.geometry, _province: parentOf(d.properties) });
    }
  }
  const provinceCities = {}, provinceDistricts = {};
  for (const c of cities) (provinceCities[c._province] = provinceCities[c._province] || []).push(c);
  for (const d of districts) (provinceDistricts[parentOf(d.properties)] = provinceDistricts[parentOf(d.properties)] || []).push(d);
  return { provinces, cities, districts, provinceCities, provinceDistricts };
}

(async () => {
  const offline = offlineBuild();
  if (!offline) {
    console.error('');
    console.error('[import] ✗ 本地缓存缺失（geodata/china/{provinces,cities,districts}）。');
    console.error('[import]   请先联网拉取: node fetch-datav.js  或  ./install.sh fetch-datav');
    console.error('[import]   离线环境可拷入已有缓存后用 ./install.sh geodata 导入。');
    console.error('');
    process.exit(3);
  }
  console.log('[import] 使用本地缓存 geodata/china/{provinces,cities,districts}（离线，不联网）');
  const { provinces, cities, districts } = offline;
  console.log('[汇总] 省', provinces.length, ' 市(含区)', cities.length, ' 区', districts.length);

  // ---- upsert 进 PostGIS ----
  console.log('[5] upsert 进 PostGIS Basemap ...');
  const pool = new Pool({ database: 'Basemap', user: 'dmuser', password: 'dmpageo123' });

  await pool.query(`CREATE TABLE IF NOT EXISTS provinces (
    id SERIAL PRIMARY KEY, name TEXT, code TEXT, geom GEOMETRY(GEOMETRY,4326))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cities (
    id SERIAL PRIMARY KEY, name TEXT, province_code TEXT, code TEXT, geom GEOMETRY(GEOMETRY,4326))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS districts (
    id SERIAL PRIMARY KEY, name TEXT, city_code TEXT, code TEXT, geom GEOMETRY(GEOMETRY,4326))`);

  // 兼容旧库：补 code 列（旧版 cities/districts 无 code 列）
  await pool.query('ALTER TABLE cities ADD COLUMN IF NOT EXISTS code TEXT');
  await pool.query('ALTER TABLE districts ADD COLUMN IF NOT EXISTS code TEXT');

  // 旧结构迁移：cities/districts 若有 code IS NULL 的旧行，清空首跑全量重建，避免重复
  const old = await pool.query(
    "SELECT (SELECT count(*) FROM cities WHERE code IS NULL) c, (SELECT count(*) FROM districts WHERE code IS NULL) d");
  if (old.rows[0].c > 0 || old.rows[0].d > 0) {
    console.log('[import] 检测到旧结构（缺 code 列），清空 cities/districts 后全量重建 ...');
    await pool.query('DELETE FROM cities');
    await pool.query('DELETE FROM districts');
  }

  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS provinces_code_uidx ON provinces(code)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS cities_code_uidx ON cities(code)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS districts_code_uidx ON districts(code)');

  for (const p of provinces) {
    try {
      await pool.query(
        `INSERT INTO provinces(name,code,geom) VALUES($1,$2,${GEOM(3)})
         ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, geom=EXCLUDED.geom`,
        [p.properties.name, String(p.properties.adcode), JSON.stringify(p.geometry)]);
    } catch (e) { console.warn('  province upsert 失败', p.properties.name, e.message); }
  }
  for (const c of cities) {
    try {
      await pool.query(
        `INSERT INTO cities(name,province_code,code,geom) VALUES($1,$2,$3,${GEOM(4)})
         ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, province_code=EXCLUDED.province_code, geom=EXCLUDED.geom`,
        [c.properties.name, String(c._province), String(c.properties.adcode), JSON.stringify(c.geometry)]);
    } catch (e) { console.warn('  city upsert 失败', c.properties.name, e.message); }
  }
  for (const d of districts) {
    try {
      await pool.query(
        `INSERT INTO districts(name,city_code,code,geom) VALUES($1,$2,$3,${GEOM(4)})
         ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, city_code=EXCLUDED.city_code, geom=EXCLUDED.geom`,
        [d.properties.name, String(d.properties.parent ? d.properties.parent.adcode : d.properties.adcode),
         String(d.properties.adcode), JSON.stringify(d.geometry)]);
    } catch (e) { console.warn('  district upsert 失败', d.properties.name, e.message); }
  }

  const cnt = await pool.query('SELECT (SELECT count(*) FROM provinces) p,(SELECT count(*) FROM cities) c,(SELECT count(*) FROM districts) d');
  console.log('[完成] provinces/cities/districts =', cnt.rows[0].p, '/', cnt.rows[0].c, '/', cnt.rows[0].d);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
