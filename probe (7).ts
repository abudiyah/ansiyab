/**
 * فحص الاتصال الفعلي بكل مصدر ومطابقة حقوله. يكتب:
 *   data/runtime/source-status.json  (تقرأه المنصة لرفع التصنيف إلى «متصل ومختبر»)
 *   data/runtime/probe/<source>.json  (عينة الاستجابة الحقيقية، بعد إخفاء المفاتيح)
 * الاستخدام: npm run probe
 */
import { config } from '../apps/server/src/config.ts';
import { runProbe } from '../apps/server/src/probe.ts';
import { Store } from '../apps/server/src/store.ts';

const store = new Store(config.dataDir);
store.load(config.regionId);
const results = await runProbe(config.dataDir);
store.saveProbe(results);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.sourceId.padEnd(18)} ${r.detail}`);
console.log(`\nحُفظت النتائج في ${config.dataDir}/source-status.json`);
process.exit(results.some((r) => r.ok) ? 0 : 1);
