import type { FlowObservation, RoadSegment, SpeedObservation } from '../domain/types.ts';
import { isNum, na, ok, type IndicatorValue } from './value.ts';

/** (3) مؤشر انخفاض السرعة = 100 × [1 − (الحالية ÷ التدفق الحر)]، محصور بين 0 و100. */
export function speedReductionIndex(currentKmh: number | null, freeFlowKmh: number | null): IndicatorValue {
  if (!isNum(freeFlowKmh) || freeFlowKmh <= 0) return na('invalid_reference');
  if (!isNum(currentKmh) || currentKmh < 0) return na('no_data');
  const raw = 100 * (1 - currentKmh / freeFlowKmh);
  return ok(Math.min(100, Math.max(0, raw)), '');
}

/** (4) مؤشر زمن الرحلة = الحالي ÷ التدفق الحر. */
export function travelTimeIndex(currentS: number | null, freeFlowS: number | null): IndicatorValue {
  if (!isNum(freeFlowS) || freeFlowS <= 0) return na('invalid_reference');
  if (!isNum(currentS) || currentS <= 0) return na('no_data');
  return ok(currentS / freeFlowS, '×');
}

/** (5) التأخير = زمن الرحلة الحالي − الزمن المرجعي (ثوانٍ). قد يكون سالبًا قليلًا؛ يُحصر عند 0. */
export function delaySeconds(currentS: number | null, referenceS: number | null): IndicatorValue {
  if (!isNum(referenceS) || referenceS <= 0) return na('invalid_reference');
  if (!isNum(currentS) || currentS <= 0) return na('no_data');
  return ok(Math.max(0, currentS - referenceS), 'ث');
}

export interface FreshnessPolicy {
  /** أقصى عمر مقبول للقراءة قبل اعتبارها متقادمة، بالثواني */
  maxAgeS: number;
}

export function ageSeconds(observedAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(observedAt).getTime()) / 1000);
}

export function isStale(observedAt: string, now: Date, policy: FreshnessPolicy): boolean {
  return ageSeconds(observedAt, now) > policy.maxAgeS;
}

/** مؤشرات مقطع/اتجاه واحد من قراءة سرعة، مع احترام التقادم. */
export function segmentSpeedIndicators(obs: SpeedObservation | undefined, now: Date, policy: FreshnessPolicy) {
  if (!obs) {
    const x = na('no_data');
    return { sri: x, tti: x, delay: x, speed: x, freeFlow: x, stale: false, ageS: null as number | null };
  }
  const ageS = ageSeconds(obs.observedAt, now);
  if (ageS > policy.maxAgeS) {
    const x = na('stale');
    return { sri: x, tti: x, delay: x, speed: x, freeFlow: x, stale: true, ageS };
  }
  return {
    sri: speedReductionIndex(obs.currentSpeedKmh, obs.freeFlowSpeedKmh),
    tti: travelTimeIndex(obs.currentTravelTimeS, obs.freeFlowTravelTimeS),
    delay: delaySeconds(obs.currentTravelTimeS, obs.freeFlowTravelTimeS),
    speed: isNum(obs.currentSpeedKmh) ? ok(obs.currentSpeedKmh, 'كم/س') : na('no_data'),
    freeFlow: isNum(obs.freeFlowSpeedKmh) && obs.freeFlowSpeedKmh > 0 ? ok(obs.freeFlowSpeedKmh, 'كم/س') : na('invalid_reference'),
    stale: false,
    ageS,
  };
}

export interface SegmentState {
  segment: RoadSegment;
  obs: SpeedObservation | undefined;
}

/**
 * (6) نسبة أطوال الطرق المزدحمة = طول المقاطع المتجاوزة للعتبة ÷ طول المقاطع ذات البيانات الصالحة × 100.
 * المقام يستبعد المقاطع بلا بيانات صالحة؛ ونعيد التغطية معه حتى لا تُفهم النسبة على أنها للشبكة كلها.
 */
export function congestedLengthShare(
  states: SegmentState[],
  thresholdSri: number,
  now: Date,
  policy: FreshnessPolicy,
): { share: IndicatorValue; validLengthM: number; totalLengthM: number; coverage: IndicatorValue } {
  let valid = 0;
  let congested = 0;
  let total = 0;
  for (const s of states) {
    total += s.segment.lengthM;
    const ind = segmentSpeedIndicators(s.obs, now, policy);
    if (!ind.sri.available) continue;
    valid += s.segment.lengthM;
    if (ind.sri.value >= thresholdSri) congested += s.segment.lengthM;
  }
  const coverage = total > 0 ? ok((valid / total) * 100, '%') : na('no_data');
  if (valid <= 0) return { share: na('insufficient_coverage'), validLengthM: 0, totalLengthM: total, coverage };
  return { share: ok((congested / valid) * 100, '%'), validLengthM: valid, totalLengthM: total, coverage };
}

/**
 * سرعة المتوسط المكاني لمجموعة مقاطع = مجموع الأطوال ÷ مجموع أزمنة الرحلة.
 * هذا هو الترجيح الصحيح بدل المتوسط الحسابي للسرعات.
 */
export function spaceMeanSpeed(states: SegmentState[], now: Date, policy: FreshnessPolicy): IndicatorValue {
  let len = 0;
  let time = 0;
  for (const s of states) {
    const o = s.obs;
    if (!o || isStale(o.observedAt, now, policy)) continue;
    if (!isNum(o.currentSpeedKmh) || o.currentSpeedKmh <= 0) continue;
    len += s.segment.lengthM;
    time += s.segment.lengthM / (o.currentSpeedKmh / 3.6);
  }
  if (len === 0) return na('no_data');
  return ok((len / time) * 3.6, 'كم/س');
}

/** مؤشر زمن رحلة مجمّع = Σ أزمنة الرحلة الحالية ÷ Σ أزمنة التدفق الحر (مرجّح ضمنيًا بالطول). */
export function aggregateTravelTimeIndex(states: SegmentState[], now: Date, policy: FreshnessPolicy): IndicatorValue {
  let cur = 0;
  let ff = 0;
  for (const s of states) {
    const o = s.obs;
    if (!o || isStale(o.observedAt, now, policy)) continue;
    if (!isNum(o.currentSpeedKmh) || !isNum(o.freeFlowSpeedKmh) || o.currentSpeedKmh <= 0 || o.freeFlowSpeedKmh <= 0) continue;
    cur += s.segment.lengthM / o.currentSpeedKmh;
    ff += s.segment.lengthM / o.freeFlowSpeedKmh;
  }
  if (ff === 0) return na('no_data');
  return ok(cur / ff, '×');
}

/** التأخير لكل كم = Σ(التأخير) ÷ Σ(الطول بالكم) للمقاطع الصالحة (ث/كم). */
export function delayPerKm(states: SegmentState[], now: Date, policy: FreshnessPolicy): IndicatorValue {
  let delay = 0;
  let km = 0;
  for (const s of states) {
    const o = s.obs;
    if (!o || isStale(o.observedAt, now, policy)) continue;
    if (!isNum(o.currentSpeedKmh) || !isNum(o.freeFlowSpeedKmh) || o.currentSpeedKmh <= 0 || o.freeFlowSpeedKmh <= 0) continue;
    const curS = (s.segment.lengthM / 1000 / o.currentSpeedKmh) * 3600;
    const ffS = (s.segment.lengthM / 1000 / o.freeFlowSpeedKmh) * 3600;
    delay += Math.max(0, curS - ffS);
    km += s.segment.lengthM / 1000;
  }
  if (km === 0) return na('no_data');
  return ok(delay / km, 'ث/كم');
}

/**
 * (7) مدة استمرار الازدحام: من سلسلة زمنية مرتبة تصاعديًا لقراءات اتجاه واحد،
 * المدة منذ أول قراءة متصلة تجاوزت العتبة حتى آخر قراءة. فجوة أكبر من maxGapS تقطع السلسلة.
 */
export function congestionDurationS(
  series: Pick<SpeedObservation, 'observedAt' | 'currentSpeedKmh' | 'freeFlowSpeedKmh'>[],
  thresholdSri: number,
  maxGapS: number,
): IndicatorValue {
  if (series.length === 0) return na('no_data');
  let start: number | null = null;
  let prevT: number | null = null;
  for (const o of series) {
    const t = new Date(o.observedAt).getTime();
    const sri = speedReductionIndex(o.currentSpeedKmh, o.freeFlowSpeedKmh);
    const gapBroken = prevT !== null && (t - prevT) / 1000 > maxGapS;
    if (!sri.available || sri.value < thresholdSri || gapBroken) {
      start = sri.available && sri.value >= thresholdSri ? t : null;
    } else if (start === null) {
      start = t;
    }
    prevT = t;
  }
  if (start === null || prevT === null) return ok(0, 'ث');
  return ok((prevT - start) / 1000, 'ث');
}

/** (8) موثوقية زمن الرحلة: مؤشر العازل = (المئين95 − المتوسط) ÷ المتوسط. يتطلب سجلًا كافيًا. */
export function bufferIndex(travelTimesS: number[], minSamples = 20): IndicatorValue {
  const xs = travelTimesS.filter((x) => isNum(x) && x > 0).sort((a, b) => a - b);
  if (xs.length < minSamples) return na('insufficient_history', `${xs.length} من ${minSamples} عينة`);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const p95 = percentile(xs, 95);
  return ok(((p95 - mean) / mean) * 100, '%');
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (rank - lo);
}

// ───────── (9–14) التدفق والكثافة والانتظار: من قياسات فعلية فقط ─────────

export function flowIndicators(f: FlowObservation | undefined, speed: SpeedObservation | undefined, lanes: number | undefined) {
  const notMeasured = na('not_measured', 'يتطلب عدادات أو حساسات من الجهة المختصة');
  if (!f) {
    return {
      volume: notMeasured,
      density: notMeasured,
      occupancy: notMeasured,
      meanWait: notMeasured,
      p95Wait: notMeasured,
      queue: notMeasured,
      stops: notMeasured,
    };
  }
  return {
    volume: isNum(f.volumeVehPerHour) ? ok(f.volumeVehPerHour, 'مركبة/س') : notMeasured,
    density: densityIndicator(f, speed, lanes),
    occupancy: isNum(f.occupancyPct) ? ok(f.occupancyPct, '%') : notMeasured,
    meanWait: isNum(f.meanWaitS) ? ok(f.meanWaitS, 'ث') : notMeasured,
    p95Wait: isNum(f.p95WaitS) ? ok(f.p95WaitS, 'ث') : notMeasured,
    queue: isNum(f.queueLengthM) ? ok(f.queueLengthM, 'م') : isNum(f.queueVehicles) ? ok(f.queueVehicles, 'مركبة') : notMeasured,
    stops: isNum(f.stopsPerVehicle) ? ok(f.stopsPerVehicle, 'توقف/مركبة') : notMeasured,
  };
}

/**
 * (10) الكثافة (مركبة/كم/حارة). مقاسة إن وُجدت، وإلا تُقدَّر k = q ÷ (v × حارات)
 * بشرط تزامن قياس التدفق والسرعة (فارق ≤ 5 دقائق) ومعرفة عدد الحارات، وتوسم «تقدير».
 */
export function densityIndicator(f: FlowObservation, speed: SpeedObservation | undefined, lanes: number | undefined): IndicatorValue {
  if (isNum(f.densityVehPerKmPerLane)) return ok(f.densityVehPerKmPerLane, 'مركبة/كم/حارة');
  if (!isNum(f.volumeVehPerHour)) return na('not_measured');
  if (!speed || !isNum(speed.currentSpeedKmh) || speed.currentSpeedKmh < 5) {
    return na('no_data', 'لا تتوفر سرعة صالحة متزامنة (العلاقة غير مستقرة تحت 5 كم/س)');
  }
  if (!lanes || lanes <= 0) return na('no_data', 'عدد الحارات غير معروف');
  const dt = Math.abs(new Date(f.observedAt).getTime() - new Date(speed.observedAt).getTime()) / 1000;
  if (dt > 300) return na('no_data', 'قياس التدفق والسرعة غير متزامنين');
  return ok(f.volumeVehPerHour / speed.currentSpeedKmh / lanes, 'مركبة/كم/حارة', {
    estimated: true,
    note: 'تقدير من علاقة التدفق = الكثافة × السرعة',
  });
}
