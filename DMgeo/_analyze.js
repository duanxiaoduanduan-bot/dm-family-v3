const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1366, height: 520 } });
  await p.goto('http://127.0.0.1:8081/dashboard.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof _regionData !== 'undefined' && _regionData && _regionData.provinces && _regionData.provinces.length > 0, null, { timeout: 20000 });
  await p.evaluate(() => goRegionLevel(1, 'China'));
  await p.waitForFunction(() => _mapGeoData && _mapGeoData.features && _mapGeoData.features.length === 34, null, { timeout: 20000 });
  await p.waitForTimeout(400);

  const info = await p.evaluate(() => {
    const c = document.getElementById('regionChart');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;
    let minx = W, maxx = 0, miny = H, maxy = 0, nonTransparent = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] > 10) { nonTransparent++;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
    }
    const colHasContent = [];
    for (let x = 0; x < W; x++) { let h = false; for (let y = 0; y < H; y++) if (d[(y * W + x) * 4 + 3] > 10) { h = true; break; } colHasContent.push(h); }
    return {
      contentBBox: { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 },
      contentWpct: (((colHasContent.lastIndexOf(true) - colHasContent.indexOf(true) + 1) / W) * 100).toFixed(1) + '%',
      fillRate: (nonTransparent / (W * H) * 100).toFixed(2) + '%',
      scale: _mapView.scale,
      offset: { x: _mapView.offsetX.toFixed(1), y: _mapView.offsetY.toFixed(1) },
      right20pctEmpty: colHasContent.slice(Math.floor(W * 0.8)).every(v => !v),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await p.screenshot({ path: '/tmp/v2_level1.png' });
  console.log('screenshot saved');

  // 也截图 L2 河北
  await p.evaluate(async () => {
    // 找河北省索引
    var idx = -1;
    for (var i = 0; i < _regionData.provinces.length; i++) { if (_regionData.provinces[i].name === '河北省') { idx = i; break; } }
    if (idx >= 0) goRegionLevel(2, 'China', idx);
  });
  await p.waitForFunction(() => _regionView.level === 2, null, { timeout: 20000 });
  await p.waitForFunction(() => _mapGeoData && _mapGeoData.features && _mapGeoData.features.length > 0, null, { timeout: 20000 });
  await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/v2_level2_hebei.png' });

  // L2 北京
  await p.evaluate(() => goRegionLevel(2, 'China', 0));
  await p.waitForFunction(() => _regionView.level === 2, null, { timeout: 20000 });
  await p.waitForFunction(() => _mapGeoData && _mapGeoData.features && _mapGeoData.features.length > 0, null, { timeout: 20000 });
  await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/v2_level2_beijing.png' });

  await b.close();
})().catch(e => { console.error('ERR:', e); process.exit(2); });
