import type {
  Alert,
  ColorScale,
  ConnectionTestResult,
  CriticalFacility,
  District,
  DistrictSummary,
  IndicatorDef,
  IndicatorValue,
  Region,
  RoadSegment,
  RouteAssessment,
  RouteCandidate,
  RuleConfig,
  RuleParamSpec,
  RuleStatus,
  SourceDescriptor,
  SourceHealth,
  SpeedObservation,
  TrafficEvent,
  WeatherObservation,
  WeatherWarning,
} from '@ansiyab/core';

export interface SourceView extends Omit<SourceDescriptor, 'maxAgeS'> {
  maxAgeS: number | null;
  effectiveClassification: string;
  effectiveClassificationAr: string;
  connectionTest: ConnectionTestResult | null;
  health: SourceHealth | null;
}

export interface Meta {
  config: { mode: 'live' | 'simulation'; regionId: string; tomtomConfigured: boolean; tomtomRasterTiles: boolean; ncmConfigured: boolean; hereConfigured: boolean; adminConfigured: boolean };
  region: Region;
  simulationBannerAr: string | null;
  sources: SourceView[];
  scales: { sri: ColorScale; density: ColorScale };
  indicators: IndicatorDef[];
  rules: { id: string; titleAr: string; descriptionAr: string; params: RuleParamSpec[]; requiresAr: string; config: RuleConfig }[];
  ruleStatuses: RuleStatus[];
  intervalsMin: Record<string, number>;
  sampleDistrictIds: string[];
  history: { from: string | null; to: string | null; observations: number };
  flowCycle: { requested: number; valid: number; noMatch: number; errors: number; at: string | null };
  networkNotesAr: string[];
  networkBuiltAt: string | null;
  policy: { maxAgeS: number };
}

export interface Network {
  regionId: string;
  builtAt: string;
  districts: District[];
  segments: RoadSegment[];
  facilities: CriticalFacility[];
  coverageNotesAr: string[];
}

export interface StateSnapshot {
  at: string;
  temporal: 'current' | 'historical';
  speed: SpeedObservation[];
  events: TrafficEvent[];
  weather: WeatherObservation[];
  warnings: WeatherWarning[];
  sourcesHealth: SourceHealth[];
}

export interface RouteResponse {
  engine: string;
  routes: RouteCandidate[];
  assessments: RouteAssessment[];
}

export interface GeocodeHit {
  displayName: string;
  point: [number, number];
  category: string;
  type: string;
}

export type { DistrictSummary, Alert, IndicatorValue };

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

const adminHeaders = (): Record<string, string> => {
  let t = '';
  try {
    t = sessionStorage.getItem('ansiyab.adminToken') ?? '';
  } catch {
    /* التخزين غير متاح */
  }
  return t ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
};

export const api = {
  meta: () => j<Meta>('/api/meta'),
  network: () => j<Network>('/api/network'),
  state: (at?: string) => j<StateSnapshot>(`/api/state${at ? `?at=${encodeURIComponent(at)}` : ''}`),
  districts: (ids: string[], at?: string) => j<DistrictSummary[]>(`/api/districts/summary?ids=${ids.map(encodeURIComponent).join(',')}${at ? `&at=${encodeURIComponent(at)}` : ''}`),
  alerts: () => j<{ alerts: Alert[]; statuses: RuleStatus[] }>('/api/alerts'),
  alertAction: (id: string, body: { action: string; note?: string; outcome?: string; actor?: string }) =>
    j<Alert>(`/api/alerts/${id}/action`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify(body) }),
  saveRules: (body: Record<string, Partial<RuleConfig>>) => j<Record<string, RuleConfig>>('/api/rules', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify(body) }),
  route: (from: [number, number], to: [number, number]) => j<RouteResponse>(`/api/route?from=${from.join(',')}&to=${to.join(',')}`),
  geocode: (q: string) => j<GeocodeHit[]>(`/api/geocode?q=${encodeURIComponent(q)}`),
  forecast: () => j<{ readiness: { ready: boolean; historyDays: number; requiredDays: number; reasonAr?: string }; horizonsMin: number[] }>('/api/forecast/status'),
  weatherHourly: () => j<WeatherObservation[]>('/api/weather/hourly'),
  probe: () => j<ConnectionTestResult[]>('/api/probe', { method: 'POST', headers: adminHeaders() }),
};
