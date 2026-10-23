import { describe, expect, it } from 'vitest';
import { evaluateAlerts, emptyEngineState, applyAction, RULES, defaultRuleConfig, type AlertContext, type RoadSegment, type SpeedObservation, type TrafficEvent, type SegmentDirectionKey } from '../src/index.ts';

const gw: RoadSegment = { id: 'g', regionId: 'riyadh', nameAr: 'طريق المدخل', roadClass: 'primary', directions: ['fwd'],
  geometry: { type: 'LineString', coordinates: [[46.68, 24.69], [46.68, 24.70]] }, lengthM: 1100, districtIds: ['d1'], isDistrictGateway: true, sourceId: 'osm', sourceRef: '' };

function ctx(t: string, speed: number | null, extra: Partial<AlertContext> = {}): AlertContext {
  const m = new Map<SegmentDirectionKey, SpeedObservation>();
  if (speed !== null) m.set('g:fwd', { segmentKey: 'g:fwd', sourceId: 'tomtom-flow', observedAt: t, receivedAt: t, provenance: 'live',
    currentSpeedKmh: speed, freeFlowSpeedKmh: 60, currentTravelTimeS: 1, freeFlowTravelTimeS: 1, confidence: 0.9, roadClosure: false });
  return { now: new Date(t), policy: { maxAgeS: 900 }, segments: new Map([['g', gw]]), speed: m, flow: new Map(), events: [], weather: [], warnings: [], water: [],
    facilities: [], sources: [], districtName: () => 'العليا', ...extra };
}
const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 17, 0) + min * 60e3).toISOString();

describe('محرك التنبيهات', () => {
  it('لا يُطلق قبل مدة الاستمرار (10 د)، ثم يُطلق مرة واحدة', () => {
    let s = emptyEngineState();
    let r = evaluateAlerts(s, ctx(at(0), 15)); s = r.state;      // SRI 75
    expect(r.opened).toHaveLength(0);
    r = evaluateAlerts(s, ctx(at(5), 15)); s = r.state;
    expect(r.opened).toHaveLength(0);
    r = evaluateAlerts(s, ctx(at(10), 15)); s = r.state;
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]).toMatchObject({ ruleId: 'gateway_congestion', status: 'open', confidence: 'high' });
    r = evaluateAlerts(s, ctx(at(15), 15)); s = r.state;
    expect(r.opened).toHaveLength(0);
    expect(s.alerts.filter((a) => a.status !== 'resolved')).toHaveLength(1);
  });
  it('التذبذب حول العتبة لا يُنشئ تنبيهات متكررة (تخلف + استمرار)', () => {
    let s = emptyEngineState();
    // يتأرجح بين 61 و58 كل 5 دقائق: 58 ضمن «hold» (≥50)
    const speeds = [23, 25, 23, 25, 23, 25, 23, 25];
    let opened = 0;
    speeds.forEach((v, i) => { const r = evaluateAlerts(s, ctx(at(i * 5), v)); s = r.state; opened += r.opened.length; });
    expect(opened).toBe(1);
  });
  it('شرط متقطع تحت مدة الاستمرار لا يُطلق', () => {
    let s = emptyEngineState();
    const speeds = [15, 40, 15, 40, 15, 40]; // 75 ثم 33 (تحت الخروج)
    let opened = 0;
    speeds.forEach((v, i) => { const r = evaluateAlerts(s, ctx(at(i * 5), v)); s = r.state; opened += r.opened.length; });
    expect(opened).toBe(0);
  });
  it('يُغلق تلقائيًا بعد غياب الشرط 10 د ويُسجل ذلك، ويحترم فترة التهدئة', () => {
    let s = emptyEngineState();
    for (const m of [0, 10]) s = evaluateAlerts(s, ctx(at(m), 15)).state;
    let r = evaluateAlerts(s, ctx(at(15), 55)); s = r.state;  // SRI 8
    expect(r.resolved).toHaveLength(0);
    r = evaluateAlerts(s, ctx(at(25), 55)); s = r.state;
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]!.log.at(-1)!.action).toBe('auto_resolve');
    // عودة الشرط خلال التهدئة (15 د) لا تفتح تنبيهًا
    for (const m of [30, 40]) { r = evaluateAlerts(s, ctx(at(m), 15)); s = r.state; expect(r.opened).toHaveLength(0); }
  });
  it('الإقرار والإغلاق اليدوي مع سجل الإجراء والنتيجة', () => {
    let s = emptyEngineState();
    for (const m of [0, 10]) s = evaluateAlerts(s, ctx(at(m), 15)).state;
    const id = s.alerts[0]!.id;
    s = applyAction(s, id, { actor: 'مشغل', action: 'acknowledge', note: 'تم إبلاغ الدورية' });
    expect(s.alerts[0]!.status).toBe('acknowledged');
    s = applyAction(s, id, { actor: 'مشغل', action: 'resolve', outcome: 'تأكد ميدانيًا: حادث بسيط أزيل' });
    expect(s.alerts[0]!.status).toBe('resolved');
    expect(s.alerts[0]!.log.map((l) => l.action)).toEqual(['acknowledge', 'resolve']);
  });
  it('قاعدة الطوابير غير قابلة للتقييم بلا قياسات، مع السبب', () => {
    const r = evaluateAlerts(emptyEngineState(), ctx(at(0), 15));
    const q = r.statuses.find((x) => x.ruleId === 'queue_spillback')!;
    expect(q.evaluable).toBe(false);
    expect(q.reasonAr).toContain('طوابير');
  });
  it('حادث مع انخفاض السرعة يُطلق فورًا، وبلاغ السيول من المزود بثقة منخفضة', () => {
    const ev = (id: string, type: TrafficEvent['type']): TrafficEvent => ({ id, sourceId: 'tomtom-incidents', externalId: id, type, severity: 'moderate',
      geometry: { type: 'Point', coordinates: [46.68, 24.695] }, startTime: null, endTime: null, lastReportTime: null, receivedAt: at(0), verification: 'provider_reported',
      delayS: 200, lengthM: 100, lanesAffected: null, isClosure: false, segmentKeys: ['g:fwd'], districtIds: ['d1'], provenance: 'live' });
    const r = evaluateAlerts(emptyEngineState(), ctx(at(0), 30, { events: [ev('a1', 'accident'), ev('f1', 'flooding')] }));
    expect(r.opened.find((a) => a.ruleId === 'incident_speed_drop')).toBeTruthy();
    expect(r.opened.find((a) => a.ruleId === 'water_on_road')!.confidence).toBe('low');
  });
  it('إغلاق قرب مستشفى: ثقة منخفضة لأن القرب لا يثبت تعطل الوصول', () => {
    const closure: TrafficEvent = { id: 'c', sourceId: 'tomtom-incidents', externalId: 'c', type: 'road_closure', severity: 'critical', geometry: { type: 'Point', coordinates: [46.68, 24.695] },
      startTime: null, endTime: null, lastReportTime: null, receivedAt: at(0), verification: 'provider_reported', delayS: null, lengthM: null, lanesAffected: null, isClosure: true, segmentKeys: [], districtIds: [], provenance: 'live' };
    const r = evaluateAlerts(emptyEngineState(), ctx(at(0), null, { events: [closure], facilities: [{ id: 'h', kind: 'hospital', nameAr: 'مستشفى', point: [46.685, 24.695], sourceId: 'osm' }] }));
    const a = r.opened.find((x) => x.ruleId === 'closure_critical_facility')!;
    expect(a.confidence).toBe('low');
    expect(a.suggestedActionAr).toContain('للجهة المخولة');
  });
  it('تقادم مصدر مفعّل يُطلق تنبيهًا', () => {
    const r = evaluateAlerts(emptyEngineState(), ctx(at(60), null, { sources: [{ sourceId: 'tomtom-flow', enabled: true, lastSuccessAt: at(0), lastErrorAt: at(55), lastError: 'HTTP 403', maxAgeS: 900 }] }));
    expect(r.opened.find((a) => a.ruleId === 'source_stale')!.reasonAr).toContain('403');
  });
  it('تعطيل قاعدة عبر الإعدادات', () => {
    const cfg = Object.fromEntries(RULES.map((x) => [x.id, { ...defaultRuleConfig(x), enabled: x.id !== 'gateway_congestion', persistenceS: 0 }]));
    const r = evaluateAlerts(emptyEngineState(), ctx(at(0), 5), cfg);
    expect(r.opened.find((a) => a.ruleId === 'gateway_congestion')).toBeUndefined();
  });
});
