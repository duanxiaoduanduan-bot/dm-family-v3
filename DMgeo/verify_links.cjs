const { chromium } = require('playwright');
const URL = 'http://localhost:8081/dashboard.html';
const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); }

async function clickFeature(page, name) {
  const c = await page.evaluate((nm) => {
    if (!window._mapGeoData) return { notFound: true };
    const f = window._mapGeoData.features.find(x => x.properties && x.properties.name === nm);
    if (!f) return { notFound: true };
    let ring = null, max = -1;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) for (const r of p) if (r.length > max) { max = r.length; ring = r; }
    let sx = 0, sy = 0; for (const cc of ring) { sx += cc[0]; sy += cc[1]; }
    const lng = sx / ring.length, lat = sy / ring.length;
    const canvas = document.getElementById('regionChart'), rect = canvas.getBoundingClientRect();
    const W = canvas.width, H = canvas.height, cv = window._mapView, lvl = window._regionView.level;
    const p = (lvl === 0)
      ? { x: lng * (cv.scale * W / 360.0) + W / 2 + cv.offsetX, y: H / 2 - (lat / 90) * H * 0.5 * cv.scale + cv.offsetY }
      : (() => { const cx = 104.0, cy = 36.0, s = cv.scale * W / 55.0; return { x: (lng - cx) * Math.cos(cy * Math.PI / 180) * s + W / 2 + cv.offsetX, y: -(lat - cy) * s + H / 2 + cv.offsetY }; })();
    return { clientX: rect.left + p.x, clientY: rect.top + p.y };
  }, name);
  if (!c || c.notFound) return false;
  await page.mouse.move(c.clientX, c.clientY); await page.waitForTimeout(120); await page.mouse.click(c.clientX, c.clientY);
  return true;
}

// 点击侧边栏/图例/面包屑里含某文字且 onclick 以 prefix 开头的元素（真实 DOM click）
async function clickDomByText(page, scopeSel, onclickPrefix, text) {
  return await page.evaluate((arg) => {
    const scope = document.querySelector(arg.scopeSel); if (!scope) return { err: 'no ' + arg.scopeSel };
    const els = scope.querySelectorAll('*');
    for (const el of els) {
      const oc = el.getAttribute('onclick') || '';
      if (oc.indexOf(arg.onclickPrefix) === 0 && (el.textContent || '').includes(arg.text)) { el.click(); return { ok: true }; }
    }
    return { err: 'not found ' + arg.onclickPrefix + ' / ' + arg.text };
  }, { scopeSel, onclickPrefix, text });
}

async function state(page) {
  return await page.evaluate(() => {
    const rv = window._regionView;
    const prov = window._provName(rv);
    let city = null;
    if (rv.level >= 3) { const p = window._provObj(prov); city = p && p.cities ? p.cities[rv.cityIdx] : null; }
    return { level: rv.level, countryName: rv.countryName, provIdx: rv.provIdx, cityIdx: rv.cityIdx, provName: prov, cityName: city ? city.name : null };
  });
}

async function freshProv(page) {
  const list = await page.evaluate(() => window._regionData ? window._regionData.provinces.map(p => p.name) : []);
  return list.length ? list[0] : null;
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const consoleErrors = [], pageErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._regionData && window._mapGeoData, { timeout: 15000 });
  const wait = (ms) => page.waitForTimeout(ms);

  // 进入中国
  await clickFeature(page, 'China');
  await page.waitForFunction(() => window._regionView.level === 1, { timeout: 10000 }).catch(() => {});
  check('世界→中国 (地图点中国)', (await state(page)).level === 1, JSON.stringify(await state(page)));

  // 取当前要素省列表
  const provNames = await page.evaluate(() => window._regionData.provinces.map(p => p.name));
  check('存在要素省用于测试', provNames.length > 0, JSON.stringify(provNames));

  // 等待 34 省几何缓存就绪（启动即预加载），消除异步间隙
  await page.waitForFunction(() => window._provGeoCache && window._provGeoCache.features && window._provGeoCache.features.length === 34, { timeout: 8000 }).catch(() => {});

  // 1) 侧边栏省链接
  {
    const target = await freshProv(page);
    const r = await clickDomByText(page, '#regionStatsInline', "goRegionLevel(2", target);
    await page.waitForFunction(() => window._regionView.level === 2, { timeout: 8000 }).catch(() => {});
    const s = await state(page);
    check('侧边栏省链接→正确省', s.level === 2 && s.provName === target, `target=${target} got=${s.provName}`);
  }

  // 2) 面包屑返回中国
  {
    await clickDomByText(page, '#regionBreadcrumb', "goRegionLevel(1", '中国');
    await page.waitForFunction(() => window._regionView.level === 1, { timeout: 8000 }).catch(() => {});
    check('面包屑→中国(L1)', (await state(page)).level === 1);
  }

  // 3) 图例省链接（图例在 drawCountryMap 回调内渲染，需等其就绪）
  {
    const target = await freshProv(page);
    await page.waitForFunction((t) => {
      const el = document.querySelector('#regionChartLegend');
      return window._regionView.level === 1 && el && el.textContent.includes(t);
    }, target, { timeout: 8000 }).catch(() => {});
    const r = await clickDomByText(page, '#regionChartLegend', "goRegionLevel(2", target);
    await page.waitForFunction(() => window._regionView.level === 2, { timeout: 8000 }).catch(() => {});
    const s = await state(page);
    check('图例省链接→正确省', s.level === 2 && s.provName === target, `target=${target} got=${s.provName}`);
  }

  // 4) 侧边栏市链接（读取当下实时城市列表）
  let cityTarget = null;
  {
    cityTarget = await page.evaluate(() => {
      const p = window._provObj(window._provName(window._regionView));
      return p && p.cities && p.cities.length ? p.cities[0].name : null;
    });
    if (cityTarget) {
      await page.waitForFunction((t) => {
        const el = document.querySelector('#regionStatsInline');
        return el && el.textContent.includes(t);
      }, cityTarget, { timeout: 8000 }).catch(() => {});
      const r = await clickDomByText(page, '#regionStatsInline', "goRegionLevel(3", cityTarget);
      await page.waitForFunction(() => window._regionView.level === 3, { timeout: 8000 }).catch(() => {});
      const s = await state(page);
      check('侧边栏市链接→正确市', s.level === 3 && s.cityName === cityTarget, `target=${cityTarget} got=${s.cityName}`);
    } else check('侧边栏市链接', true, '该省当前无城市(数据变动)，跳过');
  }

  // 5) 面包屑返回省(L2)
  if (cityTarget) {
    await clickDomByText(page, '#regionBreadcrumb', "goRegionLevel(2", '');
    await page.waitForFunction(() => window._regionView.level === 2, { timeout: 8000 }).catch(() => {});
    check('面包屑→省(L2)', (await state(page)).level === 2);
    // 再返回中国
    await clickDomByText(page, '#regionBreadcrumb', "goRegionLevel(1", '中国');
    await page.waitForFunction(() => window._regionView.level === 1, { timeout: 8000 }).catch(() => {});
    check('面包屑→中国(L1)', (await state(page)).level === 1);
  }

  // 6) 地图点省 → 地图点市（先确保已进入中国视图）
  {
    await clickFeature(page, 'China');
    await page.waitForFunction(() => window._regionView.level === 1 && window._mapGeoData && window._mapGeoData.features.length === 34, { timeout: 8000 }).catch(() => {});
    const target = await freshProv(page);
    await clickFeature(page, target);
    await page.waitForFunction(() => window._regionView.level === 2, { timeout: 8000 }).catch(() => {});
    const s2 = await state(page);
    check('地图点省→正确省', s2.level === 2 && s2.provName === target, `target=${target} got=${s2.provName}`);
    // 该市几何列表
    const cityGeo = await page.evaluate(() => window._mapGeoData ? window._mapGeoData.features.map(f => f.properties.name) : []);
    if (cityGeo.length) {
      const ct = cityGeo[0];
      const ok = await clickFeature(page, ct);
      await page.waitForFunction(() => window._regionView.level === 3, { timeout: 8000 }).catch(() => {});
      const s3 = await state(page);
      check('地图点市→正确市', s3.level === 3 && s3.cityName === ct, `target=${ct} got=${s3.cityName}`);
      // 面包屑→全球(L0)
      await clickDomByText(page, '#regionBreadcrumb', "goRegionLevel(0", '全球');
      await page.waitForFunction(() => window._regionView.level === 0, { timeout: 8000 }).catch(() => {});
      check('面包屑→全球(L0)', (await state(page)).level === 0);
    } else check('地图点市', false, '该市几何列表为空');
  }

  // 7) 返回按钮（按设计返回全球 L0）
  {
    await clickFeature(page, 'China');
    await page.waitForFunction(() => window._regionView.level === 1, { timeout: 8000 }).catch(() => {});
    const target = await freshProv(page);
    await clickFeature(page, target);
    await page.waitForFunction(() => window._regionView.level === 2, { timeout: 8000 }).catch(() => {});
    const clicked = await page.evaluate(() => { const b = document.getElementById('mapBackBtn'); if (b && b.style.display !== 'none') { b.click(); return true; } return false; });
    await page.waitForFunction(() => window._regionView.level === 0, { timeout: 8000 }).catch(() => {});
    check('返回按钮→全球(L0)', clicked && (await state(page)).level === 0);
  }

  // 8) 非中国国家（固定用世界图里真实存在的国家）
  {
    // 先回世界视图，等待世界几何(177)加载
    await page.evaluate(() => { const b = document.getElementById('mapBackBtn'); if (b) b.click(); });
    await page.waitForFunction(() => window._regionView.level === 0 && window._mapGeoData && window._mapGeoData.features.length === 177, { timeout: 8000 }).catch(() => {});
    const t = await page.evaluate(() => {
      const names = window._mapGeoData.features.map(f => f.properties.name);
      return names.find(n => n === 'Afghanistan') || names.find(n => n === 'Russia') || names.find(n => n === 'India') || (names.filter(n => n !== 'China')[0] || null);
    });
    if (t) {
      const ok = await clickFeature(page, t);
      await page.waitForTimeout(600);
      const s = await state(page);
      check('非中国国家点击→L1该国家', s.level === 1 && s.countryName === t, `target=${t} got=${JSON.stringify(s)}`);
    } else check('非中国国家', false, '世界图无国家');
  }

  console.log('\nconsoleErrors:', JSON.stringify(consoleErrors.slice(0, 8)));
  console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 8)));
  const passed = results.filter(r => r.pass).length;
  console.log(`\n==== 汇总: ${passed}/${results.length} 通过 ====`);
  await browser.close();
})();
