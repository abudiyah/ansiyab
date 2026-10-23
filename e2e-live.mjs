// فحص الواجهة في الوضع الحي ضد خادم يعمل فعلًا (npm start بـ MODE=live) وبمصادر حقيقية.
// لا يشغّل خادمًا بنفسه: BASE=http://localhost:8787 node scripts/e2e-live.mjs
// يتحقق من غياب أي بيانات محاكاة، ومن أن المصادر المختبرة فقط موسومة «متصل ومختبر»، وأن الطرق بلا مصدر سرعات تبقى رمادية.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.BASE ?? 'http://localhost:8787';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const j = async (p) => (await fetch(base + p)).json();
mkdirSync('test-results', { recursive: true });

const meta = await j('/api/meta');
check('الخادم في الوضع الحي بلا شريط محاكاة', meta.config.mode === 'live' && !meta.simulationBannerAr);
const tested = meta.sources.filter((s) => s.effectiveClassification === 'connected_tested').map((s) => s.id);
check('كل مصدر «متصل ومختبر» له فحص ناجح', meta.sources.every((s) => s.effectiveClassification !== 'connected_tested' || s.connectionTest?.ok), tested.join(', '));
const state = await j('/api/state');
const cur = (state.weather ?? []).find((w) => w.kind === 'current');
check('طقس حالي حقيقي من Open-Meteo موسوم «live»', cur && cur.sourceId === 'open-meteo' && cur.provenance === 'live', cur ? `${cur.temperatureC}°C، رياح ${cur.windSpeedKmh} كم/س، رؤية ${cur.visibilityM} م، غبار ${cur.dustUgM3} µg/m³، رصد ${cur.observedAt}` : 'لا قراءة');
const network = await j('/api/network').catch(() => null);
const built = !!network?.segments?.length;
check('شبكة OSM الحقيقية', built, built ? `${network.districts.length} حيًا، ${network.segments.length} مقطعًا، بُنيت ${network.builtAt}` : 'لم تُبنَ بعد (Overpass)');
const speedCount = Object.keys(state.speed ?? {}).length;
check('لا سرعات مختلقة بلا مصدر سرعات', meta.config.tomtomConfigured || speedCount === 0, `${speedCount} قراءة سرعة`);
const route = await j('/api/route?from=46.6753,24.7136&to=46.7275,24.6561');
check('مسار حقيقي من OSRM', route.routes?.length > 0, route.routes?.[0] ? `${(route.routes[0].distanceM / 1000).toFixed(1)} كم` : JSON.stringify(route).slice(0, 120));
const geo = await j('/api/geocode?q=' + encodeURIComponent('الملز'));
check('بحث جغرافي حقيقي من Nominatim', Array.isArray(geo) && geo.length > 0, geo?.[0]?.displayName);

const mf = await fetch(base + '/manifest.webmanifest');
const mfj = await mf.json().catch(() => null);
check('بيان تطبيق الويب (manifest) صالح', mf.ok && mf.headers.get('content-type')?.includes('manifest') && mfj?.display === 'standalone' && mfj.icons?.some((i) => i.sizes === '512x512'), mf.headers.get('content-type'));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());
for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844, isMobile: true }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/?e2e=1');
  await page.waitForSelector('.maplibregl-canvas', { timeout: 20000 });
  await page.waitForFunction(() => window.__map?.isStyleLoaded() && window.__map.areTilesLoaded(), null, { timeout: 25000 }).catch(() => {});
  check(`[${vp.name}] لا شريط محاكاة`, (await page.locator('.sim-banner').count()) === 0);
  const bm = await page.evaluate(() => {
    const st = window.__map.getStyle();
    const vector = Object.values(st.sources).some((x) => x.type === 'vector' && String(x.url ?? '').includes('openfreemap'));
    const rendered = window.__map.queryRenderedFeatures().filter((f) => f.source === 'openmaptiles').length;
    return { vector, rendered };
  });
  check(`[${vp.name}] الخريطة الأساسية OpenFreeMap محمّلة`, bm.vector && bm.rendered > 0, JSON.stringify(bm));
  if (built) {
    const feats = await page.evaluate(() => {
      const fs = window.__map.querySourceFeatures('segments');
      return { total: fs.length, known: fs.filter((f) => f.properties.known === 1).length };
    });
    check(`[${vp.name}] مقاطع OSM مرسومة ورمادية بلا مصدر سرعات`, feats.total > 0 && (meta.config.tomtomConfigured || feats.known === 0), JSON.stringify(feats));
  }
  await page.screenshot({ path: `test-results/live-${vp.name}-map.png` });
  const sw = await page.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))]);
    return reg ? reg.active?.scriptURL ?? 'pending' : null;
  });
  check(`[${vp.name}] عامل الخدمة مسجل (قابل للتثبيت)`, !!sw, String(sw));
  await page.getByRole('tab', { name: 'المصادر' }).click();
  const stext = (await page.textContent('.panel-body')) ?? '';
  check(`[${vp.name}] سجل المصادر يعرض «متصل ومختبر» مع «✓ نجح»`, stext.includes('متصل ومختبر') && stext.includes('نجح'));
  await page.screenshot({ path: `test-results/live-${vp.name}-sources.png` });
  check(`[${vp.name}] لا أخطاء JavaScript`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
await browser.close();
writeFileSync('test-results/e2e-live.json', JSON.stringify({ at: new Date().toISOString(), base, results }, null, 1));
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} نجح`);
process.exit(passed === results.length ? 0 : 1);
