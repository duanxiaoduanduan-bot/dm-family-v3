#!/usr/bin/env node
// fetch-datav.js — 纯联网拉取阿里 DataV.GeoAtlas 行政区划，
// 写入本地缓存 geodata/china/{provinces,cities,districts} + china_full.json，
// 并重建前端底图 map-boundaries/。不写数据库（写库由 import-datav.js 负责）。
//
// 设计要点：
//  - 进程启动先探测 geo.datav.aliyun.com 可达性；不可达（被 Cloudflare 等代理拦截 / 网络不通）
//    明确报错并 exit(2)，绝不静默（避免回到"建库没写进去"那类哑错）。
//  - 切换网络（能访问阿里）后重跑即可刷新缓存；之后 ./install.sh fetch-datav 一并 upsert 入库。
//  - 并发 8、失败重试 5 次，避免一次性扇 3000+ 请求被限流。
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const CHINA_FULL = path.join(ROOT, 'geodata/china/china_full.json');
const PROV_DIR = path.join(ROOT, 'geodata/china/provinces');
const CITY_DIR = path.join(ROOT, 'geodata/china/cities');
const DIST_DIR = path.join(ROOT, 'geodata/china/districts');
const MAP_PROV = path.join(ROOT, 'map-boundaries/china-provinces.geojson');
const MAP_CITY_DIR = path.join(ROOT, 'map-boundaries/cities');

function httpsGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

async function downloadRetry(adcode, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const t = await httpsGet(BASE + adcode + '_full.json');
      JSON.parse(t); // 验证合法 JSON（直辖市无效 adcode 会返回 XML）
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

const fc = features => ({ type: 'FeatureCollection', features });

// 探测可达性：拿全国总图（100000_full.json）的首字节判断，不下载全量。
async function probe() {
  try { await httpsGet(BASE + '100000_full.json', 15000); return true; }
  catch (e) { return false; }
}

(async () => {
  console.log('[fetch] 探测 geo.datav.aliyun.com 可达性 ...');
  if (!(await probe())) {
    console.error('');
    console.error('[fetch] ✗ 阿里 DataV 不可达（很可能被 Cloudflare / 代理拦截，或本机无外网）。');
    console.error('[fetch]   请切换到能访问 geo.datav.aliyun.com 的网络后重试（例如临时关闭拦截阿里的代理）。');
    console.error('[fetch]   离线环境请改用已有缓存导入: ./install.sh geodata');
    console.error('');
    process.exit(2);
  }
  console.log('[fetch] ✓ 可达，开始联网拉取最新行政区划 ...');

  for (const d of [PROV_DIR, CITY_DIR, DIST_DIR, MAP_CITY_DIR]) fs.mkdirSync(d, { recursive: true });

  // 全国总图
  const chinaTxt = await downloadRetry('100000');
  fs.writeFileSync(CHINA_FULL, chinaTxt);
  const china = JSON.parse(chinaTxt);
  const provinces = china.features.filter(f => f.properties.level === 'province');
  console.log('[fetch] 省级:', provinces.length);

  // 每省 _full → 市 / 区
  const provResults = await mapLimit(provinces, 8, async p => {
    const code = p.properties.adcode;
    const d = JSON.parse(await downloadRetry(code));
    return { code, name: p.properties.name, features: d.features };
  });

  const cities = [], districts = [], provinceCities = {}, provinceDistricts = {};
  let provFail = 0;
  for (const p of provinces) {
    // 省自身缓存
    fs.writeFileSync(path.join(PROV_DIR, p.properties.adcode + '.json'),
      JSON.stringify({ properties: p.properties, geometry: p.geometry }));
  }
  for (const pr of provResults) {
    if (pr.__error) { console.warn('  省下载失败', pr.code, pr.__error); provFail++; continue; }
    const cityFeats = pr.features.filter(f => f.properties.level === 'city');
    const distFeats = pr.features.filter(f => f.properties.level === 'district');
    provinceCities[pr.code] = cityFeats;
    provinceDistricts[pr.code] = distFeats;
    cityFeats.forEach(c => {
      cities.push(c);
      fs.writeFileSync(path.join(CITY_DIR, c.properties.adcode + '.json'),
        JSON.stringify({ properties: c.properties, geometry: c.geometry }));
    });
    distFeats.forEach(dt => {
      // 直辖市的区：同时作为"市"进入 cities（大屏下钻），并进入 districts
      const asCity = Object.assign({}, dt, { _municipalityDistrict: true });
      cities.push(asCity);
      fs.writeFileSync(path.join(CITY_DIR, dt.properties.adcode + '.json'),
        JSON.stringify({ properties: dt.properties, geometry: dt.geometry }));
      districts.push(dt);
      fs.writeFileSync(path.join(DIST_DIR, dt.properties.adcode + '.json'),
        JSON.stringify({ properties: dt.properties, geometry: dt.geometry }));
    });
  }
  // 下载每个普通市的 _full，拿其下辖区（直辖市区已在上面处理）
  const realCitiesTmp = cities.filter(c => !c._municipalityDistrict);
  console.log('[fetch] 下载', realCitiesTmp.length, '个市级 _full 拿区 ...');
  const cityResults = await mapLimit(realCitiesTmp, 8, async c => {
    const code = c.properties.adcode;
    const d = JSON.parse(await downloadRetry(code));
    return { code, features: d.features };
  });
  let cityFail = 0;
  for (const cr of cityResults) {
    if (cr.__error) { cityFail++; continue; }
    const distFeats = cr.features.filter(f => f.properties.level === 'district');
    distFeats.forEach(dt => {
      districts.push(dt);
      fs.writeFileSync(path.join(DIST_DIR, dt.properties.adcode + '.json'),
        JSON.stringify({ properties: dt.properties, geometry: dt.geometry }));
    });
  }
  console.log('[fetch] 缓存: 省', provinces.length, ' 市(含区)', cities.length, ' 区', districts.length,
    (provFail || cityFail) ? ('  警告: 省失败' + provFail + ' 市失败' + cityFail) : '');

  // 重建前端底图
  fs.writeFileSync(MAP_PROV,
    JSON.stringify(fc(provinces.map(p => ({ type: 'Feature', properties: p.properties, geometry: p.geometry })))));
  for (const p of provinces) {
    const code = p.properties.adcode;
    const feats = (provinceCities[code] && provinceCities[code].length)
      ? provinceCities[code]
      : (provinceDistricts[code] || []);
    fs.writeFileSync(path.join(MAP_CITY_DIR, code + '.geojson'),
      JSON.stringify(fc(feats.map(f => ({ type: 'Feature', properties: f.properties, geometry: f.geometry })))));
  }
  console.log('[fetch] 前端底图已重建: map-boundaries/china-provinces.geojson + cities/<省>.geojson');
  console.log('[fetch] 完成。下一步入库: node import-datav.js  或  ./install.sh fetch-datav');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
