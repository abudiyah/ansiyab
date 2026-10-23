import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRegion, openMeteo, osrm, nominatim, tomtom, overpass, redactKey, type ConnectionTestResult } from '@ansiyab/core';
import { config } from './config.ts';

const UA = { 'User-Agent': 'Ansiyab/0.1 (connection probe)' };

interface ProbeSpec {
  sourceId: string;
  skip?: string;
  url: string;
  /** عناوين بديلة تُجرَّب بالترتيب إن فشل ما قبلها */
  fallbackUrls?: string[];
  init?: RequestInit;
  expect: (json: any) => { found: string[]; missing: string[] };
}

const has = (obj: any, paths: string[]) => {
  const found: string[] = [], missing: string[] = [];
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    (v === undefined ? missing : found).push(p);
  }
  return { found, missing };
};

export function probeSpecs(): ProbeSpec[] {
  const r = getRegion(config.regionId);
  const c = r.center;
  const k = config.tomtomKey;
  return [
    { sourceId: 'open-meteo', url: openMeteo.forecastUrl([c], { pastDays: 0, forecastDays: 1 }),
      expect: (j) => has(j, ['current.time', 'current.precipitation', 'current.wind_speed_10m', 'current.wind_gusts_10m', 'current.weather_code', 'hourly.visibility']) },
    { sourceId: 'open-meteo-aq', url: openMeteo.airQualityUrl([c]), expect: (j) => has(j, ['current.time', 'current.dust', 'current.pm10']) },
    { sourceId: 'osm-overpass', url: config.overpassEndpoints[0] ?? '', fallbackUrls: config.overpassEndpoints.slice(1), init: { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(`[out:json][timeout:25];node["place"~"suburb|neighbourhood"](${overpass.overpassBBox({ minLng: c[0] - 0.05, minLat: c[1] - 0.05, maxLng: c[0] + 0.05, maxLat: c[1] + 0.05 })});out 5;`) },
      expect: (j) => has(j, ['elements.0.tags.name']) },
    { sourceId: 'osrm-demo', url: osrm.routeUrl(c, [c[0] + 0.03, c[1] + 0.04], config.osrmBase), expect: (j) => has(j, ['code', 'routes.0.distance', 'routes.0.duration', 'routes.0.geometry.coordinates']) },
    { sourceId: 'nominatim', url: nominatim.searchUrl('العليا', r.bbox), expect: (j) => has(j, ['0.lat', '0.lon', '0.display_name']) },
    { sourceId: 'openfreemap', url: 'https://tiles.openfreemap.org/styles/liberty', expect: (j) => has(j, ['version', 'sources', 'layers']) },
    { sourceId: 'tomtom-flow', skip: k ? undefined : 'لا يوجد TOMTOM_API_KEY', url: k ? tomtom.flowSegmentUrl([46.6847, 24.6953], k) : '',
      expect: (j) => has(j, ['flowSegmentData.currentSpeed', 'flowSegmentData.freeFlowSpeed', 'flowSegmentData.currentTravelTime', 'flowSegmentData.freeFlowTravelTime', 'flowSegmentData.confidence', 'flowSegmentData.roadClosure', 'flowSegmentData.coordinates.coordinate']) },
    { sourceId: 'tomtom-incidents', skip: k ? undefined : 'لا يوجد TOMTOM_API_KEY', url: k ? tomtom.incidentsUrl(r.bbox, k) : '', expect: (j) => has(j, ['incidents']) },
    { sourceId: 'ncm-ews', skip: config.ncmBaseUrl ? undefined : 'لا يوجد NCM_EWS_BASE_URL (يتطلب اعتماد طلب الوصول)', url: config.ncmBaseUrl ? config.ncmBaseUrl.replace(/\/$/, '') + '/getnotifications' : '', expect: () => ({ found: [], missing: [] }) },
  ];
}

export async function runProbe(dataDir: string): Promise<ConnectionTestResult[]> {
  const out: ConnectionTestResult[] = [];
  for (const s of probeSpecs()) {
    const testedAt = new Date().toISOString();
    if (s.skip) {
      out.push({ sourceId: s.sourceId, ok: false, testedAt, httpStatus: null, latencyMs: null, detail: `لم يُختبر: ${s.skip}` });
      continue;
    }
    const failures: string[] = [];
    let result: (ConnectionTestResult & { url?: string }) | null = null;
    for (const url of [s.url, ...(s.fallbackUrls ?? [])]) {
      result = await probeOne(s, url, testedAt, dataDir);
      if (result.ok) break;
      failures.push(`${new URL(url).host}: ${result.detail}`);
    }
    if (result && failures.length && result.ok) result.detail += ` (عبر ${new URL(result.url!).host} بعد فشل ${failures.join('؛ ')})`;
    else if (result && failures.length > 1) result.detail = failures.join('؛ ');
    if (result) { delete result.url; out.push(result); }
  }
  return out;
}

async function probeOne(s: ProbeSpec, url: string, testedAt: string, dataDir: string): Promise<ConnectionTestResult & { url?: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...s.init, headers: { ...UA, ...(s.init?.headers ?? {}) }, signal: AbortSignal.timeout(30000) });
    const latencyMs = Math.round(performance.now() - t0);
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* ليس JSON */ }
    const { found, missing } = json ? s.expect(json) : { found: [], missing: ['(الاستجابة ليست JSON)'] };
    const ok = res.ok && missing.length === 0;
    if (ok || !s.fallbackUrls?.length) writeFileSync(join(dataDir, 'probe', `${s.sourceId}.json`), JSON.stringify({ url: redactKey(url), status: res.status, testedAt, body: json ?? text.slice(0, 2000) }, null, 1).slice(0, 200000));
    return { sourceId: s.sourceId, ok, testedAt, httpStatus: res.status, latencyMs, fieldsFound: found, fieldsMissing: missing, url,
      detail: ok ? `نجح: HTTP ${res.status} خلال ${latencyMs} مللي ثانية، وكل الحقول المتوقعة موجودة` : `فشل: HTTP ${res.status}${missing.length ? `، حقول مفقودة: ${missing.join(', ')}` : ''}` };
  } catch (e) {
    return { sourceId: s.sourceId, ok: false, testedAt, httpStatus: null, latencyMs: Math.round(performance.now() - t0), url, detail: `فشل الاتصال: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}` };
  }
}
