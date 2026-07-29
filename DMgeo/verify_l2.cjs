const { chromium } = require('playwright');
const URL = 'http://localhost:8081/dashboard.html';

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
    const canvas = document.getElementById('regionChart');
    const rect = canvas.getBoundingClientRect();
    const W = canvas.width, H = canvas.height, cv = window._mapView, lvl = window._regionView.level;
    const p = (lvl === 0)
      ? { x: lng * (cv.scale * W / 360.0) + W / 2 + cv.offsetX, y: H / 2 - (lat / 90) * H * 0.5 * cv.scale + cv.offsetY }
      : (() => { const cx = 104.0, cy = 36.0, s = cv.scale * W / 55.0; return { x: (lng - cx) * Math.cos(cy * Math.PI / 180) * s + W / 2 + cv.offsetX, y: -(lat - cy) * s + H / 2 + cv.offsetY }; })();
    return { clientX: rect.left + p.x, clientY: rect.top + p.y, lng, lat, level: lvl, geoLen: window._mapGeoData.features.length };
  }, name);
  if (!c || c.notFound) return c;
  await page.mouse.move(c.clientX, c.clientY);
  await page.waitForTimeout(150);
  await page.mouse.click(c.clientX, c.clientY);
  return c;
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const consoleErrors = [], pageErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._regionData && window._mapGeoData, { timeout: 15000 });

  await clickFeature(page, 'China');
  await page.waitForFunction(() => window._regionView.level === 1 && window._mapGeoData && window._mapGeoData.features.some(f => f.properties.name === '内蒙古自治区'), { timeout: 10000 }).catch(() => console.log('WARN 未达中国视图'));
  console.log('AT CHINA:', JSON.stringify(await page.evaluate(() => ({ level: window._regionView.level, geo: window._mapGeoData.features.length }))));

  await clickFeature(page, '内蒙古自治区');
  // 立即读取 _provName 解析结果
  const resolved = await page.evaluate(() => ({ provName: window._provName(window._regionView), provIdx: window._regionView.provIdx, level: window._regionView.level }));
  console.log('CLICK 内蒙古 -> 解析:', JSON.stringify(resolved));

  async function sample() {
    return await page.evaluate(() => {
      const c = document.getElementById('regionChart'), ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const px = (ix, iy) => { const d = ctx.getImageData(ix, iy, 1, 1).data; return [d[0], d[1], d[2], d[3]]; };
      let drawn = 0, total = 0;
      for (let yy = 0; yy < H; yy += 20) for (let xx = 0; xx < W; xx += 20) { total++; const d = ctx.getImageData(xx, yy, 1, 1).data; if (d[3] > 10) drawn++; }
      const rv = window._regionView;
      return {
        level: rv.level, provIdx: rv.provIdx,
        resolvedName: window._provName(rv),
        geoFeat: window._mapGeoData ? window._mapGeoData.features.length : -1,
        center: px(Math.floor(W / 2), Math.floor(H / 2)),
        drawnRatio: (drawn / total).toFixed(3)
      };
    });
  }

  const timeline = [];
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) { timeline.push({ t: Date.now() - t0, ...(await sample()) }); await page.waitForTimeout(250); }

  console.log('\n==== 内蒙古 L2 时间线（前 12 行 + 30s 附近 + 末 3 行）====');
  timeline.slice(0, 12).forEach(e => console.log(`${String(e.t).padStart(5)} L${e.level} idx=${e.provIdx} name=${e.resolvedName} geo=${e.geoFeat} drawn=${e.drawnRatio} center=${JSON.stringify(e.center)}`));
  const idx30 = timeline.findIndex(e => e.t >= 30000);
  if (idx30 >= 0) { console.log('--- 30s 刷新附近 ---'); timeline.slice(idx30 - 1, idx30 + 3).forEach(e => console.log(`${String(e.t).padStart(5)} L${e.level} idx=${e.provIdx} name=${e.resolvedName} geo=${e.geoFeat} drawn=${e.drawnRatio}`)); }
  console.log('--- 末 3 行 ---'); timeline.slice(-3).forEach(e => console.log(`${String(e.t).padStart(5)} L${e.level} idx=${e.provIdx} name=${e.resolvedName} geo=${e.geoFeat} drawn=${e.drawnRatio} center=${JSON.stringify(e.center)}`));
  console.log('\nconsoleErrors:', JSON.stringify(consoleErrors.slice(0, 10)));
  console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 10)));
  await browser.close();
})();
