const { chromium } = require('playwright');
const URL = 'http://localhost:8081/dashboard.html';
const out = [];
const log = (ok, msg) => { out.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + msg); };

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._regionData && window._mapGeoData, { timeout: 15000 });

  // 等 34 省缓存与进入中国
  await page.evaluate(() => new Promise(res => {
    function step() {
      if (window._provGeoCache && window._provGeoCache.features && window._provGeoCache.features.length === 34) return res();
      setTimeout(step, 100);
    } step();
  }));

  // 1) 省名 → 几何索引 → 省名 闭环（图例/侧边栏下钻的解析逻辑）
  const provCheck = await page.evaluate(() => {
    const res = { total: 0, ok: 0, bad: [] };
    for (const p of window._regionData.provinces) {
      res.total++;
      const idx = window._provGeomIndex(p.name);        // 图例/侧边栏点击时传入的索引
      const back = window._provName({ level: 2, provIdx: idx, countryName: 'China' });
      if (idx >= 0 && back === p.name) res.ok++;
      else res.bad.push({ name: p.name, idx, back });
    }
    return res;
  });
  log(provCheck.ok === provCheck.total && provCheck.bad.length === 0,
    `省名↔几何索引闭环: ${provCheck.ok}/${provCheck.total}` + (provCheck.bad.length ? ' BAD=' + JSON.stringify(provCheck.bad) : ''));

  // 2) 进入某省(L2)，校验市索引→市名闭环（地图点市/侧边栏市下钻）
  const cityCheck = await page.evaluate(() => {
    // 找一个当前有城市的省
    for (const p of window._regionData.provinces) {
      const idx = window._provGeomIndex(p.name);
      const rv = { level: 2, countryName: 'China', provIdx: idx };
      const prov = window._provObj(window._provName(rv));
      if (prov && prov.cities && prov.cities.length) {
        let ok = 0, total = 0; const bad = [];
        for (let i = 0; i < prov.cities.length; i++) {
          total++;
          const c = prov.cities[i];
          const rv3 = { level: 3, countryName: 'China', provIdx: idx, cityIdx: i };
          const prov2 = window._provObj(window._provName(rv3));
          const city = prov2 && prov2.cities ? prov2.cities[rv3.cityIdx] : null;
          if (city && city.name === c.name) ok++; else bad.push({ i, expect: c.name, got: city ? city.name : null });
        }
        return { prov: p.name, total, ok, bad };
      }
    }
    return { prov: null, total: 0, ok: 0, bad: [] };
  });
  if (cityCheck.prov) {
    log(cityCheck.ok === cityCheck.total && cityCheck.bad.length === 0,
      `市索引↔市名闭环(${cityCheck.prov}): ${cityCheck.ok}/${cityCheck.total}` + (cityCheck.bad.length ? ' BAD=' + JSON.stringify(cityCheck.bad) : ''));
  } else log(true, '市索引闭环: 当前无带城市的省(数据变动)，跳过');

  // 3) 全部 34 省几何索引唯一且可解析（确保无错配）
  const allProv = await page.evaluate(() => {
    const list = window._provGeoCache.features;
    const seen = {}; let dup = 0, unres = 0;
    for (let i = 0; i < list.length; i++) {
      const nm = list[i].properties.name;
      const back = window._provName({ level: 2, provIdx: i, countryName: 'China' });
      if (back !== nm) unres++;
      if (seen[nm]) dup++; seen[nm] = 1;
    }
    return { n: list.length, dup, unres };
  });
  log(allProv.dup === 0 && allProv.unres === 0, `34省索引唯一且可解析: 重复=${allProv.dup} 解析失败=${allProv.unres}`);

  console.log('\npageErrors:', JSON.stringify(errs.slice(0, 5)));
  console.log(`\n==== 逻辑校验汇总: ${out.filter(Boolean).length}/${out.length} 通过 ====`);
  await browser.close();
})();
