#!/usr/bin/env node
// import-datav.js — 导入全国省/市/区行政边界到 PostGIS 的 provinces/cities/districts 表。
//
// 离线优先：若本地 geodata/china/{provinces,cities,districts} 缓存齐全，直接读缓存构建，
// 完全不联网（满血离线版默认走此路径）；缓存缺失时才从阿里云 DataV.GeoAtlas 下载。
// 不修改 server.js；大屏用的 provinces/cities 接口原样可用。
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const ROOT = __dirname;
const CHINA_FULL = path.join(ROOT, 'geodata/china/china_full.json');
const MAP_CITIES_DIR = path.join(ROOT, 'map-boundaries/cities');
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const PROV_CODE_MAP = {}; // name -> adcode (供参考)

// 几何规范化：将 DataV 返回的 Polygon / MultiPolygon / GeometryCollection
// 统一转为 MultiPolygon。关键修复：北京/广东/天津等省级边界 DataV 返回的是
// GeometryCollection（Polygon + LineString），若不做 CollectionExtract 会
// 携带 LINESTRING，前端 getCentroid 只取第一个子多边形导致质心(0,0)、标签错位。
const GEOM = (n) =>
  `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($${n}),4326)),3))`;

function download(adcode) {
  return new Promise((resolve, reject) => {
    https.get(BASE + adcode + '_full.json', res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + adcode)); }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
async function downloadRetry(adcode, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const t = await download(adcode);
      JSON.parse(t); // 验证是合法 JSON（直辖市无效 adcode 会返回 XML）
      return t;
    } catch (e) {
      lastErr = e;
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx]); }
      catch (e) { results[idx] = { __error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function fc(features) {
  return { type: 'FeatureCollection', features };
}

// 兜底：本地缺少 china_full.json 时，自动从 DataV 下载全国总图（100000_full.json）并缓存，
// 保证本脚本在文件缺失的情况下仍能一键运行，不会因 fs.readFileSync 直接崩溃。
async function ensureChinaFull() {
  if (fs.existsSync(CHINA_FULL)) {
    console.log('[0] 使用本地缓存 china_full.json');
    return;
  }
  console.log('[0] 本地缺少 china_full.json，从 DataV 下载 100000_full.json ...');
  const txt = await downloadRetry('100000');
  fs.writeFileSync(CHINA_FULL, txt);
  console.log('[0] 已缓存到', CHINA_FULL);
}

// 离线重建：本地 geodata/china/{provinces,cities,districts} 缓存齐全时直接读缓存，零网络。
// 返回 {provinces, cities, districts, provinceCities, provinceDistricts}，缺失则返回 null。
// 直辖市处理：区的 parent.adcode 直接是省 adcode，该区同时作为"市"进入 cities 表，供大屏下钻。
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
  const cities = cityJson.map(c => ({
    properties: c.properties, geometry: c.geometry,
    _province: String(c.properties.parent.adcode)
  }));
  const districts = distJson.map(d => ({
    properties: d.properties, geometry: d.geometry,
    _city: String(d.properties.parent.adcode)
  }));
  // 直辖市：区的 parent.adcode 是省 adcode -> 该区同时作为"市"进入 cities（供大屏市级下钻）
  for (const d of districts) {
    if (provCodes.has(String(d.properties.parent.adcode))) {
      cities.push({
        properties: d.properties, geometry: d.geometry,
        _province: String(d.properties.parent.adcode), _municipalityDistrict: true
      });
    }
  }
  const provinceCities = {}, provinceDistricts = {};
  for (const c of cities) {
    const k = String(c._province);
    (provinceCities[k] = provinceCities[k] || []).push(c);
  }
  for (const d of districts) {
    const k = String(d.properties.parent.adcode);
    (provinceDistricts[k] = provinceDistricts[k] || []).push(d);
  }
  return { provinces, cities, districts, provinceCities, provinceDistricts };
}

(async () => {
  let provinces, cities, districts, provinceCities, provinceDistricts;

  const offline = offlineBuild();
  if (offline) {
    console.log('[离线] 检测到本地全量缓存 geodata/china/{provinces,cities,districts}，跳过网络下载');
    provinces = offline.provinces;
    cities = offline.cities;
    districts = offline.districts;
    provinceCities = offline.provinceCities;
    provinceDistricts = offline.provinceDistricts;
  } else {
    // ===== 联网路径（缓存缺失时回退）=====
    await ensureChinaFull();
    const china = JSON.parse(fs.readFileSync(CHINA_FULL, 'utf8'));
    provinces = china.features.filter(f => f.properties.level === 'province');
    console.log('[1] 省份数:', provinces.length);

    cities = []; districts = [];
    provinceCities = {}; provinceDistricts = {};

    // ---- 下载每个省的 _full，拿到市 / (直辖市的)区 ----
    console.log('[2] 下载 34 个省级 _full ...');
    const provResults = await mapLimit(provinces, 8, async (p) => {
      const code = p.properties.adcode;
      const txt = await downloadRetry(code);
      const d = JSON.parse(txt);
      return { code, name: p.properties.name, features: d.features };
    });

    for (const pr of provResults) {
      if (pr.__error) { console.warn('  省下载失败', pr.code, pr.__error); continue; }
      PROV_CODE_MAP[pr.name] = pr.code;
      const cityFeats = pr.features.filter(f => f.properties.level === 'city');
      const distFeats = pr.features.filter(f => f.properties.level === 'district');
      provinceCities[pr.code] = cityFeats;
      provinceDistricts[pr.code] = distFeats;
      cityFeats.forEach(c => cities.push({ properties: c.properties, geometry: c.geometry, _province: pr.code }));
      // 直辖市：省_full 直接是区 -> 同时进 cities(供大屏下钻) 和 districts
      distFeats.forEach(dt => {
        cities.push({ properties: dt.properties, geometry: dt.geometry, _province: pr.code, _municipalityDistrict: true });
        districts.push({ properties: dt.properties, geometry: dt.geometry, _city: pr.code });
      });
    }

    // ---- 下载每个市的 _full，拿到区 ----
    const realCitiesTmp = cities.filter(c => !c._municipalityDistrict);
    console.log('[3] 下载', realCitiesTmp.length, '个市级 _full (取区) ...');
    const cityResults = await mapLimit(realCitiesTmp, 8, async (c) => {
      const code = c.properties.adcode;
      const txt = await downloadRetry(code);
      const d = JSON.parse(txt);
      return { code, features: d.features };
    });
    let cityFail = 0;
    for (const cr of cityResults) {
      if (cr.__error) { cityFail++; continue; }
      const distFeats = cr.features.filter(f => f.properties.level === 'district');
      distFeats.forEach(dt => districts.push({ properties: dt.properties, geometry: dt.geometry, _city: cr.code }));
    }
    console.log('    区总数:', districts.length, ' 市级下载失败:', cityFail);
  }

  const realCities = cities.filter(c => !c._municipalityDistrict);
  console.log('[汇总] 省', provinces.length, ' 市(含直辖市区)', cities.length, ' 区', districts.length);

  // ---- 写本地备用文件 ----
  console.log('[4] 写本地备用边界文件 ...');
  fs.mkdirSync(MAP_CITIES_DIR, { recursive: true });
  // china-provinces.geojson（覆盖旧文件）
  fs.writeFileSync(path.join(ROOT, 'map-boundaries/china-provinces.geojson'),
    JSON.stringify(fc(provinces.map(p => ({ type: 'Feature', properties: p.properties, geometry: p.geometry }))), null, 0));
  // cities/<provinceCode>.geojson：每省的市（直辖市则是其区）
  for (const p of provinces) {
    const code = p.properties.adcode;
    const feats = (provinceCities[code] && provinceCities[code].length)
      ? provinceCities[code]
      : (provinceDistricts[code] || []);
    fs.writeFileSync(path.join(MAP_CITIES_DIR, code + '.geojson'),
      JSON.stringify(fc(feats.map(f => ({ type: 'Feature', properties: f.properties, geometry: f.geometry }))), null, 0));
  }
  // 备份：分省/市/区单独存一份
  fs.mkdirSync(path.join(ROOT, 'geodata/china/provinces'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'geodata/china/cities'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'geodata/china/districts'), { recursive: true });
  provinces.forEach(p => fs.writeFileSync(path.join(ROOT, 'geodata/china/provinces', p.properties.adcode + '.json'), JSON.stringify(p)));
  realCities.forEach(c => fs.writeFileSync(path.join(ROOT, 'geodata/china/cities', c.properties.adcode + '.json'), JSON.stringify(c)));
  districts.forEach(d => fs.writeFileSync(path.join(ROOT, 'geodata/china/districts', d.properties.adcode + '.json'), JSON.stringify(d)));

  // ---- 导入 PostGIS ----
  console.log('[5] 导入 PostGIS ...');
  // 导入目标库改为 Basemap（DMgeo 的 basemapPool 从此库读取 provinces/cities/districts）
  const pool = new Pool({ database: 'Basemap', user: 'dmuser', password: 'dmpageo123' });
  // 幂等建表（provinces / cities 此前依赖外部初始化，这里一并补齐，
  // 使本脚本可独立一键导入）
  await pool.query(`CREATE TABLE IF NOT EXISTS provinces (
    id SERIAL PRIMARY KEY, name TEXT, code TEXT, geom GEOMETRY(GEOMETRY,4326))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cities (
    id SERIAL PRIMARY KEY, name TEXT, province_code TEXT, geom GEOMETRY(GEOMETRY,4326))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS districts (
    id SERIAL PRIMARY KEY, name TEXT, city_code TEXT, geom GEOMETRY(GEOMETRY,4326))`);
  await pool.query('DELETE FROM provinces');
  await pool.query('DELETE FROM cities');
  await pool.query('DELETE FROM districts');

  for (const p of provinces) {
    try {
      await pool.query(
        `INSERT INTO provinces(name,code,geom) VALUES($1,$2,${GEOM(3)})`,
        [p.properties.name, String(p.properties.adcode), JSON.stringify(p.geometry)]);
    } catch (e) { console.warn('  province 插入失败', p.properties.name, e.message); }
  }
  for (const c of cities) {
    try {
      await pool.query(
        `INSERT INTO cities(name,province_code,geom) VALUES($1,$2,${GEOM(3)})`,
        [c.properties.name, String(c._province), JSON.stringify(c.geometry)]);
    } catch (e) { console.warn('  city 插入失败', c.properties.name, e.message); }
  }
  for (const d of districts) {
    try {
      await pool.query(
        `INSERT INTO districts(name,city_code,geom) VALUES($1,$2,${GEOM(3)})`,
        [d.properties.name, String(d.properties.parent.adcode), JSON.stringify(d.geometry)]);
    } catch (e) { console.warn('  district 插入失败', d.properties.name, e.message); }
  }

  const cnt = await pool.query('SELECT (SELECT count(*) FROM provinces) p,(SELECT count(*) FROM cities) c,(SELECT count(*) FROM districts) d');
  console.log('[完成] provinces/cities/districts =',
    cnt.rows[0].p, '/', cnt.rows[0].c, '/', cnt.rows[0].d);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
