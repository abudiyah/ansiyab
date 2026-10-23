import type { Confidence, District, RoadSegment, SegmentDirectionKey, SpeedObservation, TrafficEvent, WeatherObservation, WeatherWarning } from '../domain/types.ts';
import { segmentKey } from '../domain/types.ts';
import {
  aggregateTravelTimeIndex,
  congestedLengthShare,
  delayPerKm,
  isStale,
  segmentSpeedIndicators,
  spaceMeanSpeed,
  type FreshnessPolicy,
  type SegmentState,
} from './traffic.ts';
import { isNum, na, ok, type IndicatorValue } from './value.ts';

export const CONGESTION_THRESHOLD_SRI = 60;

export function statesFor(segments: RoadSegment[], obs: Map<SegmentDirectionKey, SpeedObservation>): SegmentState[] {
  const out: SegmentState[] = [];
  for (const s of segments) for (const d of s.directions) out.push({ segment: s, obs: obs.get(segmentKey(s.id, d)) });
  return out;
}

/** متوسط مؤشر انخفاض السرعة مرجّحًا بطول المقطع/الاتجاه */
export function lengthWeightedSri(states: SegmentState[], now: Date, policy: FreshnessPolicy): IndicatorValue {
  let w = 0;
  let sum = 0;
  for (const s of states) {
    const i = segmentSpeedIndicators(s.obs, now, policy);
    if (!i.sri.available) continue;
    w += s.segment.lengthM;
    sum += s.segment.lengthM * i.sri.value;
  }
  return w > 0 ? ok(sum / w, '') : na('no_data');
}

export interface DistrictSummary {
  districtId: string;
  nameAr: string;
  boundaryQuality: District['boundaryQuality'];
  roadLengthKm: number;
  segmentDirections: number;
  coverage: IndicatorValue;
  meanSri: IndicatorValue;
  congestedShare: IndicatorValue;
  travelTimeIndex: IndicatorValue;
  delayPerKm: IndicatorValue;
  spaceMeanSpeed: IndicatorValue;
  /** فرق متوسط المؤشر عن خط أساس نفس اليوم والساعة */
  vsBaseline: IndicatorValue;
  activeEvents: Record<string, number>;
  closures: number;
  eventsPer100LaneKm: IndicatorValue;
  weather: WeatherObservation | null;
  warnings: WeatherWarning[];
  confidence: Confidence;
  confidenceReasonsAr: string[];
  comparable: boolean;
  freshestObsAgeS: number | null;
}

export function summarizeDistrict(args: {
  district: District;
  segments: RoadSegment[];
  obs: Map<SegmentDirectionKey, SpeedObservation>;
  events: TrafficEvent[];
  weather: WeatherObservation | null;
  warnings: WeatherWarning[];
  now: Date;
  policy: FreshnessPolicy;
  baselineSri?: number | null;
}): DistrictSummary {
  const { district, now, policy } = args;
  const segs = args.segments.filter((s) => s.districtIds.includes(district.id));
  const states = statesFor(segs, args.obs);
  const share = congestedLengthShare(states, CONGESTION_THRESHOLD_SRI, now, policy);
  const meanSri = lengthWeightedSri(states, now, policy);
  const events = args.events.filter((e) => e.districtIds.includes(district.id) && (!e.endTime || new Date(e.endTime) > now));
  const activeEvents: Record<string, number> = {};
  for (const e of events) activeEvents[e.type] = (activeEvents[e.type] ?? 0) + 1;

  const laneKm = segs.reduce((a, s) => a + (s.lengthM / 1000) * (s.lanes ?? (s.directions.length === 2 ? 2 : 1)), 0);
  const trafficConnected = states.some((s) => s.obs);
  const eventsPer100LaneKm = !trafficConnected
    ? na('source_not_connected', 'لا يوجد مصدر حوادث متصل')
    : laneKm > 0
      ? ok((events.length / laneKm) * 100, 'حدث/100 حارة·كم', { note: 'الحارات من OSM وقد تكون ناقصة' })
      : na('no_data');

  // الثقة: التغطية + ثقة المزود + الحداثة
  const reasons: string[] = [];
  const cov = share.coverage.available ? share.coverage.value : 0;
  const fresh = states.map((s) => s.obs).filter((o): o is SpeedObservation => !!o && !isStale(o.observedAt, now, policy));
  const meanConf = fresh.length ? fresh.reduce((a, o) => a + (o.confidence ?? 0), 0) / fresh.length : 0;
  if (cov < 40) reasons.push(`تغطية الطرق ${cov.toFixed(0)}% فقط`);
  if (fresh.length && meanConf < 0.7) reasons.push(`متوسط ثقة المزود ${meanConf.toFixed(2)}`);
  if (district.boundaryQuality === 'point_only') reasons.push('لا توجد حدود مضلعة للحي في OSM');
  if (!fresh.length) reasons.push('لا توجد قراءات سرعة حديثة');
  const confidence: Confidence = !fresh.length || cov < 40 || district.boundaryQuality === 'point_only' ? 'low' : cov >= 70 && meanConf >= 0.8 ? 'high' : 'medium';

  const ages = states.map((s) => s.obs).filter((o): o is SpeedObservation => !!o).map((o) => (now.getTime() - new Date(o.observedAt).getTime()) / 1000);
  const vsBaseline =
    meanSri.available && isNum(args.baselineSri)
      ? ok(meanSri.value - args.baselineSri, 'نقطة')
      : na('insufficient_history', 'يتطلب قراءات أسبوعين سابقين على الأقل لنفس اليوم والساعة');

  return {
    districtId: district.id,
    nameAr: district.nameAr,
    boundaryQuality: district.boundaryQuality,
    roadLengthKm: segs.reduce((a, s) => a + s.lengthM, 0) / 1000,
    segmentDirections: states.length,
    coverage: share.coverage,
    meanSri,
    congestedShare: share.share,
    travelTimeIndex: aggregateTravelTimeIndex(states, now, policy),
    delayPerKm: delayPerKm(states, now, policy),
    spaceMeanSpeed: spaceMeanSpeed(states, now, policy),
    vsBaseline,
    activeEvents,
    closures: events.filter((e) => e.isClosure).length,
    eventsPer100LaneKm,
    weather: args.weather,
    warnings: args.warnings,
    confidence,
    confidenceReasonsAr: reasons,
    comparable: cov >= 40 && district.boundaryQuality === 'polygon',
    freshestObsAgeS: ages.length ? Math.min(...ages) : null,
  };
}

/**
 * ترتيب الأحياء بمؤشرات معيارية (نسبة الطول المزدحم، مؤشر زمن الرحلة، التأخير/كم)،
 * مع استبعاد غير القابل للمقارنة إلى ذيل القائمة بدل ترتيبه بأرقام خام.
 */
export function rankDistricts(rows: DistrictSummary[], by: 'congestedShare' | 'travelTimeIndex' | 'delayPerKm'): DistrictSummary[] {
  const val = (r: DistrictSummary) => (r[by].available ? (r[by] as { value: number }).value : -Infinity);
  return [...rows].sort((a, b) => {
    if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
    return val(b) - val(a);
  });
}
