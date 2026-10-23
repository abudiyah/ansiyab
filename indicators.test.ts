import { describe, expect, it } from 'vitest';
import {
  speedReductionIndex, travelTimeIndex, delaySeconds, congestedLengthShare, spaceMeanSpeed, segmentSpeedIndicators,
  congestionDurationS, bufferIndex, densityIndicator, flowIndicators, classify, SRI_SCALE, DENSITY_SCALE, aggregateTravelTimeIndex,
  type RoadSegment, type SpeedObservation, type FlowObservation, formatIndicator, na, lengthWeightedSri, statesFor, segmentKey,
} from '../src/index.ts';

const now = new Date('2026-10-23T18:00:00Z');
const policy = { maxAgeS: 900 };
const seg = (id: string, lengthM: number, dirs: ('fwd' | 'bwd')[] = ['fwd']): RoadSegment => ({
  id, regionId: 'riyadh', roadClass: 'primary', directions: dirs, geometry: { type: 'LineString', coordinates: [[46.6, 24.7], [46.61, 24.7]] },
  lengthM, districtIds: ['d1'], isDistrictGateway: false, sourceId: 't', sourceRef: 't',
});
const obs = (key: string, v: number | null, ff: number | null, at = '2026-10-23T17:55:00Z', conf = 0.9): SpeedObservation => ({
  segmentKey: key as SpeedObservation['segmentKey'], sourceId: 'tomtom-flow', observedAt: at, receivedAt: at, provenance: 'live',
  currentSpeedKmh: v, freeFlowSpeedKmh: ff, currentTravelTimeS: v ? 3600 / v : null, freeFlowTravelTimeS: ff ? 3600 / ff : null, confidence: conf, roadClosure: false,
});

describe('مؤشر انخفاض السرعة', () => {
  it('يحسب المعادلة ويحصرها بين 0 و100', () => {
    expect(speedReductionIndex(30, 60)).toMatchObject({ available: true, value: 50 });
    expect(speedReductionIndex(80, 60)).toMatchObject({ available: true, value: 0 });
    expect(speedReductionIndex(0, 60)).toMatchObject({ available: true, value: 100 });
  });
  it('غير متاح عند مرجع صفري أو مفقود، ولا يعيد صفرًا', () => {
    expect(speedReductionIndex(30, 0)).toEqual({ available: false, reason: 'invalid_reference' });
    expect(speedReductionIndex(30, null)).toEqual({ available: false, reason: 'invalid_reference' });
    expect(speedReductionIndex(null, 60)).toEqual({ available: false, reason: 'no_data' });
    expect(speedReductionIndex(Number.NaN, 60).available).toBe(false);
  });
});

describe('زمن الرحلة والتأخير', () => {
  it('TTI والتأخير', () => {
    expect(travelTimeIndex(120, 60)).toMatchObject({ value: 2, unit: '×' });
    expect(delaySeconds(120, 60)).toMatchObject({ value: 60 });
    expect(delaySeconds(50, 60)).toMatchObject({ value: 0 });
    expect(travelTimeIndex(120, 0).available).toBe(false);
  });
});

describe('التقادم', () => {
  it('القراءة الأقدم من الحد تعطي «متقادمة» لكل المؤشرات', () => {
    const r = segmentSpeedIndicators(obs('a:fwd', 30, 60, '2026-10-23T17:00:00Z'), now, policy);
    expect(r.stale).toBe(true);
    expect(r.sri).toEqual({ available: false, reason: 'stale' });
  });
  it('غياب القراءة يعطي «لا توجد قراءة» وليس صفرًا', () => {
    expect(segmentSpeedIndicators(undefined, now, policy).sri).toEqual({ available: false, reason: 'no_data' });
    expect(formatIndicator(na('no_data'))).toContain('غير متاح');
  });
});

describe('نسبة الأطوال المزدحمة والتجميع', () => {
  const a = seg('a', 1000), b = seg('b', 3000), c = seg('c', 1000);
  const states = [
    { segment: a, obs: obs('a:fwd', 10, 60) },  // SRI 83 → مزدحم
    { segment: b, obs: obs('b:fwd', 50, 60) },  // SRI 17
    { segment: c, obs: undefined },              // بلا بيانات
  ];
  it('المقام = أطوال المقاطع الصالحة فقط، مع التغطية', () => {
    const r = congestedLengthShare(states, 60, now, policy);
    expect(r.share).toMatchObject({ value: 25 });
    expect(r.coverage).toMatchObject({ value: 80 });
  });
  it('سرعة المتوسط المكاني مرجّحة بالزمن وليست متوسطًا حسابيًا', () => {
    const r = spaceMeanSpeed(states, now, policy);
    // 4 كم ÷ (1/10 + 3/50) ساعة = 25 كم/س، والمتوسط الحسابي (30) خاطئ
    expect(r.available && r.value).toBeCloseTo(25, 5);
  });
  it('TTI المجمّع', () => {
    const r = aggregateTravelTimeIndex(states, now, policy);
    expect(r.available && r.value).toBeCloseTo((1 / 10 + 3 / 50) / (4 / 60), 5);
  });
  it('متوسط SRI مرجّح بالطول ويستبعد المفقود', () => {
    const r = lengthWeightedSri(states, now, policy);
    const expected = (1000 * (100 * (1 - 10 / 60)) + 3000 * (100 * (1 - 50 / 60))) / 4000;
    expect(r.available && r.value).toBeCloseTo(expected, 5);
  });
  it('بلا أي بيانات صالحة: النسبة غير متاحة', () => {
    expect(congestedLengthShare([{ segment: c, obs: undefined }], 60, now, policy).share.available).toBe(false);
  });
  it('statesFor ينشئ حالة لكل اتجاه مسموح (وحدة التحليل = مقطع + اتجاه)', () => {
    const two = seg('t', 500, ['fwd', 'bwd']);
    const m = new Map([[segmentKey('t', 'bwd'), obs('t:bwd', 20, 60)]]);
    const st = statesFor([two], m);
    expect(st).toHaveLength(2);
    expect(st.find((s) => s.obs)?.obs?.segmentKey).toBe('t:bwd');
  });
});

describe('مدة الازدحام والموثوقية', () => {
  it('تحسب المدة المتصلة وتقطعها الفجوات', () => {
    const s = [
      { observedAt: '2026-10-23T17:00:00Z', currentSpeedKmh: 50, freeFlowSpeedKmh: 60 },
      { observedAt: '2026-10-23T17:15:00Z', currentSpeedKmh: 15, freeFlowSpeedKmh: 60 },
      { observedAt: '2026-10-23T17:30:00Z', currentSpeedKmh: 15, freeFlowSpeedKmh: 60 },
      { observedAt: '2026-10-23T17:45:00Z', currentSpeedKmh: 10, freeFlowSpeedKmh: 60 },
    ];
    expect(congestionDurationS(s, 60, 1800)).toMatchObject({ value: 1800 });
    const gap = [...s.slice(0, 2), { observedAt: '2026-10-23T19:00:00Z', currentSpeedKmh: 10, freeFlowSpeedKmh: 60 }];
    expect(congestionDurationS(gap, 60, 1800)).toMatchObject({ value: 0 });
  });
  it('مؤشر العازل يرفض العينات القليلة', () => {
    expect(bufferIndex([100, 110, 120]).available).toBe(false);
    const xs = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(bufferIndex(xs).available).toBe(true);
  });
});

describe('الكثافة والتدفق', () => {
  const f = (o: Partial<FlowObservation>): FlowObservation => ({
    segmentKey: 'a:fwd', sourceId: 'counter', observedAt: '2026-10-23T17:58:00Z', receivedAt: '2026-10-23T17:58:00Z', provenance: 'live',
    volumeVehPerHour: null, occupancyPct: null, densityVehPerKmPerLane: null, densityMethod: null, meanWaitS: null, p95WaitS: null,
    queueLengthM: null, queueVehicles: null, stopsPerVehicle: null, ...o,
  });
  it('تقدير الكثافة k=q/(v·n) يوسم تقديرًا', () => {
    const r = densityIndicator(f({ volumeVehPerHour: 3600 }), obs('a:fwd', 60, 80, '2026-10-23T17:57:00Z'), 3);
    expect(r).toMatchObject({ available: true, value: 20, estimated: true });
  });
  it('يرفض التقدير عند عدم التزامن أو السرعة شبه الصفرية أو جهل الحارات', () => {
    expect(densityIndicator(f({ volumeVehPerHour: 3600 }), obs('a:fwd', 60, 80, '2026-10-23T17:40:00Z'), 3).available).toBe(false);
    expect(densityIndicator(f({ volumeVehPerHour: 3600 }), obs('a:fwd', 3, 80, '2026-10-23T17:57:00Z'), 3).available).toBe(false);
    expect(densityIndicator(f({ volumeVehPerHour: 3600 }), obs('a:fwd', 60, 80, '2026-10-23T17:57:00Z'), undefined).available).toBe(false);
  });
  it('بلا عدادات: كل مؤشرات التدفق «غير مقاس»', () => {
    const r = flowIndicators(undefined, obs('a:fwd', 30, 60), 2);
    expect(Object.values(r).every((v) => !v.available && v.reason === 'not_measured')).toBe(true);
  });
});

describe('التدرج اللوني', () => {
  it('الحدود: <20 أخضر، 20–<40، 40–<60، 60–<80، 80–100 أحمر، والمفقود رمادي', () => {
    const c = (v: number) => classify(SRI_SCALE, { available: true, value: v, unit: '' }).classId;
    expect([c(0), c(19.99), c(20), c(39.9), c(40), c(59.9), c(60), c(79.9), c(80), c(100)]).toEqual(
      ['free', 'free', 'light', 'light', 'moderate', 'moderate', 'heavy', 'heavy', 'severe', 'severe']);
    expect(classify(SRI_SCALE, na('stale')).color).toBe('#9aa0a6');
  });
  it('مفتاح الكثافة منفصل عن مفتاح الازدحام', () => {
    expect(classify(DENSITY_SCALE, { available: true, value: 30, unit: '' }).classId).toBe('F');
    expect(DENSITY_SCALE.titleAr).not.toBe(SRI_SCALE.titleAr);
  });
});
