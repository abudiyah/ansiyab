/**
 * وضع المحاكاة: لاختبار الواجهة فقط. كل سجل يحمل provenance='simulated' وsourceId='simulation'،
 * والواجهة تعرض شريطًا دائمًا: «بيانات محاكاة لأغراض العرض وليست حالة المرور الفعلية».
 * الهندسة شبكات مربعة اصطناعية حول مراكز تقريبية، وليست حدود الأحياء أو طرقها الحقيقية.
 */
import type { District, LngLat, Region, RoadSegment, SegmentDirectionKey, SpeedObservation, TrafficEvent, WeatherObservation } from '../domain/types.ts';
import { segmentKey } from '../domain/types.ts';
import { lineLengthM } from '../geo/geo.ts';

export const SIMULATION_SOURCE_ID = 'simulation';
export const SIMULATION_BANNER_AR = 'بيانات محاكاة لأغراض العرض وليست حالة المرور الفعلية';

const APPROX_CENTERS: Record<string, LngLat> = {
  'العليا': [46.685, 24.695],
  'الملز': [46.735, 24.665],
  'النرجس': [46.69, 24.865],
  'العزيزية': [46.765, 24.59],
  'الروضة': [46.77, 24.735],
  'الياسمين': [46.645, 24.825],
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function simulatedNetwork(region: Region): { districts: District[]; segments: RoadSegment[] } {
  const districts: District[] = [];
  const segments: RoadSegment[] = [];
  const half = 0.012; // ~1.2 كم
  for (const sd of region.sampleDistricts) {
    const c = APPROX_CENTERS[sd.nameAr] ?? region.center;
    const id = `sim:${sd.nameEn.replace(/\s+/g, '_')}`;
    const ring: LngLat[] = [
      [c[0] - half, c[1] - half], [c[0] + half, c[1] - half], [c[0] + half, c[1] + half], [c[0] - half, c[1] + half], [c[0] - half, c[1] - half],
    ];
    districts.push({ id, regionId: region.id, nameAr: `${sd.nameAr} (محاكاة)`, nameEn: sd.nameEn, geometry: { type: 'Polygon', coordinates: [ring] }, centroid: c, boundaryQuality: 'polygon', sourceId: SIMULATION_SOURCE_ID, sourceRef: 'simulation' });
    const lines: { coords: LngLat[]; cls: RoadSegment['roadClass']; name: string; gateway: boolean; oneway: boolean }[] = [];
    // شريانان رئيسيان يعبران الحدود (مداخل/مخارج) بمسارين منفصلين لكل اتجاه
    const ext = half * 1.4;
    lines.push({ coords: [[c[0] - ext, c[1] - 0.0002], [c[0] + ext, c[1] - 0.0002]], cls: 'primary', name: `شارع رئيسي أ – ${sd.nameAr}`, gateway: true, oneway: true });
    lines.push({ coords: [[c[0] + ext, c[1] + 0.0002], [c[0] - ext, c[1] + 0.0002]], cls: 'primary', name: `شارع رئيسي أ – ${sd.nameAr}`, gateway: true, oneway: true });
    lines.push({ coords: [[c[0] + 0.0002, c[1] - ext], [c[0] + 0.0002, c[1] + ext]], cls: 'secondary', name: `شارع رئيسي ب – ${sd.nameAr}`, gateway: true, oneway: true });
    lines.push({ coords: [[c[0] - 0.0002, c[1] + ext], [c[0] - 0.0002, c[1] - ext]], cls: 'secondary', name: `شارع رئيسي ب – ${sd.nameAr}`, gateway: true, oneway: true });
    for (const f of [-0.6, -0.3, 0.3, 0.6]) {
      lines.push({ coords: [[c[0] - half, c[1] + f * half], [c[0] + half, c[1] + f * half]], cls: 'residential', name: 'شارع سكني', gateway: false, oneway: false });
      lines.push({ coords: [[c[0] + f * half, c[1] - half], [c[0] + f * half, c[1] + half]], cls: 'residential', name: 'شارع سكني', gateway: false, oneway: false });
    }
    lines.forEach((l, i) => {
      segments.push({
        id: `${id}:r${i}`, regionId: region.id, nameAr: l.name, roadClass: l.cls, directions: l.oneway ? ['fwd'] : ['fwd', 'bwd'],
        geometry: { type: 'LineString', coordinates: l.coords }, lengthM: lineLengthM(l.coords), lanes: l.cls === 'residential' ? 1 : 3,
        maxSpeedKmh: l.cls === 'residential' ? 40 : l.cls === 'primary' ? 80 : 60, districtIds: [id], isDistrictGateway: l.gateway,
        sourceId: SIMULATION_SOURCE_ID, sourceRef: 'simulation',
      });
    });
  }
  return { districts, segments };
}

/** منحنى يومي تقريبي (ذروتان صباحية ومسائية) لتوليد قيم متغيرة مع الزمن */
function demand(hourLocal: number): number {
  const g = (mu: number, s: number) => Math.exp(-((hourLocal - mu) ** 2) / (2 * s * s));
  return 0.15 + 0.55 * g(7.5, 1.2) + 0.45 * g(13.5, 1.5) + 0.7 * g(18, 2);
}

export function simulatedSpeeds(segments: RoadSegment[], now: Date): Map<SegmentDirectionKey, SpeedObservation> {
  const out = new Map<SegmentDirectionKey, SpeedObservation>();
  const bucket = Math.floor(now.getTime() / (5 * 60e3));
  const hour = ((now.getUTCHours() + 3) % 24) + now.getUTCMinutes() / 60;
  const iso = new Date(bucket * 5 * 60e3).toISOString();
  segments.forEach((s, i) => {
    for (const d of s.directions) {
      const r = rng(bucket * 7919 + i * 31 + (d === 'bwd' ? 17 : 0));
      if (r() < 0.12) continue; // فجوات تغطية مقصودة لاختبار «غير معروف»
      const ff = s.maxSpeedKmh ?? 50;
      const load = Math.min(0.95, demand(hour) * (s.isDistrictGateway ? 1.25 : 0.8) + (r() - 0.5) * 0.3);
      const cur = Math.max(4, Math.round(ff * (1 - Math.max(0, load))));
      const ffT = Math.round((s.lengthM / 1000 / ff) * 3600);
      out.set(segmentKey(s.id, d), {
        segmentKey: segmentKey(s.id, d), sourceId: SIMULATION_SOURCE_ID, observedAt: iso, receivedAt: now.toISOString(), provenance: 'simulated',
        currentSpeedKmh: cur, freeFlowSpeedKmh: ff, currentTravelTimeS: Math.round((s.lengthM / 1000 / cur) * 3600), freeFlowTravelTimeS: ffT,
        confidence: 0.6 + r() * 0.4, roadClosure: false,
      });
    }
  });
  return out;
}

export function simulatedEvents(segments: RoadSegment[], now: Date): TrafficEvent[] {
  const bucket = Math.floor(now.getTime() / (20 * 60e3));
  const r = rng(bucket);
  const majors = segments.filter((s) => s.roadClass !== 'residential');
  const types: TrafficEvent['type'][] = ['accident', 'breakdown', 'roadworks', 'road_closure', 'flooding'];
  const out: TrafficEvent[] = [];
  for (let i = 0; i < 4 && majors.length; i++) {
    const s = majors[Math.floor(r() * majors.length)]!;
    const type = types[Math.floor(r() * types.length)]!;
    const c = s.geometry.coordinates;
    const p: LngLat = [(c[0]![0] + c[1]![0]) / 2, (c[0]![1] + c[1]![1]) / 2];
    out.push({
      id: `sim:ev:${bucket}:${i}`, sourceId: SIMULATION_SOURCE_ID, externalId: `${bucket}-${i}`, type, severity: type === 'road_closure' ? 'critical' : 'moderate',
      geometry: { type: 'Point', coordinates: p }, startTime: new Date(bucket * 20 * 60e3).toISOString(), endTime: null, lastReportTime: now.toISOString(),
      receivedAt: now.toISOString(), verification: 'unverified', delayS: type === 'road_closure' ? null : Math.round(r() * 600), lengthM: 300, lanesAffected: null,
      isClosure: type === 'road_closure', descriptionAr: `حدث محاكاة: ${type}`, segmentKeys: [segmentKey(s.id, s.directions[0]!)], districtIds: s.districtIds, provenance: 'simulated',
    });
  }
  return out;
}

export function simulatedWeather(districts: District[], now: Date): WeatherObservation[] {
  const r = rng(Math.floor(now.getTime() / 3600e3));
  return districts.map((d) => ({
    sourceId: SIMULATION_SOURCE_ID, observedAt: now.toISOString(), receivedAt: now.toISOString(), provenance: 'simulated' as const,
    locationId: d.id, point: d.centroid, kind: 'current' as const, validAt: now.toISOString(), temperatureC: 25 + r() * 10,
    precipitationMm: r() < 0.2 ? r() * 15 : 0, rainMm: null, windSpeedKmh: 10 + r() * 30, windGustsKmh: 20 + r() * 50,
    visibilityM: r() < 0.2 ? 600 + r() * 2000 : 10000, weatherCode: 1, dustUgM3: r() * 300, spatialResolutionKm: null,
  }));
}
