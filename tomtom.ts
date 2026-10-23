import type { BBox, LngLat, LineString, Point, Severity, SpeedObservation, TrafficEvent, TrafficEventType } from '../domain/types.ts';
import { bearingDeg, lineLengthM } from '../geo/geo.ts';
import type { SegmentIndex } from '../geo/spatialIndex.ts';
import { getJson, type Fetcher } from './http.ts';

export const TOMTOM_FLOW_ID = 'tomtom-flow';
export const TOMTOM_INCIDENTS_ID = 'tomtom-incidents';
export const TOMTOM_BASE = 'https://api.tomtom.com';

// ───────────────────────── Flow Segment Data ─────────────────────────

export interface TomTomFlowResponse {
  flowSegmentData: {
    frc: string;
    currentSpeed: number;
    freeFlowSpeed: number;
    currentTravelTime: number;
    freeFlowTravelTime: number;
    confidence: number;
    roadClosure: boolean;
    coordinates: { coordinate: { latitude: number; longitude: number }[] };
  };
}

export function flowSegmentUrl(point: LngLat, key: string, zoom = 12): string {
  return `${TOMTOM_BASE}/traffic/services/4/flowSegmentData/absolute/${zoom}/json?point=${point[1]},${point[0]}&unit=KMPH&key=${encodeURIComponent(key)}`;
}

export async function fetchFlowSegment(fetcher: Fetcher, point: LngLat, key: string): Promise<TomTomFlowResponse> {
  return getJson<TomTomFlowResponse>(fetcher, TOMTOM_FLOW_ID, flowSegmentUrl(point, key));
}

/**
 * يحوّل استجابة TomTom إلى قراءة لوحدة التحليل (مقطع+اتجاه) بمطابقة هندسة المزود مع مقاطع OSM.
 * الاتجاه يُستنتج من اتجاه خط المزود (أول نقطة → آخر نقطة)، وهو افتراض موثّق في قاموس المؤشرات.
 * الاستجابة لا تتضمن وقت رصد؛ نعتبر observedAt = وقت الاستلام.
 */
export function parseFlowSegment(
  resp: TomTomFlowResponse,
  index: SegmentIndex,
  receivedAt: string,
  opts: { maxDistanceM?: number } = {},
): { obs: SpeedObservation | null; providerLine: LngLat[]; reason?: string } {
  const f = resp.flowSegmentData;
  const line: LngLat[] = (f?.coordinates?.coordinate ?? []).map((c) => [c.longitude, c.latitude]);
  if (!f || line.length < 2) return { obs: null, providerLine: line, reason: 'no_geometry' };
  const mid = line[Math.floor(line.length / 2)]!;
  const bearing = bearingDeg(line[0]!, line[line.length - 1]!);
  const m = index.match(mid, { maxDistanceM: opts.maxDistanceM ?? 30, bearing, maxAngleDeg: 50 });
  if (!m) return { obs: null, providerLine: line, reason: 'no_osm_match' };
  return {
    providerLine: line,
    obs: {
      segmentKey: m.key,
      sourceId: TOMTOM_FLOW_ID,
      observedAt: receivedAt,
      receivedAt,
      provenance: 'live',
      currentSpeedKmh: f.currentSpeed,
      freeFlowSpeedKmh: f.freeFlowSpeed,
      currentTravelTimeS: f.currentTravelTime,
      freeFlowTravelTimeS: f.freeFlowTravelTime,
      confidence: f.confidence,
      roadClosure: !!f.roadClosure,
      matchDistanceM: Math.round(m.distanceM),
    },
  };
}

// ───────────────────────── Incident Details v5 ─────────────────────────

export interface TomTomIncidentFeature {
  type: 'Feature';
  geometry: { type: 'Point' | 'LineString'; coordinates: LngLat | LngLat[] };
  properties: {
    id: string;
    iconCategory: number;
    magnitudeOfDelay: number;
    events?: { description: string; code: number; iconCategory: number }[];
    startTime?: string | null;
    endTime?: string | null;
    from?: string | null;
    to?: string | null;
    length?: number | null;
    delay?: number | null;
    roadNumbers?: string[];
    timeValidity?: string;
    probabilityOfOccurrence?: 'certain' | 'probable' | 'risk_of' | 'improbable';
    numberOfReports?: number | null;
    lastReportTime?: string | null;
  };
}
export interface TomTomIncidentsResponse {
  incidents: TomTomIncidentFeature[];
}

const FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime}}}';

export function incidentsUrl(b: BBox, key: string): string {
  const bbox = `${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`;
  return `${TOMTOM_BASE}/traffic/services/5/incidentDetails?bbox=${bbox}&fields=${encodeURIComponent(FIELDS)}&language=ar&timeValidityFilter=present&key=${encodeURIComponent(key)}`;
}

export async function fetchIncidents(fetcher: Fetcher, b: BBox, key: string): Promise<TomTomIncidentsResponse> {
  return getJson<TomTomIncidentsResponse>(fetcher, TOMTOM_INCIDENTS_ID, incidentsUrl(b, key));
}

/** iconCategory وفق الوثيقة: 0 غير معروف، 1 حادث، 2 ضباب، 3 ظروف خطرة، 4 مطر، 5 جليد، 6 ازدحام، 7 إغلاق حارة، 8 إغلاق طريق، 9 أعمال طرق، 10 رياح، 11 سيول، 14 مركبة معطلة */
export const ICON_CATEGORY: Record<number, { type: TrafficEventType; labelAr: string }> = {
  0: { type: 'other', labelAr: 'غير معروف' },
  1: { type: 'accident', labelAr: 'حادث' },
  2: { type: 'weather_hazard', labelAr: 'ضباب' },
  3: { type: 'weather_hazard', labelAr: 'ظروف خطرة' },
  4: { type: 'weather_hazard', labelAr: 'مطر' },
  5: { type: 'weather_hazard', labelAr: 'جليد' },
  6: { type: 'jam', labelAr: 'ازدحام' },
  7: { type: 'lane_closure', labelAr: 'إغلاق حارة' },
  8: { type: 'road_closure', labelAr: 'إغلاق طريق' },
  9: { type: 'roadworks', labelAr: 'أعمال طرق' },
  10: { type: 'weather_hazard', labelAr: 'رياح' },
  11: { type: 'flooding', labelAr: 'سيول/تجمع مياه' },
  14: { type: 'breakdown', labelAr: 'مركبة معطلة' },
};

/** magnitudeOfDelay: 0 غير معروف، 1 بسيط، 2 متوسط، 3 كبير، 4 غير محدد (للإغلاقات) */
export function severityFromMagnitude(m: number, isClosure: boolean): Severity {
  if (isClosure) return 'critical';
  return ({ 1: 'low', 2: 'moderate', 3: 'high' } as Record<number, Severity>)[m] ?? 'unknown';
}

export function parseIncidents(resp: TomTomIncidentsResponse, index: SegmentIndex | null, receivedAt: string): TrafficEvent[] {
  const out: TrafficEvent[] = [];
  for (const f of resp.incidents ?? []) {
    const p = f.properties;
    const cat = ICON_CATEGORY[p.iconCategory] ?? ICON_CATEGORY[0]!;
    const isClosure = cat.type === 'road_closure';
    const geometry: Point | LineString =
      f.geometry.type === 'Point'
        ? { type: 'Point', coordinates: f.geometry.coordinates as LngLat }
        : { type: 'LineString', coordinates: f.geometry.coordinates as LngLat[] };
    const coords = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
    const keys = new Set<string>();
    const districts = new Set<string>();
    if (index) {
      const bearing = coords.length >= 2 ? bearingDeg(coords[0]!, coords[coords.length - 1]!) : undefined;
      for (const c of coords.filter((_, i) => i % Math.max(1, Math.floor(coords.length / 8)) === 0)) {
        const m = index.match(c, bearing === undefined ? { maxDistanceM: 40 } : { maxDistanceM: 40, bearing, maxAngleDeg: 60 });
        if (m) {
          keys.add(m.key);
          m.segment.districtIds.forEach((d) => districts.add(d));
        }
      }
    }
    out.push({
      id: `${TOMTOM_INCIDENTS_ID}:${p.id}`,
      sourceId: TOMTOM_INCIDENTS_ID,
      externalId: p.id,
      type: cat.type,
      severity: severityFromMagnitude(p.magnitudeOfDelay, isClosure),
      geometry,
      startTime: p.startTime ?? null,
      endTime: p.endTime ?? null,
      lastReportTime: p.lastReportTime ?? null,
      receivedAt,
      // بلاغات المزود ليست تحققًا رسميًا
      verification: 'provider_reported',
      probability: p.probabilityOfOccurrence,
      numberOfReports: p.numberOfReports ?? null,
      delayS: isClosure ? null : (p.delay ?? null),
      lengthM: p.length ?? (geometry.type === 'LineString' ? lineLengthM(geometry.coordinates) : null),
      lanesAffected: null,
      isClosure,
      descriptionAr: p.events?.map((e) => e.description).join('، ') || cat.labelAr,
      fromName: p.from ?? undefined,
      toName: p.to ?? undefined,
      segmentKeys: [...keys] as TrafficEvent['segmentKeys'],
      districtIds: [...districts],
      provenance: 'live',
    });
  }
  return out;
}

/**
 * ميزانية الطلبات: يحسب أقصر فاصل تحديث يحافظ على الحصة الشهرية.
 * مثال: 20,000 طلب/شهر و12 نقطة مراقبة ← فاصل 26 دقيقة تقريبًا.
 */
export function pollingIntervalForBudget(monthlyQuota: number, requestsPerCycle: number, reserveFraction = 0.1): number {
  const usable = monthlyQuota * (1 - reserveFraction);
  const cyclesPerMonth = usable / Math.max(1, requestsPerCycle);
  const minutesPerMonth = 30 * 24 * 60;
  return Math.ceil(minutesPerMonth / cyclesPerMonth);
}
