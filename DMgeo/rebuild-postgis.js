// rebuild-postgis.js — 使用标准 Natural Earth + xyanmi/MapData 重建 PostGIS
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pgPool = new Pool({ database: 'dmpageo', user: 'dmuser', password: 'dmpageo123', max: 5 });
const DATA_DIR = path.join(__dirname, 'geodata', 'standard');

async function main() {
  console.log('🔄 开始重建 PostGIS 地理数据...\n');

  // ===== 1. 清空旧表 =====
  console.log('1/4 清空旧数据...');
  await pgPool.query('DELETE FROM cities');
  await pgPool.query('DELETE FROM provinces');
  await pgPool.query('DELETE FROM countries');
  console.log('   ✅ 已清空 countries, provinces, cities\n');

  // ===== 2. 导入国家数据 (Natural Earth via datasets/geo-countries, 已 -makevalid) =====
  console.log('2/4 导入国家数据...');
  const countriesGeoJSON = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'countries.geojson'), 'utf8'));
  let cnt = 0;
  for (const feat of countriesGeoJSON.features) {
    const name = feat.properties.name || feat.properties.Name || 'Unknown';
    const iso3 = feat.properties['ISO3166-1-Alpha-3'] || '';
    const iso2 = feat.properties['ISO3166-1-Alpha-2'] || '';
    const geom = feat.geometry;
    if (!geom || !geom.coordinates) continue;

    // 确保是 MultiPolygon
    let finalGeom = geom;
    if (geom.type === 'Polygon') {
      finalGeom = { type: 'MultiPolygon', coordinates: [geom.coordinates] };
    }

    try {
      await pgPool.query(
        `INSERT INTO countries (name, geom) VALUES ($1, ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2),4326)),3))`,
        [name, JSON.stringify(finalGeom)]
      );
      cnt++;
    } catch(e) {
      try {
        await pgPool.query(
          `INSERT INTO countries (name, geom) VALUES ($1, ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2),4326)),3))`,
          [name, JSON.stringify(geom)]
        );
        cnt++;
      } catch(e2) {
        console.log(`   ⚠️  跳过 ${name}: ${e2.message.substring(0,60)}`);
      }
    }
  }
  console.log(`   ✅ 导入 ${cnt} 个国家\n`);

  // ===== 3. 导入省份数据 =====
  console.log('3/4 导入省份数据...');
  const provincesGeoJSON = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'china-provinces.geojson'), 'utf8'));
  let provCnt = 0;
  // adcode 映射（省份的 adcode 前2位+0000）
  const provCodeMap = {
    '北京市':'110000','天津市':'120000','河北省':'130000','山西省':'140000','内蒙古自治区':'150000',
    '辽宁省':'210000','吉林省':'220000','黑龙江省':'230000','上海市':'310000','江苏省':'320000',
    '浙江省':'330000','安徽省':'340000','福建省':'350000','江西省':'360000','山东省':'370000',
    '河南省':'410000','湖北省':'420000','湖南省':'430000','广东省':'440000','广西壮族自治区':'450000',
    '海南省':'460000','重庆市':'500000','四川省':'510000','贵州省':'520000','云南省':'530000',
    '西藏自治区':'540000','陕西省':'610000','甘肃省':'620000','青海省':'630000','宁夏回族自治区':'640000',
    '新疆维吾尔自治区':'650000','台湾省':'710000','香港特别行政区':'810000','澳门特别行政区':'820000'
  };

  for (const feat of provincesGeoJSON.features) {
    const name = feat.properties.name;
    if (!name || !name.trim()) continue;
    const adcode = feat.properties.adcode || '';
    const code = provCodeMap[name] || adcode;
    const geom = feat.geometry;
    if (!geom || !geom.coordinates) continue;

    let finalGeom = geom;
    if (geom.type === 'Polygon') {
      finalGeom = { type: 'MultiPolygon', coordinates: [geom.coordinates] };
    }

    try {
      await pgPool.query(
        `INSERT INTO provinces (name, code, geom) VALUES ($1, $2, ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)),3))`,
        [name, code, JSON.stringify(finalGeom)]
      );
      provCnt++;
    } catch(e) {
      console.log(`   ⚠️  跳过省份 ${name}: ${e.message.substring(0,60)}`);
    }
  }
  console.log(`   ✅ 导入 ${provCnt} 个省份\n`);

  // ===== 4. 导入城市数据 =====
  console.log('4/4 导入城市数据...');
  const citiesGeoJSON = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'china-cities-merged.geojson'), 'utf8'));
  let cityCnt = 0;
  for (const feat of citiesGeoJSON.features) {
    const name = feat.properties.name;
    if (!name || !name.trim()) continue;
    const adcode = String(feat.properties.adcode || '');
    // province_code = adcode 前2位 + 0000
    const provinceCode = adcode.length >= 6 ? adcode.substring(0,2) + '0000' : '';
    const geom = feat.geometry;
    if (!geom || !geom.coordinates) continue;

    let finalGeom = geom;
    if (geom.type === 'Polygon') {
      finalGeom = { type: 'MultiPolygon', coordinates: [geom.coordinates] };
    }

    try {
      await pgPool.query(
        `INSERT INTO cities (name, province_code, geom) VALUES ($1, $2, ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)),3))`,
        [name, provinceCode, JSON.stringify(finalGeom)]
      );
      cityCnt++;
    } catch(e) {
      console.log(`   ⚠️  跳过城市 ${name}: ${e.message.substring(0,60)}`);
    }
  }
  console.log(`   ✅ 导入 ${cityCnt} 个城市\n`);

  // ===== 5. 验证 =====
  console.log('='.repeat(50));
  console.log('📊 数据验证:');
  const validCheck = await pgPool.query(`
    SELECT 'countries' as tbl,
      count(*) as total,
      count(*) FILTER (WHERE ST_IsValid(geom)) as valid,
      count(*) FILTER (WHERE NOT ST_IsValid(geom)) as invalid
    FROM countries
    UNION ALL
    SELECT 'provinces', count(*),
      count(*) FILTER (WHERE ST_IsValid(geom)),
      count(*) FILTER (WHERE NOT ST_IsValid(geom))
    FROM provinces
    UNION ALL
    SELECT 'cities', count(*),
      count(*) FILTER (WHERE ST_IsValid(geom)),
      count(*) FILTER (WHERE NOT ST_IsValid(geom))
    FROM cities
    ORDER BY tbl
  `);
  for (const r of validCheck.rows) {
    const pct = r.total > 0 ? (r.valid / r.total * 100).toFixed(1) : '0';
    console.log(`  ${r.tbl}: ${r.valid}/${r.total} 有效 (${pct}%)  ${r.invalid > 0 ? '⚠️ '+r.invalid+' 无效' : '✅'}`);
  }

  console.log('\n✅ 重建完成！');
  await pgPool.end();
}

main().catch(e => { console.error('❌', e.message); pgPool.end(); process.exit(1); });
