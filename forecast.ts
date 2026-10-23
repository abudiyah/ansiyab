/**
 * التنبؤ قصير المدى لمؤشر انخفاض السرعة لكل مقطع/اتجاه.
 * لا يُفعَّل إلا بعد سجل كافٍ، ويُقيَّم باختبار زمني (تدريب على الماضي فقط) مقابل خط أساس بسيط.
 */
export interface SeriesPoint {
  t: number; // epoch ms
  v: number; // SRI
}

export const HORIZONS_MIN = [15, 30, 60] as const;
export const MIN_HISTORY_DAYS = 28;

export interface Readiness {
  ready: boolean;
  historyDays: number;
  requiredDays: number;
  reasonAr?: string;
}

export function forecastReadiness(series: SeriesPoint[], requiredDays = MIN_HISTORY_DAYS): Readiness {
  if (series.length < 2) return { ready: false, historyDays: 0, requiredDays, reasonAr: 'لا يوجد سجل' };
  const days = (series[series.length - 1]!.t - series[0]!.t) / 86400e3;
  return days >= requiredDays
    ? { ready: true, historyDays: days, requiredDays }
    : { ready: false, historyDays: days, requiredDays, reasonAr: `السجل ${days.toFixed(1)} يوم من ${requiredDays} مطلوبة` };
}

/** قيمة السلسلة عند وقت t (آخر قيمة معروفة ضمن tolerance) */
function valueAt(series: SeriesPoint[], t: number, tolMs: number): number | null {
  let lo = 0, hi = series.length - 1, best: SeriesPoint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.t <= t) { best = series[mid]!; lo = mid + 1; } else hi = mid - 1;
  }
  return best && t - best.t <= tolMs ? best.v : null;
}

/** خط أساس 1: الاستمرار (القيمة الحالية) */
export const persistence = (series: SeriesPoint[], t0: number, _h: number) => valueAt(series, t0, 20 * 60e3);

/**
 * نموذج 2: المتوسط التاريخي لنفس يوم الأسبوع ونفس ربع الساعة، باستخدام بيانات قبل t0 فقط
 * (منع تسرب المستقبل)، ممزوجًا بانحراف اللحظة الحالية عن المتوسط مع تخامد حسب الأفق.
 */
export function seasonalBlend(series: SeriesPoint[], t0: number, horizonMin: number, weeks = 4): number | null {
  const target = t0 + horizonMin * 60e3;
  const hist: number[] = [];
  const histNow: number[] = [];
  for (let w = 1; w <= weeks; w++) {
    const a = valueAt(series, target - w * 7 * 86400e3, 15 * 60e3);
    const b = valueAt(series, t0 - w * 7 * 86400e3, 15 * 60e3);
    if (a !== null && target - w * 7 * 86400e3 < t0) hist.push(a);
    if (b !== null) histNow.push(b);
  }
  if (!hist.length) return null;
  const meanTarget = hist.reduce((x, y) => x + y, 0) / hist.length;
  const cur = valueAt(series, t0, 20 * 60e3);
  if (cur === null || !histNow.length) return meanTarget;
  const meanNow = histNow.reduce((x, y) => x + y, 0) / histNow.length;
  const decay = Math.exp(-horizonMin / 45);
  return Math.min(100, Math.max(0, meanTarget + (cur - meanNow) * decay));
}

export interface BacktestResult {
  horizonMin: number;
  n: number;
  maeModel: number | null;
  maeBaseline: number | null;
  /** نطاق عدم اليقين: المئين 10 و90 للخطأ (فعلي − متوقع) */
  errP10: number | null;
  errP90: number | null;
  skill: number | null; // 1 − MAE_model/MAE_baseline
}

/** اختبار زمني متدحرج: كل تنبؤ عند t0 يستخدم بيانات ≤ t0 فقط، ويُقارن بالقيمة الفعلية عند t0+h. */
export function backtest(series: SeriesPoint[], testStart: number, stepMin = 15): BacktestResult[] {
  const end = series[series.length - 1]?.t ?? 0;
  return HORIZONS_MIN.map((h) => {
    const errsM: number[] = [], errsB: number[] = [], signed: number[] = [];
    for (let t0 = testStart; t0 + h * 60e3 <= end; t0 += stepMin * 60e3) {
      const past = series.filter((p) => p.t <= t0);
      const actual = valueAt(series, t0 + h * 60e3, 10 * 60e3);
      if (actual === null) continue;
      const m = seasonalBlend(past, t0, h);
      const b = persistence(past, t0, h);
      if (m === null || b === null) continue;
      errsM.push(Math.abs(actual - m));
      errsB.push(Math.abs(actual - b));
      signed.push(actual - m);
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const sorted = [...signed].sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.floor((p / 100) * (sorted.length - 1))]! : null);
    const mm = mean(errsM), mb = mean(errsB);
    return { horizonMin: h, n: errsM.length, maeModel: mm, maeBaseline: mb, errP10: q(10), errP90: q(90), skill: mm !== null && mb ? 1 - mm / mb : null };
  });
}
