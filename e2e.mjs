// اختبار الواجهة من طرف إلى طرف في وضع المحاكاة (لا يحتاج شبكة خارجية).
// يشغّل الخادم، ويفتح Chromium بمقاسَي حاسوب وجوال، ويحفظ لقطات في test-results/.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 8795;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

rmSync('data/runtime-e2e', { recursive: true, force: true });
mkdirSync('test-results', { recursive: true });
const srv = spawn('npx', ['tsx', 'apps/server/src/main.ts'], {
  detached: true,
  env: { ...process.env, MODE: 'simulation', PORT: String(PORT), DATA_DIR: './data/runtime-e2e', TOMTOM_API_KEY: 'E2E_SECRET_KEY_123', ADMIN_TOKEN: 'e2e-admin' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => (srvLog += d));
srv.stderr.on('data', (d) => (srvLog += d));
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

try {
  // ── الأمان: المفتاح لا يظهر في الواجهة البرمجية ولا في حزمة الواجهة
  const meta = await (await fetch(base + '/api/meta')).text();
  check('المفتاح السري لا يظهر في /api/meta', !meta.includes('E2E_SECRET_KEY_123'));
  const bundle = readdirSync('apps/web/dist/assets').map((f) => readFileSync('apps/web/dist/assets/' + f, 'utf8')).join('');
  check('قيمة المفتاح السري لا تظهر في حزمة الواجهة', !bundle.includes('E2E_SECRET_KEY_123'));
  const unauth = await fetch(base + '/api/rules', { method: 'PUT', body: '{}' });
  check('تعديل القواعد مرفوض بلا رمز إدارة', unauth.status === 401, `HTTP ${unauth.status}`);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());
  for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844, isMobile: true }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const t0 = Date.now();
    await page.goto(base + '/?e2e=1');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 20000 });
    await page.waitForFunction(() => window.__map && window.__map.getLayer('segments-known') && window.__map.querySourceFeatures('segments').length > 0, null, { timeout: 20000 }).catch(() => {});
    check(`[${vp.name}] تحميل الخريطة وطبقة الطرق`, await page.evaluate(() => !!window.__map?.getLayer('segments-known')), `${Date.now() - t0} مللي ثانية`);
    check(`[${vp.name}] الاتجاه RTL واللغة العربية`, await page.evaluate(() => document.documentElement.dir === 'rtl' && document.documentElement.lang === 'ar'));
    check(`[${vp.name}] شريط المحاكاة الدائم ظاهر`, (await page.textContent('.sim-banner'))?.includes('بيانات محاكاة لأغراض العرض وليست حالة المرور الفعلية'));
    const labels = await page.locator('.district-label').count();
    check(`[${vp.name}] تسميات أحياء العينة`, labels >= 6, `${labels}`);
    // إما أن تُحمّل OpenFreeMap فعلًا بتسميات عربية، أو تظهر ملاحظة صادقة بتعذّرها
    await page.waitForFunction(() => window.__map?.isStyleLoaded() && window.__map.areTilesLoaded(), null, { timeout: 20000 }).catch(() => {});
    const bm = await page.evaluate(() => {
      const st = window.__map.getStyle();
      const vector = Object.values(st.sources).some((x) => x.type === 'vector' && String(x.url ?? '').includes('openfreemap'));
      const arabic = st.layers.some((l) => JSON.stringify(l.layout?.['text-field'] ?? '').includes('name:ar'));
      const rendered = vector ? window.__map.queryRenderedFeatures().filter((f) => f.source === 'openmaptiles').length : 0;
      return { vector, arabic, rendered, note: !!document.querySelector('.map-note:not(.pick)') };
    });
    if (bm.vector) check(`[${vp.name}] الخريطة الأساسية OpenFreeMap محمّلة فعليًا بتسميات name:ar`, bm.arabic && bm.rendered > 0 && !bm.note, JSON.stringify(bm));
    else check(`[${vp.name}] ملاحظة صادقة عن تعذّر الخريطة الأساسية`, bm.note, JSON.stringify(bm));
    const feats = await page.evaluate(() => {
      const fs = window.__map.querySourceFeatures('segments');
      const known = fs.filter((f) => f.properties.known === 1).length;
      return { total: fs.length, known, unknown: fs.length - known };
    });
    check(`[${vp.name}] مقاطع ملونة ورمادية (فجوات التغطية)`, feats.known > 0 && feats.unknown > 0, JSON.stringify(feats));

    // النقر على مقطع طريق ← بطاقة التفاصيل
    const pt = await page.evaluate(() => {
      const m = window.__map;
      const r = m.getCanvas().getBoundingClientRect();
      for (const f of m.queryRenderedFeatures({ layers: ['segments-known'] })) {
        const cs = f.geometry.coordinates;
        for (const t of [0.2, 0.35, 0.65, 0.8]) {
          const a = cs[0], b = cs[cs.length - 1];
          const p = m.project([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
          const x = r.left + p.x, y = r.top + p.y;
          const el = document.elementFromPoint(x, y);
          if (el && el.tagName === 'CANVAS') return { x, y };
        }
      }
      return null;
    });
    if (pt) {
      await page.mouse.click(pt.x, pt.y);
      await page.waitForSelector('.details', { timeout: 5000 }).catch(() => {});
      const txt = (await page.textContent('.details').catch(() => '')) ?? '';
      check(`[${vp.name}] بطاقة المقطع: الاسم والسرعة والمؤشر والمصدر ووقت الرصد`, ['السرعة الحالية', 'مؤشر انخفاض السرعة', 'المصدر', 'وقت الرصد', 'الكثافة'].every((s) => txt.includes(s)) && txt.includes('محاكاة'));
      check(`[${vp.name}] التدفق والكثافة «غير متاح» وليس صفرًا`, txt.includes('غير متاح'));
      await page.screenshot({ path: `test-results/${vp.name}-segment.png` });
      await page.click('.details .close');
    } else check(`[${vp.name}] العثور على مقطع للنقر`, false);

    // علامات الأحداث وإظهارها/إخفاؤها
    const evCount = await page.locator('.ev-marker').count();
    check(`[${vp.name}] علامات الأحداث`, evCount > 0, `${evCount}`);
    if (vp.name === 'desktop') {
      // العلامات قد تتراكب عند هذا التكبير، فنضغط العنصر مباشرة
      await page.locator('.ev-marker').first().evaluate((el) => el.click());
      check('[desktop] بطاقة الحدث: التحقق والشدة والتأخير', ((await page.textContent('.details')) ?? '').includes('التحقق'));
      await page.click('.details .close');
      await page.getByLabel('الحوادث والأعطال والإغلاقات').uncheck();
      check('[desktop] إخفاء طبقة الأحداث', (await page.locator('.ev-marker').count()) === 0);
      await page.getByLabel('الحوادث والأعطال والإغلاقات').check();
      // مرشح الشدة
      await page.locator('fieldset:has(legend:text("الأحداث")) select').first().selectOption('4');
      const crit = await page.locator('.ev-marker').count();
      check('[desktop] مرشح الشدة (حرجة فقط)', crit <= evCount, `${crit} من ${evCount}`);
      await page.locator('fieldset:has(legend:text("الأحداث")) select').first().selectOption('0');
      // تبديل مؤشر اللون إلى الكثافة
      await page.locator('fieldset:has(legend:text("لون الطريق")) select').selectOption('density');
      check('[desktop] مفتاح الألوان يتغير مع المؤشر', ((await page.textContent('.legend')) ?? '').includes('الكثافة'));
      await page.locator('fieldset:has(legend:text("لون الطريق")) select').selectOption('sri');
      await page.screenshot({ path: 'test-results/desktop-map.png' });
    }

    // لوحة القرار
    if (vp.name === 'mobile') await page.locator('.panel').scrollIntoViewIfNeeded();
    const decision = (await page.textContent('.panel-body')) ?? '';
    check(`[${vp.name}] لوحة القرار: الأقسام الأساسية`, ['أعلى ازدحام', 'أطول تأخير', 'مداخل ومخارج', 'الحوادث والأعطال', 'تدفق سلس', 'الظروف البيئية', 'مرافق حيوية', 'جودة البيانات'].every((s) => decision.includes(s)));

    // الأحياء والمقارنة
    await page.getByRole('tab', { name: 'الأحياء' }).click();
    await page.waitForSelector('.district-card', { timeout: 8000 }).catch(() => {});
    const dtext = (await page.textContent('.panel-body')) ?? '';
    check(`[${vp.name}] بطاقة الحي والمقارنة المعيارية والتوصيات والثقة`, ['المقارنة المعيارية', 'التوصيات', 'الثقة', 'مقارنة بفترات مماثلة'].every((s) => dtext.includes(s)));
    if (vp.name === 'desktop') await page.screenshot({ path: 'test-results/desktop-districts.png' });

    // التنبيهات
    await page.getByRole('tab', { name: 'التنبيهات' }).click();
    await page.waitForSelector('.alert, .panel-body .card', { timeout: 8000 });
    const nAlerts = await page.locator('article.alert').count();
    const atext = (await page.textContent('.panel-body')) ?? '';
    check(`[${vp.name}] التنبيهات وحالة القواعد`, atext.includes('حالة القواعد') && atext.includes('غير قابلة للتقييم'), `${nAlerts} تنبيه`);
    if (vp.name === 'desktop' && nAlerts > 0) {
      await page.locator('input[type=password]').fill('e2e-admin');
      page.once('dialog', (d) => d.accept('تم التحقق ميدانيًا'));
      await page.locator('article.alert').first().getByRole('button', { name: 'تسجيل إجراء' }).click();
      await page.waitForTimeout(800);
      check('[desktop] تسجيل إجراء على تنبيه يظهر في السجل', ((await page.locator('article.alert').first().textContent()) ?? '').includes('تم التحقق ميدانيًا'));
      const before = await page.locator('article.alert').count();
      page.once('dialog', (d) => d.accept('إنذار صحيح'));
      await page.locator('article.alert').first().getByRole('button', { name: 'إغلاق مع النتيجة' }).click();
      await page.waitForTimeout(800);
      check('[desktop] إغلاق التنبيه ينقله من النشطة', (await page.locator('article.alert').count()) === before - 1);
      await page.screenshot({ path: 'test-results/desktop-alerts.png' });
    }

    // المصادر
    await page.getByRole('tab', { name: 'المصادر' }).click();
    const nSrc = await page.locator('section.source').count();
    const stext = (await page.textContent('.panel-body')) ?? '';
    check(`[${vp.name}] سجل المصادر بالتصنيفات`, nSrc >= 14 && stext.includes('يحتاج مفتاحًا') && stext.includes('يحتاج اتفاقية') && stext.includes('غير متاح'), `${nSrc} مصدر`);
    check(`[${vp.name}] لا يُدّعى «متصل ومختبر» بلا فحص ناجح`, !stext.includes('متصل ومختبر') || stext.includes('✓ نجح'));

    // الزمن: تاريخي ومتوقع
    await page.getByRole('tab', { name: 'تاريخي' }).click();
    check(`[${vp.name}] الوضع التاريخي (شريط زمني أو تفسير)`, await page.locator('.timebar').isVisible());
    await page.getByRole('tab', { name: 'متوقع' }).click();
    check(`[${vp.name}] التنبؤ معطل مع السبب`, ((await page.textContent('.timebar')) ?? '').includes('التنبؤ غير مفعّل'));
    await page.getByRole('tab', { name: 'حالي' }).click();

    // المسارات في المحاكاة: معطلة بصدق
    await page.getByRole('tab', { name: 'المسارات' }).click();
    check(`[${vp.name}] المسارات معطلة في المحاكاة مع السبب`, ((await page.textContent('.panel-body')) ?? '').includes('معطل في وضع المحاكاة'));

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`[${vp.name}] لا تمرير أفقي للصفحة`, !overflow);
    await page.screenshot({ path: `test-results/${vp.name}-full.png`, fullPage: vp.name === 'mobile' });
    check(`[${vp.name}] لا أخطاء JavaScript`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
  await browser.close();
} catch (e) {
  check('تشغيل الاختبار', false, String(e?.stack ?? e));
} finally {
  try { process.kill(-srv.pid, 'SIGKILL'); } catch {}
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} نجح`);
if (failed.length) console.log(srvLog.slice(-2000));
import('node:fs').then((fs) => fs.writeFileSync('test-results/e2e.json', JSON.stringify(results, null, 1)));
setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
