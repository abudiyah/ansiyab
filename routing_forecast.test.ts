import { describe, expect, it } from 'vitest';
import { assessRoutes, SegmentIndex, backtest, forecastReadiness, seasonalBlend, type RoadSegment, type TrafficEvent, type SeriesPoint } from '../src/index.ts';

const seg = (id: string, coords: [number, number][], cls: RoadSegment['roadClass'] = 'primary'): RoadSegment => ({ id, regionId: 'r', roadClass: cls, directions: ['fwd', 'bwd'],
  geometry: { type: 'LineString', coordinates: coords }, lengthM: 1000, districtIds: [], isDistrictGateway: false, sourceId: 'osm', sourceRef: '' });
const now = new Date('2026-10-23T18:00:00Z');

describe('تقييم المسارات', () => {
  const a = seg('a', [[46.60, 24.70], [46.62, 24.70]]);
  const b = seg('b', [[46.60, 24.71], [46.62, 24.71]], 'residential');
  const idx = new SegmentIndex([a, b]);
  const routes = [
    { id: 'r1', geometry: { type: 'LineString' as const, coordinates: [[46.60, 24.70], [46.62, 24.70]] as [number, number][] }, distanceM: 2000, engineDurationS: 120, engineId: 'osrm-demo' },
    { id: 'r2', geometry: { type: 'LineString' as const, coordinates: [[46.60, 24.71], [46.62, 24.71]] as [number, number][] }, distanceM: 2000, engineDurationS: 150, engineId: 'osrm-demo' },
  ];
  const closure: TrafficEvent = { id: 'c', sourceId: 'x', externalId: 'c', type: 'road_closure', severity: 'critical', geometry: { type: 'Point', coordinates: [46.61, 24.70] },
    startTime: null, endTime: null, lastReportTime: null, receivedAt: '', verification: 'provider_reported', delayS: null, lengthM: null, lanesAffected: null, isClosure: true, segmentKeys: [], districtIds: [], provenance: 'live' };
  it('يستبعد المسار الذي يمر بإغلاق، ويوضح أثر نقص البيانات وعدم ادعاء السلامة من السيول', () => {
    const r = assessRoutes(routes, { index: idx, speed: new Map(), events: [closure], water: [], now, policy: { maxAgeS: 900 } });
    expect(r[0]!.excluded).toBe(true);
    expect(r[0]!.rank).toBeNull();
    expect(r[1]!.rank).toBe(1);
    expect(r[1]!.liveAdjustedDurationMin.available).toBe(false);
    expect(r[1]!.notesAr.join(' ')).toContain('لا يعني أنه آمن');
    expect(r[1]!.notesAr.join(' ')).toContain('ليس على المرور الحي');
    expect(r[1]!.residentialShare).toMatchObject({ available: true });
    expect((r[1]!.residentialShare as { value: number }).value).toBeGreaterThan(90);
  });
});

describe('التنبؤ', () => {
  const day = 86400e3;
  const t0 = Date.UTC(2026, 8, 1);
  // سلسلة 35 يومًا بنمط يومي ثابت + ضوضاء حتمية
  const series: SeriesPoint[] = [];
  for (let t = t0; t < t0 + 35 * day; t += 15 * 60e3) {
    const h = ((t / 3600e3) % 24);
    series.push({ t, v: 30 + 30 * Math.sin((h / 24) * 2 * Math.PI) + ((t / 60e3) % 7) });
  }
  it('غير جاهز قبل 28 يومًا', () => {
    expect(forecastReadiness(series.slice(0, 96 * 10)).ready).toBe(false);
    expect(forecastReadiness(series).ready).toBe(true);
  });
  it('لا تسرب للمستقبل: النموذج يستخدم بيانات ≤ t0 فقط', () => {
    const tq = t0 + 30 * day;
    const past = series.filter((p) => p.t <= tq);
    expect(seasonalBlend(past, tq, 60)).toBeCloseTo(seasonalBlend(series, tq, 60)!, 6);
  });
  it('الاختبار الزمني يعيد الخطأ ونطاق عدم اليقين لكل أفق، ويتفوق على الاستمرار في نمط يومي', () => {
    const r = backtest(series, t0 + 30 * day, 60);
    expect(r.map((x) => x.horizonMin)).toEqual([15, 30, 60]);
    const h60 = r.find((x) => x.horizonMin === 60)!;
    expect(h60.n).toBeGreaterThan(50);
    expect(h60.errP10).not.toBeNull();
    expect(h60.skill!).toBeGreaterThan(0);
  });
});
