import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ConnectionTestResult,
  CriticalFacility,
  District,
  EngineState,
  RoadSegment,
  RuleConfig,
  SegmentDirectionKey,
  SourceHealth,
  SpeedObservation,
  TrafficEvent,
  WeatherObservation,
  WeatherWarning,
} from '@ansiyab/core';
import { emptyEngineState } from '@ansiyab/core';

/**
 * مخزن النسخة الأولى: ذاكرة + ملفات JSON/JSONL في DATA_DIR.
 * الواجهة البرمجية (Repository) مصممة لتُستبدل بـ PostgreSQL/PostGIS (انظر db/schema.sql) دون تغيير الخدمات.
 */
export interface Network {
  regionId: string;
  builtAt: string;
  districts: District[];
  segments: RoadSegment[];
  facilities: CriticalFacility[];
  coverageNotesAr: string[];
}

export class Store {
  network: Network | null = null;
  speed = new Map<SegmentDirectionKey, SpeedObservation>();
  events: TrafficEvent[] = [];
  weatherCurrent: WeatherObservation[] = [];
  weatherHourly: WeatherObservation[] = [];
  warnings: WeatherWarning[] = [];
  health = new Map<string, SourceHealth>();
  probe = new Map<string, ConnectionTestResult>();
  engine: EngineState = emptyEngineState();
  ruleConfig: Record<string, RuleConfig> = {};
  /** إحصاءات جودة: آخر دورة TomTom */
  flowCycle: { requested: number; valid: number; noMatch: number; errors: number; at: string | null } = { requested: 0, valid: 0, noMatch: 0, errors: 0, at: null };
  /** سجل تاريخي في الذاكرة لآخر 7 أيام (يُحمّل من الملفات عند البدء) */
  speedHistory: SpeedObservation[] = [];

  constructor(public readonly dir: string) {
    mkdirSync(join(dir, 'history'), { recursive: true });
    mkdirSync(join(dir, 'probe'), { recursive: true });
  }

  private p(name: string) {
    return join(this.dir, name);
  }
  private readJson<T>(name: string): T | null {
    try {
      return existsSync(this.p(name)) ? (JSON.parse(readFileSync(this.p(name), 'utf8')) as T) : null;
    } catch {
      return null;
    }
  }
  private writeJson(name: string, v: unknown) {
    writeFileSync(this.p(name), JSON.stringify(v));
  }

  load(regionId: string) {
    this.network = this.readJson<Network>(`network-${regionId}.json`);
    this.engine = this.readJson<EngineState>('alerts.json') ?? emptyEngineState();
    this.ruleConfig = this.readJson('rules.json') ?? {};
    for (const r of this.readJson<ConnectionTestResult[]>('source-status.json') ?? []) this.probe.set(r.sourceId, r);
    const cutoff = Date.now() - 7 * 86400e3;
    for (const f of readdirSync(join(this.dir, 'history')).filter((x) => x.startsWith('speed-')).sort()) {
      for (const line of readFileSync(join(this.dir, 'history', f), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const o = JSON.parse(line) as SpeedObservation;
          if (new Date(o.observedAt).getTime() >= cutoff) this.speedHistory.push(o);
        } catch {
          /* سطر تالف */
        }
      }
    }
  }

  saveNetwork(n: Network) {
    this.network = n;
    this.writeJson(`network-${n.regionId}.json`, n);
  }
  saveAlerts() {
    this.writeJson('alerts.json', this.engine);
  }
  saveRules() {
    this.writeJson('rules.json', this.ruleConfig);
  }
  saveProbe(results: ConnectionTestResult[]) {
    for (const r of results) this.probe.set(r.sourceId, r);
    this.writeJson('source-status.json', [...this.probe.values()]);
  }

  /** يضيف قراءات سرعة: الحالة الحالية + السجل التاريخي (ملف يومي JSONL) */
  addSpeed(obs: SpeedObservation[]) {
    if (!obs.length) return;
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(this.dir, 'history', `speed-${day}.jsonl`), obs.map((o) => JSON.stringify(o)).join('\n') + '\n');
    for (const o of obs) this.speed.set(o.segmentKey, o);
    this.speedHistory.push(...obs);
    const cutoff = Date.now() - 7 * 86400e3;
    if (this.speedHistory.length > 200000) this.speedHistory = this.speedHistory.filter((o) => new Date(o.observedAt).getTime() >= cutoff);
  }

  appendEventLog(events: TrafficEvent[]) {
    if (!events.length) return;
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(this.dir, 'history', `events-${day}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  audit(entry: Record<string, unknown>) {
    appendFileSync(this.p('audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  }

  /** حالة السرعات كما كانت عند وقت محدد (للشريط الزمني): آخر قراءة ≤ at وضمن أقصى عمر */
  speedAt(at: Date, maxAgeS: number): Map<SegmentDirectionKey, SpeedObservation> {
    const out = new Map<SegmentDirectionKey, SpeedObservation>();
    const t = at.getTime();
    for (const o of this.speedHistory) {
      const ot = new Date(o.observedAt).getTime();
      if (ot > t || t - ot > maxAgeS * 1000) continue;
      const prev = out.get(o.segmentKey);
      if (!prev || new Date(prev.observedAt).getTime() < ot) out.set(o.segmentKey, { ...o, provenance: 'historical' });
    }
    return out;
  }

  historyRange(): { from: string | null; to: string | null; observations: number } {
    if (!this.speedHistory.length) return { from: null, to: null, observations: 0 };
    let a = Infinity, b = -Infinity;
    for (const o of this.speedHistory) {
      const t = new Date(o.observedAt).getTime();
      if (t < a) a = t;
      if (t > b) b = t;
    }
    return { from: new Date(a).toISOString(), to: new Date(b).toISOString(), observations: this.speedHistory.length };
  }

  markSuccess(sourceId: string, maxAgeS: number) {
    const h = this.health.get(sourceId) ?? { sourceId, enabled: true, lastSuccessAt: null, lastErrorAt: null, lastError: null, maxAgeS };
    this.health.set(sourceId, { ...h, enabled: true, lastSuccessAt: new Date().toISOString(), maxAgeS });
  }
  markError(sourceId: string, maxAgeS: number, err: string) {
    const h = this.health.get(sourceId) ?? { sourceId, enabled: true, lastSuccessAt: null, lastErrorAt: null, lastError: null, maxAgeS };
    this.health.set(sourceId, { ...h, enabled: true, lastErrorAt: new Date().toISOString(), lastError: err.slice(0, 200), maxAgeS });
  }
}
