const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1366, height: 520 } });
  await p.goto('http://127.0.0.1:8081/dashboard.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof _regionData !== 'undefined' && _regionData && _regionData.provinces && _regionData.provinces.length > 0, null, { timeout: 20000 });

  await p.evaluate(() => goRegionLevel(1, 'China'));
  await p.waitForFunction(() => _mapGeoData && _mapGeoData.features && _mapGeoData.features.length === 34, null, { timeout: 15000 });
  await p.waitForTimeout(600);

  var s3 = await p.evaluate(() => {
    var c = document.getElementById('regionChart');
    var ctx = c.getContext('2d');
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var n = 0;
    for (var i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
    return {
      canvasW: c.width, canvasH: c.height,
      cssW: c.getBoundingClientRect().width, cssH: c.getBoundingClientRect().height,
      brightPixels: n, totalPixels: d.length / 4,
      ratio: (n / (d.length / 4) * 100).toFixed(2) + '%',
      scale: _mapView.scale,
      ox: _mapView.offsetX.toFixed(1), oy: _mapView.offsetY.toFixed(1)
    };
  });
  console.log('Canvas state:', JSON.stringify(s3));
  await p.screenshot({ path: '/tmp/debug_l1.png' });

  // redraw
  var hasRedraw = await p.evaluate(() => typeof redrawMap === 'function');
  console.log('has redrawMap:', hasRedraw);
  if (hasRedraw) {
    await p.evaluate(() => redrawMap());
    await p.waitForTimeout(300);
    await p.screenshot({ path: '/tmp/debug_l1_redraw.png' });
    var s4 = await p.evaluate(() => {
      var c = document.getElementById('regionChart'); var ctx = c.getContext('2d');
      var d = ctx.getImageData(0, 0, c.width, c.height).data; var n = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
      return { brightPixels: n, ratio: (n / (d.length / 4) * 100).toFixed(2) + '%' };
    });
    console.log('After redraw:', JSON.stringify(s4));
  }
  await b.close();
})().catch(e => { console.error('ERR:', e); process.exit(2); });
