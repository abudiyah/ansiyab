import type { LngLat, LineString, SegmentDirectionKey, SpeedObservation, TrafficEvent, WaterObservation } from '../domain/types.ts';
import { bearingDeg, haversineM, pointToLine, sampleLine } from '../geo/geo.ts';
import type { SegmentIndex } from '../geo/spatialIndex.ts';
import { segmentSpeedIndicators, type FreshnessPolicy } from '../indicators/traffic.ts';
import { na, ok, type IndicatorValue } from '../indicators/value.ts';

export interface RouteCandidate {
  id: string;
  geometry: LineString;
  distanceM: number;
  /** زمن محرك التوجيه (OSRM: سرعات افتراضية من OSM، وليس مرورًا حيًا) */
  engineDurationS: number;
  engineId: string;
}

export interface RouteAssessment {
  routeId: string;
  distanceKm: number;
  engineDurationMin: number;
  /** تقدير معدّل بالمرور الحي، فقط عند تغطية كافية */
  liveAdjustedDurationMin: IndicatorValue;
  trafficCoverage: IndicatorValue;
  meanSri: IndicatorValue;
  residentialShare: IndicatorValue;
  blockedByClosure: TrafficEvent[];
  floodReports: (TrafficEvent | WaterObservation)[];
  incidentsOnRoute: TrafficEvent[];
  excluded: boolean;
  notesAr: string[];
  rank: number | null;
}

const STEP_M = 50;

export function assessRoutes(
  routes: RouteCandidate[],
  ctx: {
    index: SegmentIndex | null;
    speed: Map<SegmentDirectionKey, SpeedObservation>;
    events: TrafficEvent[];
    water: WaterObservation[];
    now: Date;
    policy: FreshnessPolicy;
    minCoverageForAdjust?: number;
  },
): RouteAssessment[] {
  const minCov = ctx.minCoverageForAdjust ?? 60;
  const res = routes.map((r) => {
    const pts = sampleLine(r.geometry.coordinates, STEP_M);
    let matched = 0, withData = 0, sriSum = 0, residential = 0, ttiNum = 0, ttiDen = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[Math.min(pts.length - 1, i + 1)]!;
      const bearing = i + 1 < pts.length ? bearingDeg(p, q) : undefined;
      const m = ctx.index?.match(p, bearing === undefined ? { maxDistanceM: 20 } : { maxDistanceM: 20, bearing, maxAngleDeg: 40 });
      if (!m) continue;
      matched += STEP_M;
      if (m.segment.roadClass === 'residential' || m.segment.roadClass === 'unclassified') residential += STEP_M;
      const obs = ctx.speed.get(m.key);
      const ind = segmentSpeedIndicators(obs, ctx.now, ctx.policy);
      if (ind.sri.available && obs?.currentSpeedKmh && obs.freeFlowSpeedKmh) {
        withData += STEP_M;
        sriSum += ind.sri.value * STEP_M;
        ttiNum += STEP_M / obs.currentSpeedKmh;
        ttiDen += STEP_M / obs.freeFlowSpeedKmh;
      }
    }
    const totalSampled = Math.max(STEP_M, (pts.length - 1) * STEP_M);
    const near = (geom: TrafficEvent['geometry'] | LngLat, tolM: number) => {
      const coords: LngLat[] = Array.isArray(geom) ? [geom] : geom.type === 'Point' ? [geom.coordinates] : geom.coordinates;
      return coords.some((c) => pointToLine(c, r.geometry.coordinates).distanceM <= tolM);
    };
    const closures = ctx.events.filter((e) => e.isClosure && near(e.geometry, 30));
    const floods: (TrafficEvent | WaterObservation)[] = [
      ...ctx.events.filter((e) => e.type === 'flooding' && near(e.geometry, 50)),
      ...ctx.water.filter((w) => near(w.point, 50)),
    ];
    const incidents = ctx.events.filter((e) => !e.isClosure && e.type !== 'flooding' && near(e.geometry, 30));
    const coverage = (withData / totalSampled) * 100;
    const notes: string[] = [];
    if (r.engineId === 'osrm-demo') notes.push('زمن المحرك مبني على سرعات افتراضية من OSM وليس على المرور الحي.');
    if (coverage < minCov) notes.push(`تغطية بيانات المرور على المسار ${coverage.toFixed(0)}%، وهي أقل من ${minCov}%، لذلك لم يُحسب زمن معدّل.`);
    notes.push('غياب بلاغات السيول على المسار لا يعني أنه آمن منها.');
    if (residential / totalSampled > 0.3) notes.push('أكثر من 30% من المسار على شوارع سكنية؛ للتحويل أثر محتمل على الأحياء.');
    const tti = ttiDen > 0 ? ttiNum / ttiDen : null;
    return {
      routeId: r.id,
      distanceKm: r.distanceM / 1000,
      engineDurationMin: r.engineDurationS / 60,
      liveAdjustedDurationMin:
        coverage >= minCov && tti
          ? ok((r.engineDurationS / 60) * tti, 'د', { estimated: true, note: 'زمن المحرك × مؤشر زمن الرحلة على الجزء المغطى' })
          : na('insufficient_coverage'),
      trafficCoverage: ok(coverage, '%'),
      meanSri: withData > 0 ? ok(sriSum / withData, '') : na('no_data'),
      residentialShare: matched > 0 ? ok((residential / totalSampled) * 100, '%') : na('no_data', 'لم تُحمّل طرق المنطقة'),
      blockedByClosure: closures,
      floodReports: floods,
      incidentsOnRoute: incidents,
      excluded: closures.length > 0,
      notesAr: notes,
      rank: null as number | null,
    };
  });
  const usable = res.filter((r) => !r.excluded);
  const score = (r: RouteAssessment) =>
    (r.liveAdjustedDurationMin.available ? r.liveAdjustedDurationMin.value : r.engineDurationMin) *
    (1 + 0.2 * ((r.residentialShare.available ? r.residentialShare.value : 0) / 100)) *
    (1 + 0.25 * r.floodReports.length);
  usable.sort((a, b) => score(a) - score(b)).forEach((r, i) => (r.rank = i + 1));
  return res;
}

export const straightLineKm = (a: LngLat, b: LngLat) => haversineM(a, b) / 1000;
