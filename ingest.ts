import {
  evaluateAlerts,
  expandBBox,
  splitBBox,
  bboxOf,
  getRegion,
  getSource,
  normalizeArabicNameSafe,
  overpass,
  openMeteo,
  tomtom,
  ncmEws,
  polygonCoords,
  pollingIntervalFor,
  SegmentIndex,
  simulatedEvents,
  simulatedNetwork,
  simulatedSpeeds,
  simulatedWeather,
  SourceError,
  type AlertContext,
  type BBox,
  type District,
  type LngLat,
  type RoadSegment,
  type Region,
} from './coreFacade.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import type { Network, Store } from './store.ts';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const maxAge = (id: string) => getSource(id)?.maxAgeS ?? 900;

export const policy = { maxAgeS: 20 * 60 };

function fetcher(input: string, init?: RequestInit) {
  return fetch(input, { ...init, headers: { 'User-Agent': 'Ansiyab/0.1 (traffic decision-support prototype)', ...(init?.headers ?? {}) } });
}

// ───────────────────────── قاعدة الطرق والأحياء ─────────────────────────

const OVERPASS_CACHE_TTL_MS = 7 * 86400e3;

/**
 * Overpass مع تخزين كل استجابة ناجحة على القرص سبعة أيام، حتى تتقدم إعادة البناء
 * عبر المحاولات المتتالية عندما يكون الخادم العام مزدحمًا، ولا تُكرر الاستعلامات الناجحة.
 */
async function cachedOverpass(query: string): Promise<overpass.OverpassResponse> {
  const dir = join(config.dataDir, 'overpass-cache');
  const file = join(dir, createHash('sha1').update(query).digest('hex') + '.json');
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < OVERPASS_CACHE_TTL_MS) return JSON.parse(readFileSync(file, 'utf8'));
  const r = await overpass.runOverpass(fetcher, query, config.overpassEndpoints, config.overpassRetryDelaysMs);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(r));
  return r;
}

export async function buildNetwork(region: Region): Promise<Network> {
  const notes: string[] = [];
  log('[network] جلب الأحياء من Overpass');
  const dResp = await cachedOverpass(overpass.districtsQuery(region));
  const all = overpass.parseDistricts(dResp, region.id);
  const polys = all.filter((d) => d.boundaryQuality === 'polygon').length;
  notes.push(`OSM: ${all.length} حيًا مسمى في نطاق ${region.nameAr}، منها ${polys} بمضلع حدود و${all.length - polys} بنقطة فقط.`);

  const sample: District[] = [];
  const boxes: { box: BBox; label: string }[] = [];
  for (const sd of region.sampleDistricts) {
    const d = all.find((x) => normalizeArabicNameSafe(x.nameAr) === normalizeArabicNameSafe(sd.nameAr));
    if (!d) {
      notes.push(`حي ${sd.nameAr}: غير موجود باسمه العربي في OSM.`);
      continue;
    }
    sample.push(d);
    if (d.geometry) boxes.push({ box: expandBBox(bboxOf(polygonCoords(d.geometry)), 300), label: d.nameAr });
    else {
      boxes.push({ box: expandBBox({ minLng: d.centroid[0], minLat: d.centroid[1], maxLng: d.centroid[0], maxLat: d.centroid[1] }, 1200), label: d.nameAr });
      notes.push(`حي ${sd.nameAr}: نقطة فقط في OSM؛ جُلبت الطرق ضمن 1.2 كم حول النقطة، ولا تُنسب للحي في التجميع.`);
    }
  }

  const ways = new Map<number, overpass.OverpassElement>();
  const facilities = new Map<string, ReturnType<typeof overpass.parseFacilities>[number]>();
  for (const { box, label } of boxes) {
    // مربعات صغيرة حتى لا تتجاوز الاستعلامات مهلة الخوادم العامة المزدحمة
    const tiles = splitBBox(box, config.overpassTileDeg);
    log(`[network] طرق ومرافق: ${label} (${tiles.length} مربعات)`);
    for (const tile of tiles) {
      const r = await cachedOverpass(overpass.roadsQuery(tile));
      for (const el of r.elements) if (el.type === 'way') ways.set(el.id, el);
    }
    const f = await cachedOverpass(overpass.facilitiesQuery(box));
    for (const x of overpass.parseFacilities(f)) facilities.set(x.id, x);
  }
  if (config.roadsScope === 'city') {
    log('[network] الطرق الرئيسية على مستوى المدينة');
    const r = await cachedOverpass(overpass.roadsQuery(region.bbox, 'motorway|trunk|primary|motorway_link|trunk_link'));
    for (const el of r.elements) if (el.type === 'way') ways.set(el.id, el);
  }
  const segments = overpass.parseRoads({ elements: [...ways.values()] }, region.id, all.filter((d) => d.geometry));
  notes.push(`الطرق: ${segments.length} مقطعًا بطول ${(segments.reduce((a, s) => a + s.lengthM, 0) / 1000).toFixed(0)} كم.`);
  return { regionId: region.id, builtAt: new Date().toISOString(), districts: all, segments, facilities: [...facilities.values()], coverageNotesAr: notes };
}

/** نقاط مراقبة TomTom: مداخل الأحياء أولًا ثم الطرق الأعلى تصنيفًا والأطول. نقطة منتصف كل مقطع. */
export function monitoredPoints(segments: RoadSegment[], sampleIds: Set<string>, n: number): { segment: RoadSegment; point: LngLat }[] {
  const prio: Record<string, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4 };
  return segments
    .filter((s) => s.roadClass in prio && s.lengthM >= 150 && s.districtIds.some((d) => sampleIds.has(d)))
    .sort((a, b) => Number(b.isDistrictGateway) - Number(a.isDistrictGateway) || prio[a.roadClass]! - prio[b.roadClass]! || b.lengthM - a.lengthM)
    .slice(0, n)
    .map((segment) => {
      const c = segment.geometry.coordinates;
      return { segment, point: c[Math.floor(c.length / 2)]! };
    });
}

// ───────────────────────── الجدولة ─────────────────────────

export class Ingestor {
  private index: SegmentIndex | null = null;
  private timers: NodeJS.Timeout[] = [];
  readonly region: Region;
  sampleDistrictIds = new Set<string>();
  intervals: Record<string, number> = {};

  constructor(private store: Store) {
    this.region = getRegion(config.regionId);
  }

  private refreshIndex() {
    const n = this.store.network;
    this.index = n ? new SegmentIndex(n.segments) : null;
    if (n) {
      const names = new Set(this.region.sampleDistricts.map((s) => normalizeArabicNameSafe(s.nameAr)));
      this.sampleDistrictIds = new Set(n.districts.filter((d) => names.has(normalizeArabicNameSafe(d.nameAr.replace(' (محاكاة)', '')))).map((d) => d.id));
    }
  }

  private every(name: string, minutes: number, fn: () => Promise<void>) {
    this.intervals[name] = minutes;
    const run = async () => {
      try {
        await fn();
      } catch (e) {
        log(`[${name}] خطأ:`, e instanceof Error ? e.message : e);
      }
      this.evaluate();
      this.timers.push(setTimeout(run, minutes * 60e3));
    };
    void run();
  }

  async start() {
    if (config.mode === 'simulation') return this.startSimulation();
    // بناء الشبكة قد يطول مع خوادم Overpass المزدحمة، فلا يؤخر الطقس والمصادر الأخرى
    void this.ensureNetwork();
    // إعادة المحاولة كل 15 دقيقة إن فشل البناء، وإعادة البناء أسبوعيًا
    this.timers.push(setInterval(() => void this.ensureNetwork(), 15 * 60e3));

    this.every('weather', 15, () => this.pullWeather());
    if (config.tomtomKey) {
      // الفاصل محسوب على الحد الأعلى لعدد النقاط حتى لا تُتجاوز الحصة الشهرية
      this.every('tomtom-flow', Math.max(5, pollingIntervalFor(config.tomtomFlowQuota, Math.max(1, config.tomtomMonitorPoints))), () => this.pullFlow());
      this.every('tomtom-incidents', Math.max(5, pollingIntervalFor(config.tomtomIncidentsQuota, 1)), () => this.pullIncidents());
    }
    if (config.ncmBaseUrl) this.every('ncm-ews', 10, () => this.pullNcm());
    // إعادة التقييم الدوري حتى بلا بيانات جديدة (للتقادم والإغلاق التلقائي)
    this.timers.push(setInterval(() => this.evaluate(), 60e3));
  }

  private async ensureNetwork() {
    const n = this.store.network;
    if (n && Date.now() - new Date(n.builtAt).getTime() <= 7 * 86400e3) {
      this.store.markSuccess('osm-overpass', maxAge('osm-overpass'));
      if (!this.index) this.refreshIndex();
      return;
    }
    try {
      this.store.saveNetwork(await buildNetwork(this.region));
      this.store.markSuccess('osm-overpass', maxAge('osm-overpass'));
      this.refreshIndex();
      // إعادة جلب الطقس لمراكز الأحياء بدل مركز المدينة
      void this.pullWeather().then(() => this.evaluate());
    } catch (e) {
      this.store.markError('osm-overpass', maxAge('osm-overpass'), msg(e));
      log('[network] فشل البناء:', msg(e));
    }
  }

  private startSimulation() {
    const net = simulatedNetwork(this.region);
    this.store.network = { regionId: this.region.id, builtAt: new Date().toISOString(), ...net, facilities: [], coverageNotesAr: ['وضع المحاكاة: شبكة اصطناعية وليست طرقًا حقيقية.'] };
    this.refreshIndex();
    this.every('simulation', 5, async () => {
      const now = new Date();
      this.store.speed = simulatedSpeeds(net.segments, now);
      this.store.speedHistory.push(...this.store.speed.values());
      this.store.events = simulatedEvents(net.segments, now);
      this.store.weatherCurrent = simulatedWeather(net.districts, now);
      this.store.markSuccess('simulation', 900);
    });
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
  }

  async pullWeather() {
    const net = this.store.network;
    const locs = (net?.districts ?? []).filter((d) => this.sampleDistrictIds.has(d.id));
    const points: { id: string; p: LngLat }[] = locs.length ? locs.map((d) => ({ id: d.id, p: d.centroid })) : [{ id: this.region.id, p: this.region.center }];
    const now = new Date();
    try {
      const resp = await openMeteo.fetchForecast(fetcher, points.map((x) => x.p), { pastDays: 2, forecastDays: 2 });
      let dust: (number | null)[] = [];
      try {
        const aq = await openMeteo.fetchAirQuality(fetcher, points.map((x) => x.p));
        dust = aq.map((r) => (typeof r.current?.dust === 'number' ? (r.current.dust as number) : null));
        this.store.markSuccess('open-meteo-aq', maxAge('open-meteo-aq'));
      } catch (e) {
        this.store.markError('open-meteo-aq', maxAge('open-meteo-aq'), msg(e));
      }
      const cur = [], hourly = [];
      for (let i = 0; i < resp.length; i++) {
        const parsed = openMeteo.parseForecast(resp[i]!, points[i]!.id, now.toISOString(), now, dust[i] ?? null);
        if (parsed.current) cur.push(parsed.current);
        hourly.push(...parsed.hourly);
      }
      this.store.weatherCurrent = cur;
      this.store.weatherHourly = hourly;
      this.store.markSuccess('open-meteo', maxAge('open-meteo'));
    } catch (e) {
      this.store.markError('open-meteo', maxAge('open-meteo'), msg(e));
      throw e;
    }
  }

  async pullFlow() {
    if (!this.index || !this.store.network) return;
    const pts = monitoredPoints(this.store.network.segments, this.sampleDistrictIds, config.tomtomMonitorPoints);
    const now = new Date().toISOString();
    const obs = [];
    let noMatch = 0, errors = 0;
    for (const { point } of pts) {
      try {
        const r = await tomtom.fetchFlowSegment(fetcher, point, config.tomtomKey);
        const parsed = tomtom.parseFlowSegment(r, this.index, now);
        if (parsed.obs) obs.push(parsed.obs);
        else noMatch++;
      } catch (e) {
        errors++;
        if (e instanceof SourceError && (e.httpStatus === 403 || e.httpStatus === 401)) {
          this.store.markError('tomtom-flow', maxAge('tomtom-flow'), msg(e));
          break;
        }
      }
    }
    this.store.flowCycle = { requested: pts.length, valid: obs.length, noMatch, errors, at: now };
    this.store.addSpeed(obs);
    if (obs.length) this.store.markSuccess('tomtom-flow', maxAge('tomtom-flow'));
    else this.store.markError('tomtom-flow', maxAge('tomtom-flow'), `لا قراءات صالحة (${errors} خطأ، ${noMatch} بلا مطابقة)`);
  }

  async pullIncidents() {
    try {
      const r = await tomtom.fetchIncidents(fetcher, this.region.bbox, config.tomtomKey);
      const ev = tomtom.parseIncidents(r, this.index, new Date().toISOString());
      // منع التكرار: نفس المعرّف الخارجي يُحدّث ولا يُضاف
      const byId = new Map(ev.map((e) => [e.id, e]));
      this.store.events = [...byId.values()];
      this.store.appendEventLog(this.store.events);
      this.store.markSuccess('tomtom-incidents', maxAge('tomtom-incidents'));
    } catch (e) {
      this.store.markError('tomtom-incidents', maxAge('tomtom-incidents'), msg(e));
      throw e;
    }
  }

  async pullNcm() {
    try {
      const headers = config.ncmAuthHeader ? Object.fromEntries([config.ncmAuthHeader.split(':').map((s) => s.trim()) as [string, string]]) : undefined;
      const items = await ncmEws.fetchNotifications(fetcher, config.ncmBaseUrl, headers);
      this.store.warnings = ncmEws.parseNotifications(items, new Date().toISOString(), this.region.nameAr);
      this.store.markSuccess('ncm-ews', maxAge('ncm-ews'));
    } catch (e) {
      this.store.markError('ncm-ews', maxAge('ncm-ews'), msg(e));
      throw e;
    }
  }

  alertContext(now = new Date()): AlertContext {
    const n = this.store.network;
    const names = new Map((n?.districts ?? []).map((d) => [d.id, d.nameAr]));
    return {
      now,
      policy,
      segments: new Map((n?.segments ?? []).map((s) => [s.id, s])),
      speed: this.store.speed,
      flow: new Map(),
      events: this.store.events,
      weather: this.store.weatherCurrent,
      warnings: this.store.warnings,
      water: [],
      facilities: n?.facilities ?? [],
      sources: [...this.store.health.values()],
      districtName: (id) => names.get(id),
    };
  }

  evaluate() {
    const r = evaluateAlerts(this.store.engine, this.alertContext(), this.store.ruleConfig, config.mode === 'simulation' ? 'simulated' : 'live');
    this.store.engine = r.state;
    this.lastStatuses = r.statuses;
    if (r.opened.length || r.resolved.length) this.store.saveAlerts();
  }
  lastStatuses: ReturnType<typeof evaluateAlerts>['statuses'] = [];

  get segmentIndex() {
    return this.index;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
