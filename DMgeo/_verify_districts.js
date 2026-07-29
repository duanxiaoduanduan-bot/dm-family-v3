const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));

  await page.goto('http://127.0.0.1:8081/dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof _regionData !== 'undefined' && _regionData && _regionData.provinces && _regionData.provinces.length > 0, null, { timeout: 20000 });

  // 统计卡：覆盖区/县
  const cntDist = await page.evaluate(() => document.getElementById('cntDist').textContent);
  console.log('📍 覆盖区/县(cntDist) =', cntDist, '(期望 2)');

  // L1 右侧栏列出几个省
  await page.evaluate(() => goRegionLevel(1, 'China'));
  await page.waitForFunction(() => _mapGeoData && _mapGeoData.features && _mapGeoData.features.length === 34, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  const l1 = await page.evaluate(() => {
    const html = document.getElementById('regionStatsInline').innerText;
    return { sidebarText: html.slice(0, 200), provinceCount: _regionData.provinces.length };
  });
  console.log('L1 右侧栏文本前200字:', JSON.stringify(l1.sidebarText));
  console.log('L1 data.provinces 数量(侧栏依据的省列表):', l1.provinceCount, '— 地图画出 34 省');
  await page.screenshot({ path: '/tmp/v_level1.png' });

  // 下钻到 北京市(idx0) → 大兴区(level3)
  await page.evaluate(() => goRegionLevel(2, 'China', 0));
  await page.waitForFunction(() => _regionView.level === 2, null, { timeout: 20000 });
  await page.waitForFunction(() => _mapGeoData && _mapGeoData.features && _mapGeoData.features.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  const l2 = await page.evaluate(() => {
    const prov = _regionData.provinces[0];
    return { cityCount: prov.cities.length, cities: prov.cities.map(c => c.name + '(districts=' + (c.districts ? c.districts.length : 0) + ')') };
  });
  console.log('L2 北京市 城市:', JSON.stringify(l2));

  // 进入 level3 区县
  await page.evaluate(() => goRegionLevel(3, 'China', 0, 0));
  await page.waitForFunction(() => _regionView.level === 3, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  const l3ok = await page.evaluate(() => {
    // 判断环形图是否绘制（canvas 有亮色像素）
    const c = document.getElementById('regionChart'); const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data; let bright = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i+1] + d[i+2] > 200 && d[i+3] > 50) bright++; }
    return { level: _regionView.level, brightPixels: bright, legend: document.getElementById('regionChartLegend').innerText.slice(0,120) };
  });
  console.log('L3 区县环形图:', JSON.stringify(l3ok), '(brightPixels>0 表示已绘制)');
  await page.screenshot({ path: '/tmp/v_level3.png' });

  await browser.close();
})().catch(e => { console.error('异常:', e); process.exit(2); });
