import {
  applyAction,
  assessRoutes,
  CLASSIFICATION_AR,
  defaultRuleConfig,
  effectiveClassification,
  forecastReadiness,
  INDICATORS,
  nominatim,
  osrm,
  RULES,
  SIMULATION_BANNER_AR,
  SOURCES,
  summarizeDistrict,
  speedReductionIndex,
  DENSITY_SCALE,
  SRI_SCALE,
  type LngLat,
  type RuleConfig,
} from '@ansiyab/core';
import { config, publicConfig } from './config.ts';
import { policy, type Ingestor } from './ingest.ts';
import { runProbe } from './probe.ts';
import type { Store } from './store.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

const parseLngLat = (s: string | null): LngLat => {
  const [a, b] = (s ?? '').split(',').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new HttpError(400, 'إحداثيات غير صالحة (lng,lat)');
  return [a!, b!];
};

const geocodeCache = new Map<string, { at: number; v: unknown }>();
let lastGeocode = 0;

function requireAdmin(req: Req) {
  if (!config.adminToken) throw new HttpError(403, 'ADMIN_TOKEN غير مضبوط في الخادم؛ الإجراءات المعدِّلة معطلة');
  if (req.headers.authorization !== `Bearer ${config.adminToken}`) throw new HttpError(401, 'رمز الإدارة غير صحيح');
}

export function createApi(store: Store, ing: Ingestor) {
  const fetcher = (u: string, i?: RequestInit) => fetch(u, { ...i, headers: { 'User-Agent': 'Ansiyab/0.1 (traffic decision-support prototype)', ...(i?.headers ?? {}) } });

  const sourcesView = () => {
    const now = new Date();
    return SOURCES.map((s) => {
      const test = store.probe.get(s.id);
      const health = store.health.get(s.id);
      const cls = effectiveClassification(s, test, now);
      return { ...s, maxAgeS: Number.isFinite(s.maxAgeS) ? s.maxAgeS : null, effectiveClassification: cls, effectiveClassificationAr: CLASSIFICATION_AR[cls], connectionTest: test ?? null, health: health ?? null };
    });
  };

  const snapshot = (at: Date | null) => {
    const now = at ?? new Date();
    const historical = !!at && Math.abs(Date.now() - at.getTime()) > 60e3;
    const speed = historical ? store.speedAt(now, policy.maxAgeS) : store.speed;
    return { now, historical, speed };
  };

  return async function handle(req: Req): Promise<unknown> {
    const { method, path, query } = req;
    if (method === 'GET' && path === '/api/health') return { ok: true, mode: config.mode, time: new Date().toISOString() };

    if (method === 'GET' && path === '/api/meta') {
      return {
        config: publicConfig(),
        region: ing.region,
        simulationBannerAr: config.mode === 'simulation' ? SIMULATION_BANNER_AR : null,
        sources: sourcesView(),
        scales: { sri: SRI_SCALE, density: DENSITY_SCALE },
        indicators: INDICATORS,
        rules: RULES.map((r) => ({ id: r.id, titleAr: r.titleAr, descriptionAr: r.descriptionAr, params: r.params, requiresAr: r.requiresAr, config: store.ruleConfig[r.id] ?? defaultRuleConfig(r) })),
        ruleStatuses: ing.lastStatuses,
        intervalsMin: ing.intervals,
        sampleDistrictIds: [...ing.sampleDistrictIds],
        history: store.historyRange(),
        flowCycle: store.flowCycle,
        networkNotesAr: store.network?.coverageNotesAr ?? [],
        networkBuiltAt: store.network?.builtAt ?? null,
        policy,
      };
    }

    if (method === 'GET' && path === '/api/network') {
      const n = store.network;
      if (!n) throw new HttpError(503, 'لم تُبنَ قاعدة الطرق والأحياء بعد (تحقق من الاتصال بـ Overpass)');
      return n;
    }

    if (method === 'GET' && path === '/api/state') {
      const at = query.get('at') ? new Date(query.get('at')!) : null;
      if (at && Number.isNaN(at.getTime())) throw new HttpError(400, 'وقت غير صالح');
      const { now, historical, speed } = snapshot(at);
      const weatherHourly = store.weatherHourly.filter((w) => Math.abs(new Date(w.validAt).getTime() - now.getTime()) <= 30 * 60e3);
      return {
        at: now.toISOString(),
        temporal: historical ? 'historical' : 'current',
        speed: [...speed.values()],
        // الأحداث والطقس الحالي متاحة للحاضر فقط؛ وللماضي نعرض طقس الساعة المؤرشفة من Open-Meteo
        events: historical ? [] : store.events,
        weather: historical ? weatherHourly : store.weatherCurrent,
        warnings: historical ? [] : store.warnings,
        sourcesHealth: [...store.health.values()],
      };
    }

    if (method === 'GET' && path === '/api/weather/hourly') return store.weatherHourly;

    if (method === 'GET' && path === '/api/districts/summary') {
      const n = store.network;
      if (!n) throw new HttpError(503, 'لا توجد قاعدة أحياء');
      const at = query.get('at') ? new Date(query.get('at')!) : null;
      const { now, speed } = snapshot(at);
      const ids = query.get('ids')?.split(',').filter(Boolean) ?? [...ing.sampleDistrictIds];
      return ids
        .map((id) => n.districts.find((d) => d.id === id))
        .filter((d) => !!d)
        .map((d) =>
          summarizeDistrict({
            district: d!,
            segments: n.segments,
            obs: speed,
            events: store.events,
            weather: store.weatherCurrent.find((w) => w.locationId === d!.id) ?? null,
            warnings: store.warnings,
            now,
            policy,
            baselineSri: baselineFor(store, d!.id, n.segments, now),
          }),
        );
    }

    if (method === 'GET' && path === '/api/alerts') return { alerts: store.engine.alerts.slice(-500).reverse(), statuses: ing.lastStatuses };

    const m = path.match(/^\/api\/alerts\/([\w-]+)\/action$/);
    if (method === 'POST' && m) {
      requireAdmin(req);
      const b = (req.body ?? {}) as { action?: string; note?: string; outcome?: string; actor?: string };
      if (!['acknowledge', 'note', 'resolve', 'reopen'].includes(b.action ?? '')) throw new HttpError(400, 'إجراء غير معروف');
      const actor = (b.actor ?? 'مشغل').slice(0, 60);
      store.engine = applyAction(store.engine, m[1]!, { actor, action: b.action as 'acknowledge', note: b.note?.slice(0, 500), outcome: b.outcome?.slice(0, 500) });
      store.saveAlerts();
      store.audit({ type: 'alert_action', alertId: m[1], actor, action: b.action });
      return store.engine.alerts.find((a) => a.id === m[1]);
    }

    if (method === 'PUT' && path === '/api/rules') {
      requireAdmin(req);
      const b = req.body as Record<string, Partial<RuleConfig>>;
      for (const r of RULES) {
        if (!b?.[r.id]) continue;
        const cur = store.ruleConfig[r.id] ?? defaultRuleConfig(r);
        const inc = b[r.id]!;
        store.ruleConfig[r.id] = {
          enabled: typeof inc.enabled === 'boolean' ? inc.enabled : cur.enabled,
          params: { ...cur.params, ...Object.fromEntries(Object.entries(inc.params ?? {}).filter(([, v]) => Number.isFinite(v))) },
          persistenceS: Number.isFinite(inc.persistenceS) ? inc.persistenceS! : cur.persistenceS,
          clearAfterS: Number.isFinite(inc.clearAfterS) ? inc.clearAfterS! : cur.clearAfterS,
          cooldownS: Number.isFinite(inc.cooldownS) ? inc.cooldownS! : cur.cooldownS,
        };
      }
      store.saveRules();
      store.audit({ type: 'rules_update', rules: Object.keys(b ?? {}) });
      return store.ruleConfig;
    }

    if (method === 'GET' && path === '/api/route') {
      const from = parseLngLat(query.get('from'));
      const to = parseLngLat(query.get('to'));
      if (config.mode === 'simulation') throw new HttpError(409, 'التوجيه معطل في وضع المحاكاة لأن الشبكة اصطناعية');
      const routes = await osrm.fetchRoutes(fetcher, from, to, config.osrmBase);
      store.markSuccess('osrm-demo', Infinity);
      const cands = routes.map((r, i) => ({ id: `r${i + 1}`, geometry: r.geometry, distanceM: r.distance, engineDurationS: r.duration, engineId: 'osrm-demo' }));
      return { engine: 'osrm-demo', routes: cands, assessments: assessRoutes(cands, { index: ing.segmentIndex, speed: store.speed, events: store.events, water: [], now: new Date(), policy }) };
    }

    if (method === 'GET' && path === '/api/geocode') {
      const q = (query.get('q') ?? '').trim();
      if (q.length < 2) throw new HttpError(400, 'نص البحث قصير');
      const hit = geocodeCache.get(q);
      if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.v;
      // سياسة Nominatim: طلب واحد في الثانية كحد أقصى
      const wait = 1100 - (Date.now() - lastGeocode);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastGeocode = Date.now();
      const v = await nominatim.geocode(fetcher, q, ing.region.bbox);
      store.markSuccess('nominatim', Infinity);
      geocodeCache.set(q, { at: Date.now(), v });
      return v;
    }

    if (method === 'GET' && path === '/api/forecast/status') {
      const series = store.speedHistory.map((o) => ({ t: new Date(o.observedAt).getTime(), v: speedReductionIndex(o.currentSpeedKmh, o.freeFlowSpeedKmh) })).filter((x) => x.v.available);
      series.sort((a, b) => a.t - b.t);
      return { readiness: forecastReadiness(series.map((x) => ({ t: x.t, v: (x.v as { value: number }).value }))), horizonsMin: [15, 30, 60] };
    }

    if (method === 'POST' && path === '/api/probe') {
      requireAdmin(req);
      const r = await runProbe(store.dir);
      store.saveProbe(r);
      return r;
    }

    throw new HttpError(404, 'غير موجود');
  };
}

/** خط أساس الحي: متوسط SRI لنفس يوم الأسبوع وساعة اليوم في الأسابيع السابقة (≥ 2 أسبوع)، وإلا null */
function baselineFor(store: Store, districtId: string, segments: { id: string; districtIds: string[]; lengthM: number }[], now: Date): number | null {
  const segIds = new Set(segments.filter((s) => s.districtIds.includes(districtId)).map((s) => s.id));
  const vals: number[] = [];
  const weeks = new Set<number>();
  for (const o of store.speedHistory) {
    const t = new Date(o.observedAt);
    const dt = now.getTime() - t.getTime();
    if (dt < 6 * 86400e3) continue;
    if (t.getUTCDay() !== now.getUTCDay() || t.getUTCHours() !== now.getUTCHours()) continue;
    if (!segIds.has(o.segmentKey.slice(0, o.segmentKey.lastIndexOf(':')))) continue;
    const s = speedReductionIndex(o.currentSpeedKmh, o.freeFlowSpeedKmh);
    if (!s.available) continue;
    vals.push(s.value);
    weeks.add(Math.floor(dt / (7 * 86400e3)));
  }
  return weeks.size >= 2 && vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
