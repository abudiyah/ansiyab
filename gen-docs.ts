/** يولّد docs/SOURCES.md وdocs/INDICATORS.md وdocs/ALERTS.md من الكود (مصدر واحد للحقيقة) */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CLASSIFICATION_AR, INDICATORS, RULES, SOURCES, SRI_SCALE, DENSITY_SCALE } from '../packages/core/src/index.ts';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

// نتائج آخر تشغيل لـ npm run probe، إن وُجدت
type Probe = { sourceId: string; ok: boolean; testedAt: string; httpStatus: number | null; detail: string };
const PROBE_FILE = 'data/runtime/source-status.json';
const probeRaw = existsSync(PROBE_FILE) ? JSON.parse(readFileSync(PROBE_FILE, 'utf8')) : [];
const probes = new Map<string, Probe>((Array.isArray(probeRaw) ? probeRaw : probeRaw.results ?? []).map((p: Probe) => [p.sourceId, p]));
const probeLine = (id: string) => {
  const p = probes.get(id);
  if (!p) return 'لم يُختبر';
  if (p.httpStatus == null && p.detail.startsWith('لم يُختبر')) return `${p.detail} (${p.testedAt.slice(0, 10)})`;
  return `${p.ok ? '✓ نجح' : '✗ لم ينجح'} في ${p.testedAt.slice(0, 16).replace('T', ' ')} UTC: ${p.detail}`;
};

let s = `# سجل مصادر البيانات\n\n> مولَّد آليًا من \`packages/core/src/sources/registry.ts\` بالأمر \`npx tsx scripts/gen-docs.ts\`. تاريخ التحقق من الوثائق مذكور لكل مصدر.\n\n`;
s += `**قاعدة التصنيف:** لا يُصنَّف أي مصدر «متصل ومختبر» إلا بعد نجاح \`npm run probe\` خلال آخر 24 ساعة، وتحسب الواجهة هذا التصنيف لحظيًا من آخر اختبار. التصنيف في الجدول هو التصنيف الأساسي، وعمود «آخر اختبار» مأخوذ من \`${PROBE_FILE}\` عند توليد الوثيقة.\n\n`;
s += `| المصدر | المجال | التصنيف | آخر اختبار | المتطلب |\n|---|---|---|---|---|\n`;
for (const x of SOURCES) {
  const p = probes.get(x.id);
  const cls = p?.ok ? CLASSIFICATION_AR.connected_tested : CLASSIFICATION_AR[x.classification];
  s += `| ${esc(x.nameAr)} | ${x.domain} | **${cls}** | ${!p ? '—' : p.httpStatus == null && p.detail.startsWith('لم يُختبر') ? 'لم يُختبر' : `${p.ok ? '✓' : '✗'} ${p.testedAt.slice(0, 10)}`} | ${esc(x.requirementAr)} |\n`;
}
for (const x of SOURCES) {
  s += `\n## ${x.nameAr}\n\n- **المعرّف:** \`${x.id}\` · **المزود:** ${x.provider}\n- **التصنيف:** ${CLASSIFICATION_AR[x.classification]}${x.envKey ? ` · متغير البيئة: \`${x.envKey}\`` : ''}\n- **المتغيرات:** ${x.variablesAr.join('، ')}\n- **التغطية:** ${x.coverageAr}\n- **دورية التحديث:** ${x.updateFrequencyAr} · **التأخر الزمني:** ${x.latencyAr}\n- **طريقة الوصول:** ${x.accessAr}\n- **التكلفة:** ${x.costAr}\n- **شروط العرض والتخزين والاشتقاق:** ${x.termsAr}\n- **أقصى عمر قبل التقادم:** ${Number.isFinite(x.maxAgeS) ? Math.round(x.maxAgeS / 60) + ' دقيقة' : 'غير منطبق'}\n- **حالة اختبار الاتصال:** ${esc(probeLine(x.id))}\n- **المراجع (تاريخ التحقق ${x.verifiedAt}):**\n${x.docs.map((d) => `  - [${d.titleAr}](${d.url})`).join('\n') || '  - لم نجد وثيقة عامة'}\n`;
}
writeFileSync('docs/SOURCES.md', s);

let i = `# قاموس المؤشرات\n\n> مولَّد آليًا من \`packages/core/src/indicators/dictionary.ts\`، والمعادلات منفذة في \`packages/core/src/indicators/\` ومغطاة باختبارات الوحدة.\n\n`;
i += `أي مؤشر غير مدعوم ببيانات يظهر في الواجهة «غير متاح» مع السبب، ولا يظهر صفرًا.\n\n`;
for (const g of [...new Set(INDICATORS.map((x) => x.group))]) {
  i += `\n## ${g}\n\n| # | المؤشر | التعريف | المعادلة | الوحدة | المصدر | التواتر | المستوى | حدود الاستخدام | الحالة |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const x of INDICATORS.filter((y) => y.group === g))
    i += `| ${x.n} | ${esc(x.nameAr)} | ${esc(x.definitionAr)} | \`${esc(x.formula)}\` | ${x.unit} | ${x.sourceIds.join(', ') || '—'} | ${esc(x.frequencyAr)} | ${x.levels.join(', ')} | ${esc(x.limitsAr)} | ${{ computed: 'محسوب', needs_data: 'يحتاج بيانات', needs_history: 'يحتاج سجلًا' }[x.impl]} |\n`;
}
for (const sc of [SRI_SCALE, DENSITY_SCALE]) {
  i += `\n## التدرج اللوني: ${sc.titleAr} (${sc.unitAr})\n\n${sc.noteAr}\n\n| المدى | الحالة | اللون | الرمز المساند |\n|---|---|---|---|\n`;
  for (const c of sc.classes) i += `| ${c.min} إلى أقل من ${Number.isFinite(c.max) ? c.max : '∞'} | ${c.labelAr} | \`${c.color}\` | ${c.glyph} |\n`;
  i += `| — | ${sc.unknown.labelAr} | \`${sc.unknown.color}\` (خط متقطع) | ${sc.unknown.glyph} |\n`;
}
i += `\n### مواءمة ألوان طبقة TomTom النقطية (relative0)\n\nتُعرض طبقة مستقلة بمفتاح المزود، ولا تُدمج مع ألوان المنصة. وفق [وثيقة Raster Flow Tiles](https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/traffic-flow/raster-flow-tiles) تعتمد الفئات على نسبة السرعة إلى التدفق الحر r: سلس r ≥ 0.75 (≈ مؤشر ≤ 25)، ومتوسط من 0.35 إلى أقل من 0.75 (≈ 25–65)، وبطيء من 0.15 إلى أقل من 0.35 (≈ 65–85)، وبطيء جدًا r < 0.15 (≈ > 85)، وفئة مستقلة للطريق المغلق. والحدود تختلف عن حدود المنصة التصميمية (20/40/60/80)، لذلك لا تُخلطان.\n`;
writeFileSync('docs/INDICATORS.md', i);

let a = `# قواعد التنبيهات والتوصيات\n\n> مولَّد آليًا من \`packages/core/src/alerts/rules.ts\`. العتبات قابلة للضبط من الواجهة (تبويب التنبيهات، برمز الإدارة) أو من \`PUT /api/rules\`.\n\n`;
a += `## منع التكرار والتذبذب\n\n1. **مفتاح منع التكرار:** القاعدة + الموقع (مقطع/اتجاه، أو حدث، أو مصدر). والشرط القائم يحدّث التنبيه المفتوح ولا يُنشئ تنبيهًا جديدًا.\n2. **مدة الاستمرار:** لا يُطلق التنبيه حتى يستمر الشرط المدة المحددة.\n3. **عتبتا دخول وخروج (تخلف):** القيمة بين العتبتين تُبقي التنبيه المفتوح والعدّ المعلّق، ولا تبدأ تنبيهًا.\n4. **الإغلاق التلقائي:** بعد غياب الشرط مدة محددة، ويُسجَّل ذلك في سجل التنبيه.\n5. **التهدئة:** لا يُعاد إطلاق تنبيه بنفس المفتاح قبل مرور 15 دقيقة على إغلاقه.\n\nلكل تنبيه: السبب، والموقع، والوقت، والشدة، والمصدر، والثقة، والإجراء المقترح، وحالة المعالجة (مفتوح/قيد المعالجة/مغلق)، وسجل الإجراءات ونتيجتها. والقرارات التشغيلية (الإغلاق، وتعديل الإشارات، والتوجيه) للجهة المخولة.\n\n`;
for (const r of RULES) {
  a += `## ${r.titleAr} (\`${r.id}\`)\n\n${r.descriptionAr}\n\n- **يتطلب:** ${r.requiresAr}\n- **مدة الاستمرار الافتراضية:** ${r.defaultPersistenceS / 60} د · **الإغلاق بعد غياب:** ${r.defaultClearAfterS / 60} د\n${r.params.map((p) => `- **${p.labelAr}:** ${p.default} ${p.unit}`).join('\n')}\n\n`;
}
writeFileSync('docs/ALERTS.md', a);
console.log('docs generated');
