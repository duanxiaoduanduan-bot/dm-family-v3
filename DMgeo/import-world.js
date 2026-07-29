#!/usr/bin/env node
// import-world.js — 导入世界各国边界到 PostGIS 的 countries 表。
//
// 离线优先：本地 map-boundaries/world-countries.geojson 存在则直接读（满血离线版默认走此路径）；
// 缺失时再从 Natural Earth 官方矢量源（jsdelivr）下载并缓存。兼容大屏：统一属性名为 name。
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const ROOT = __dirname;
const SRC = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson';
const OUT = path.join(ROOT, 'map-boundaries/world-countries.geojson');

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function normalize(src) {
  // 若已是规范化结构（含 properties.name）则原样使用，否则从 Natural Earth 字段转换
  const sample = src.features[0] && src.features[0].properties;
  if (sample && sample.name) {
    return src.features.map(f => ({
      type: 'Feature',
      properties: f.properties,
      geometry: f.geometry
    }));
  }
  return src.features.map(f => {
    const p = f.properties || {};
    return {
      type: 'Feature',
      properties: {
        name: p.NAME || p.ADMIN || p.NAME_LONG,
        'ISO3166-1-Alpha-3': p.ISO_A3,
        'ISO3166-1-Alpha-2': p.ISO_A2,
        CONTINENT: p.CONTINENT
      },
      geometry: f.geometry
    };
  });
}

(async () => {
  let src;
  if (fs.existsSync(OUT)) {
    console.log('[离线] 使用本地缓存', OUT);
    src = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } else {
    console.log('[1] 下载 Natural Earth 世界国界 ...');
    const txt = await download(SRC);
    src = JSON.parse(txt);
    console.log('    要素数:', src.features.length);
  }

  const features = normalize(src);
  const fc = { type: 'FeatureCollection', features };
  fs.writeFileSync(OUT, JSON.stringify(fc));
  console.log('[2] 已写入本地', OUT, '(', features.length, '国 )');

  console.log('[3] 导入 PostGIS countries 表 ...');
  const pool = new Pool({ database: 'dmpageo', user: 'dmuser', password: 'dmpageo123' });
  await pool.query('DELETE FROM countries');
  let ok = 0, fail = 0;
  for (const f of features) {
    if (!f.geometry) continue;
    try {
      await pool.query(
        `INSERT INTO countries(name, geom) VALUES($1, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2),4326)),3)))`,
        [f.properties.name, JSON.stringify(f.geometry)]);
      ok++;
    } catch (e) { fail++; if (fail <= 5) console.warn('    插入失败', f.properties.name, e.message); }
  }
  const cnt = await pool.query('SELECT count(*) FROM countries');
  console.log('[完成] countries 入库:', cnt.rows[0].count, '(成功', ok, '失败', fail, ')');
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
