import type { BBox, CriticalFacility, District, LngLat, MultiPolygon, Polygon, Region, RoadClass, RoadSegment, TravelDirection } from '../domain/types.ts';
import { lineLengthM, pointInPolygon, ringCentroid } from '../geo/geo.ts';
import { getJson, type Fetcher } from './http.ts';

export const OVERPASS_SOURCE_ID = 'osm-overpass';
export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
/** مرآة عامة مدرجة في قائمة خوادم Overpass على ويكي OSM، تُجرَّب عند فشل الخادم الرئيسي */
export const OVERPASS_FALLBACK_ENDPOINT = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';

/** Overpass يستخدم ترتيب (جنوب,غرب,شمال,شرق) */
export const overpassBBox = (b: BBox) => `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
}
export interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string };
  elements: OverpassElement[];
}

export function districtsQuery(region: Region): string {
  const bb = overpassBBox(region.bbox);
  return `[out:json][timeout:90];
(
  relation["boundary"="administrative"]["admin_level"~"^(9|10|11)$"](${bb});
  relation["place"~"^(suburb|neighbourhood|quarter)$"](${bb});
  way["place"~"^(suburb|neighbourhood|quarter)$"](${bb});
  node["place"~"^(suburb|neighbourhood|quarter)$"](${bb});
);
out geom;`;
}

export const ROAD_CLASSES_MAJOR = 'motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
export const ROAD_CLASSES_ALL = `${ROAD_CLASSES_MAJOR}|residential|unclassified`;

export function roadsQuery(b: BBox, classes = ROAD_CLASSES_ALL): string {
  return `[out:json][timeout:90];
way["highway"~"^(${classes})$"](${overpassBBox(b)});
out geom;`;
}

export function facilitiesQuery(b: BBox): string {
  return `[out:json][timeout:60];
nwr["amenity"~"^(hospital|clinic|fire_station|police)$"](${overpassBBox(b)});
out center tags;`;
}

/** رموز تدل على ازدحام الخادم أو تقييد المعدل، فتستحق إعادة المحاولة بعد مهلة */
const RETRYABLE = new Set([429, 502, 503, 504]);

/**
 * يجرّب الخوادم بالترتيب ويعيد أول استجابة صالحة، وإلا يرمي خطأ آخر خادم.
 * يعيد المحاولة على الخادم نفسه بعد كل مهلة في retryDelaysMs عند رموز الازدحام.
 */
export async function runOverpass(
  fetcher: Fetcher,
  query: string,
  endpoints: string | string[] = [OVERPASS_ENDPOINT, OVERPASS_FALLBACK_ENDPOINT],
  retryDelaysMs: number[] = [5000, 20000],
): Promise<OverpassResponse> {
  const list = typeof endpoints === 'string' ? [endpoints] : endpoints;
  let lastError: unknown = new Error('لا يوجد خادم Overpass مهيأ');
  for (const endpoint of list) {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelaysMs[attempt - 1]));
      try {
        return await getJson<OverpassResponse>(fetcher, OVERPASS_SOURCE_ID, endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        }, 120000);
      } catch (e) {
        lastError = e;
        const status = (e as { httpStatus?: number | null }).httpStatus;
        if (status == null || !RETRYABLE.has(status)) break;
      }
    }
  }
  throw lastError;
}

// ───────────────────────── تطبيع الأسماء العربية ─────────────────────────

export function normalizeArabicName(s: string): string {
  return s
    .replace(/[ً-ْـ]/g, '') // تشكيل وتطويل
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/^\s*حي\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────── تجميع الحلقات ─────────────────────────

const toLL = (g: { lat: number; lon: number }): LngLat => [g.lon, g.lat];
const samePt = (a: LngLat, b: LngLat) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** يربط أجزاء الحدود (طرق OSM) في حلقات مغلقة. الأجزاء التي لا تُغلق تُهمل. */
export function assembleRings(parts: LngLat[][]): LngLat[][] {
  const pool = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: LngLat[][] = [];
  while (pool.length) {
    let ring = pool.shift()!;
    let progress = true;
    while (!samePt(ring[0]!, ring[ring.length - 1]!) && progress) {
      progress = false;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i]!;
        const end = ring[ring.length - 1]!;
        if (samePt(end, p[0]!)) ring = ring.concat(p.slice(1));
        else if (samePt(end, p[p.length - 1]!)) ring = ring.concat([...p].reverse().slice(1));
        else if (samePt(ring[0]!, p[p.length - 1]!)) ring = p.concat(ring.slice(1));
        else if (samePt(ring[0]!, p[0]!)) ring = [...p].reverse().concat(ring.slice(1));
        else continue;
        pool.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (ring.length >= 4 && samePt(ring[0]!, ring[ring.length - 1]!)) rings.push(ring);
  }
  return rings;
}

function relationGeometry(el: OverpassElement): Polygon | MultiPolygon | null {
  const outer = assembleRings((el.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry!.map(toLL)));
  const inner = assembleRings((el.members ?? []).filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => m.geometry!.map(toLL)));
  if (outer.length === 0) return null;
  const polys: LngLat[][][] = outer.map((o) => [o]);
  for (const h of inner) {
    const host = polys.find((p) => pointInPolygon(h[0]!, { type: 'Polygon', coordinates: [p[0]!] }));
    host?.push(h);
  }
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0]! } : { type: 'MultiPolygon', coordinates: polys };
}

/**
 * يحوّل استجابة Overpass إلى أحياء. يفضّل المضلع على النقطة لنفس الاسم،
 * ويحتفظ بالأحياء ذات النقطة فقط موسومة «point_only» دون اختلاق حدود.
 */
export function parseDistricts(resp: OverpassResponse, regionId: string): District[] {
  const byName = new Map<string, District>();
  const rank = (d: District) => (d.boundaryQuality === 'polygon' ? 2 : 1);
  for (const el of resp.elements) {
    const t = el.tags ?? {};
    const nameAr = t['name:ar'] ?? (/[؀-ۿ]/.test(t.name ?? '') ? t.name : undefined);
    if (!nameAr) continue;
    // نستبعد حدود الإدارات الأعلى المعلّمة بمستويات 9–11 إن لم تكن أحياء (مثل البلديات)
    if (t.boundary === 'administrative' && /بلدية|محافظة|امانة|أمانة/.test(nameAr)) continue;
    let geometry: Polygon | MultiPolygon | null = null;
    let centroid: LngLat | null = null;
    if (el.type === 'relation') geometry = relationGeometry(el);
    else if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
      const ring = el.geometry.map(toLL);
      if (samePt(ring[0]!, ring[ring.length - 1]!)) geometry = { type: 'Polygon', coordinates: [ring] };
    } else if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) centroid = [el.lon, el.lat];
    if (geometry) centroid = ringCentroid(geometry.type === 'Polygon' ? geometry.coordinates[0]! : geometry.coordinates[0]![0]!);
    if (!centroid) continue;
    const d: District = {
      id: `osm:${el.type[0]}${el.id}`,
      regionId,
      nameAr,
      nameEn: t['name:en'],
      geometry,
      centroid,
      boundaryQuality: geometry ? 'polygon' : 'point_only',
      sourceId: OVERPASS_SOURCE_ID,
      sourceRef: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    };
    const key = normalizeArabicName(nameAr);
    const prev = byName.get(key);
    if (!prev || rank(d) > rank(prev)) byName.set(key, d);
  }
  return [...byName.values()];
}

function roadClassOf(h: string): RoadClass {
  if (h.endsWith('_link')) return 'link';
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified'].includes(h)) return h as RoadClass;
  return 'unclassified';
}

/** اتجاهات الحركة وفق وسوم OSM: oneway=yes/-1، والطريق السريع والدوار باتجاه واحد افتراضيًا. */
export function directionsFromTags(t: Record<string, string>): TravelDirection[] {
  const ow = t.oneway;
  if (ow === '-1' || ow === 'reverse') return ['bwd'];
  if (ow === 'yes' || ow === '1' || ow === 'true') return ['fwd'];
  if (ow === 'no') return ['fwd', 'bwd'];
  if (t.highway === 'motorway' || t.junction === 'roundabout' || t.junction === 'circular') return ['fwd'];
  return ['fwd', 'bwd'];
}

export function parseRoads(resp: OverpassResponse, regionId: string, districts: District[] = []): RoadSegment[] {
  const polys = districts.filter((d) => d.geometry);
  const out: RoadSegment[] = [];
  for (const el of resp.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const t = el.tags ?? {};
    if (!t.highway) continue;
    const coords = el.geometry.map(toLL);
    const lanes = Number.parseInt(t.lanes ?? '', 10);
    const maxs = Number.parseInt(t.maxspeed ?? '', 10);
    // نحدد الأحياء التي يمر بها المقطع من بدايته ووسطه ونهايته
    const probes = [coords[0]!, coords[Math.floor(coords.length / 2)]!, coords[coords.length - 1]!];
    const hits = probes.map((p) => polys.find((d) => pointInPolygon(p, d.geometry!))?.id ?? null);
    const districtIds = [...new Set(hits.filter((x): x is string => x !== null))];
    const isGateway = new Set(hits).size > 1; // يعبر من حي إلى آخر أو إلى خارج الأحياء المعروفة
    out.push({
      id: `osm:w${el.id}`,
      regionId,
      nameAr: t['name:ar'] ?? (/[؀-ۿ]/.test(t.name ?? '') ? t.name : undefined),
      nameEn: t['name:en'] ?? (!/[؀-ۿ]/.test(t.name ?? '') ? t.name : undefined),
      ref: t.ref,
      roadClass: roadClassOf(t.highway),
      directions: directionsFromTags(t),
      geometry: { type: 'LineString', coordinates: coords },
      lengthM: lineLengthM(coords),
      lanes: Number.isFinite(lanes) ? lanes : undefined,
      maxSpeedKmh: Number.isFinite(maxs) ? maxs : undefined,
      districtIds,
      isDistrictGateway: isGateway && districtIds.length > 0,
      sourceId: OVERPASS_SOURCE_ID,
      sourceRef: `https://www.openstreetmap.org/way/${el.id}`,
    });
  }
  return out;
}

export function parseFacilities(resp: OverpassResponse): CriticalFacility[] {
  const out: CriticalFacility[] = [];
  for (const el of resp.elements) {
    const t = el.tags ?? {};
    const p = el.type === 'node' ? (el.lat !== undefined ? { lat: el.lat, lon: el.lon! } : undefined) : el.center;
    if (!p) continue;
    const kind = t.amenity as CriticalFacility['kind'];
    if (!['hospital', 'clinic', 'fire_station', 'police'].includes(kind)) continue;
    out.push({ id: `osm:${el.type[0]}${el.id}`, kind, nameAr: t['name:ar'] ?? t.name, point: [p.lon, p.lat], sourceId: OVERPASS_SOURCE_ID });
  }
  return out;
}
