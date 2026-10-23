import type {
  Confidence,
  CriticalFacility,
  FlowObservation,
  LineString,
  Point,
  RoadSegment,
  SegmentDirectionKey,
  Severity,
  SpeedObservation,
  TrafficEvent,
  WaterObservation,
  WeatherObservation,
  WeatherWarning,
} from '../domain/types.ts';
import { parseSegmentKey, segmentKey } from '../domain/types.ts';
import { haversineM } from '../geo/geo.ts';
import { segmentSpeedIndicators, type FreshnessPolicy } from '../indicators/traffic.ts';

export interface SourceHealth {
  sourceId: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  maxAgeS: number;
}

export interface AlertContext {
  now: Date;
  policy: FreshnessPolicy;
  segments: Map<string, RoadSegment>;
  speed: Map<SegmentDirectionKey, SpeedObservation>;
  flow: Map<SegmentDirectionKey, FlowObservation>;
  events: TrafficEvent[];
  weather: WeatherObservation[];
  warnings: WeatherWarning[];
  water: WaterObservation[];
  facilities: CriticalFacility[];
  sources: SourceHealth[];
  districtName: (id: string) => string | undefined;
}

export type CandidateLevel = 'enter' | 'hold';

export interface AlertCandidate {
  ruleId: string;
  dedupeKey: string;
  level: CandidateLevel;
  severity: Severity;
  reasonAr: string;
  locationAr: string;
  geometry: Point | LineString | null;
  districtIds: string[];
  sourceIds: string[];
  confidence: Confidence;
  suggestedActionAr: string;
  evidence: Record<string, unknown>;
}

export interface RuleParamSpec {
  key: string;
  labelAr: string;
  unit: string;
  default: number;
}

export interface AlertRule {
  id: string;
  titleAr: string;
  descriptionAr: string;
  params: RuleParamSpec[];
  /** مدة استمرار الشرط قبل إطلاق التنبيه (ثوانٍ) لمنع التذبذب */
  defaultPersistenceS: number;
  /** مدة غياب الشرط قبل الإغلاق التلقائي (ثوانٍ) */
  defaultClearAfterS: number;
  /** البيانات اللازمة؛ تُستخدم لإظهار «غير قابلة للتقييم» بصدق */
  requiresAr: string;
  canEvaluate: (ctx: AlertContext) => { ok: boolean; reasonAr?: string };
  evaluate: (ctx: AlertContext, p: Record<string, number>) => AlertCandidate[];
}

const segLabel = (s: RoadSegment, dir: string) =>
  `${s.nameAr ?? s.nameEn ?? s.ref ?? 'طريق بلا اسم'} (${dir === 'fwd' ? 'اتجاه الرسم' : 'الاتجاه المعاكس'})`;
const confFromProvider = (c: number | null | undefined): Confidence => (c == null ? 'low' : c >= 0.8 ? 'high' : c >= 0.5 ? 'medium' : 'low');

export const RULES: AlertRule[] = [
  {
    id: 'gateway_congestion',
    titleAr: 'ازدحام مرتفع مستمر عند مدخل/مخرج حي',
    descriptionAr: 'مقطع يعبر حدود حي ومؤشر انخفاض السرعة فيه فوق العتبة لمدة متصلة.',
    params: [
      { key: 'enter', labelAr: 'عتبة الإطلاق', unit: 'SRI', default: 60 },
      { key: 'exit', labelAr: 'عتبة الإغلاق (تخلف)', unit: 'SRI', default: 50 },
    ],
    defaultPersistenceS: 10 * 60,
    defaultClearAfterS: 10 * 60,
    requiresAr: 'قراءات سرعة حية + حدود أحياء مضلعة',
    canEvaluate: (ctx) => (ctx.speed.size ? { ok: true } : { ok: false, reasonAr: 'لا يوجد مصدر سرعات متصل' }),
    evaluate: (ctx, p) => {
      const out: AlertCandidate[] = [];
      for (const [key, obs] of ctx.speed) {
        const { segmentId, direction } = parseSegmentKey(key);
        const s = ctx.segments.get(segmentId);
        if (!s?.isDistrictGateway) continue;
        const i = segmentSpeedIndicators(obs, ctx.now, ctx.policy);
        if (!i.sri.available) continue;
        const v = i.sri.value;
        const level: CandidateLevel | null = v >= p.enter! ? 'enter' : v >= p.exit! ? 'hold' : null;
        if (!level) continue;
        const names = s.districtIds.map(ctx.districtName).filter(Boolean).join('، ');
        out.push({
          ruleId: 'gateway_congestion',
          dedupeKey: `gateway_congestion:${key}`,
          level,
          severity: v >= 80 ? 'high' : 'moderate',
          reasonAr: `مؤشر انخفاض السرعة ${v.toFixed(0)} (السرعة ${obs.currentSpeedKmh} من ${obs.freeFlowSpeedKmh} كم/س)`,
          locationAr: `${segLabel(s, direction)}، مدخل/مخرج ${names || 'حي'}`,
          geometry: s.geometry,
          districtIds: s.districtIds,
          sourceIds: [obs.sourceId],
          confidence: confFromProvider(obs.confidence),
          suggestedActionAr: 'تقييم مدخل بديل للحي، ومراجعة توقيت الإشارة الأقرب، وإعطاء أولوية للتحقق الميداني إن استمر أكثر من 30 دقيقة.',
          evidence: { sri: v, speed: obs.currentSpeedKmh, freeFlow: obs.freeFlowSpeedKmh, observedAt: obs.observedAt, confidence: obs.confidence },
        });
      }
      return out;
    },
  },
  {
    id: 'queue_spillback',
    titleAr: 'طابور يقترب من تقاطع مجاور',
    descriptionAr: 'طول الطابور المقاس يتجاوز نسبة من طول المقطع حتى التقاطع السابق.',
    params: [{ key: 'ratio', labelAr: 'نسبة طول الطابور إلى المقطع', unit: '%', default: 80 }],
    defaultPersistenceS: 5 * 60,
    defaultClearAfterS: 5 * 60,
    requiresAr: 'قياسات طوابير من حساسات/كاميرات الإشارات (لا تُستنتج من السرعة)',
    canEvaluate: (ctx) =>
      [...ctx.flow.values()].some((f) => f.queueLengthM != null) ? { ok: true } : { ok: false, reasonAr: 'لا توجد قياسات طوابير من أي مصدر متصل' },
    evaluate: (ctx, p) => {
      const out: AlertCandidate[] = [];
      for (const [key, f] of ctx.flow) {
        if (f.queueLengthM == null) continue;
        const s = ctx.segments.get(parseSegmentKey(key).segmentId);
        if (!s) continue;
        const r = (f.queueLengthM / s.lengthM) * 100;
        if (r < p.ratio! * 0.85) continue;
        out.push({
          ruleId: 'queue_spillback',
          dedupeKey: `queue_spillback:${key}`,
          level: r >= p.ratio! ? 'enter' : 'hold',
          severity: r >= 100 ? 'high' : 'moderate',
          reasonAr: `طول الطابور ${f.queueLengthM.toFixed(0)} م (${r.toFixed(0)}% من المقطع)`,
          locationAr: segLabel(s, parseSegmentKey(key).direction),
          geometry: s.geometry,
          districtIds: s.districtIds,
          sourceIds: [f.sourceId],
          confidence: 'medium',
          suggestedActionAr: 'مراجعة توزيع زمن الأخضر عند التقاطع المصب للتحقق من منع امتداد الطابور إلى التقاطع السابق.',
          evidence: { queueLengthM: f.queueLengthM, segmentLengthM: s.lengthM },
        });
      }
      return out;
    },
  },
  {
    id: 'incident_speed_drop',
    titleAr: 'حادث أو عطل مصحوب بانخفاض السرعة',
    descriptionAr: 'حدث نشط (حادث/مركبة معطلة) على مقطع مؤشره فوق العتبة.',
    params: [
      { key: 'enter', labelAr: 'عتبة المؤشر', unit: 'SRI', default: 40 },
      { key: 'exit', labelAr: 'عتبة الإغلاق', unit: 'SRI', default: 30 },
    ],
    defaultPersistenceS: 0,
    defaultClearAfterS: 10 * 60,
    requiresAr: 'مصدر حوادث + مصدر سرعات',
    canEvaluate: (ctx) => (ctx.speed.size ? { ok: true } : { ok: false, reasonAr: 'يتطلب مصدر سرعات متصلًا للتحقق من الأثر' }),
    evaluate: (ctx, p) => {
      const out: AlertCandidate[] = [];
      for (const e of ctx.events) {
        if (e.type !== 'accident' && e.type !== 'breakdown') continue;
        let worst: { key: SegmentDirectionKey; sri: number; obs: SpeedObservation } | null = null;
        for (const k of e.segmentKeys) {
          const obs = ctx.speed.get(k);
          const i = segmentSpeedIndicators(obs, ctx.now, ctx.policy);
          if (obs && i.sri.available && (!worst || i.sri.value > worst.sri)) worst = { key: k, sri: i.sri.value, obs };
        }
        if (!worst || worst.sri < p.exit!) continue;
        out.push({
          ruleId: 'incident_speed_drop',
          dedupeKey: `incident_speed_drop:${e.id}`,
          level: worst.sri >= p.enter! ? 'enter' : 'hold',
          severity: worst.sri >= 70 || e.severity === 'high' ? 'high' : 'moderate',
          reasonAr: `${e.descriptionAr ?? e.type} مع مؤشر انخفاض سرعة ${worst.sri.toFixed(0)}`,
          locationAr: [e.fromName, e.toName].filter(Boolean).join(' ← ') || 'موقع الحدث',
          geometry: e.geometry,
          districtIds: e.districtIds,
          sourceIds: [e.sourceId, worst.obs.sourceId],
          confidence: e.verification === 'verified' ? 'high' : 'medium',
          suggestedActionAr: 'إعطاء أولوية للتحقق الميداني من الحدث، وتقدير زمن الإزالة، وإبلاغ مستخدمي المداخل المتأثرة بمسار بديل.',
          evidence: { eventId: e.id, sri: worst.sri, delayS: e.delayS, verification: e.verification },
        });
      }
      return out;
    },
  },
  {
    id: 'closure_critical_facility',
    titleAr: 'إغلاق قد يؤثر على الوصول إلى مرفق حيوي',
    descriptionAr: 'إغلاق طريق مؤكد أو مبلّغ ضمن نطاق مسافة من مستشفى أو دفاع مدني أو شرطة.',
    params: [{ key: 'radiusM', labelAr: 'نصف القطر', unit: 'م', default: 1500 }],
    defaultPersistenceS: 0,
    defaultClearAfterS: 5 * 60,
    requiresAr: 'مصدر إغلاقات + مواقع المرافق (OSM)',
    canEvaluate: (ctx) =>
      ctx.facilities.length ? { ok: true } : { ok: false, reasonAr: 'لم تُحمّل مواقع المرافق الحيوية' },
    evaluate: (ctx, p) => {
      const out: AlertCandidate[] = [];
      for (const e of ctx.events.filter((x) => x.isClosure)) {
        const pts = e.geometry.type === 'Point' ? [e.geometry.coordinates] : e.geometry.coordinates;
        for (const f of ctx.facilities) {
          if (f.kind === 'clinic' || f.kind === 'school') continue;
          const d = Math.min(...pts.map((q) => haversineM(q, f.point)));
          if (d > p.radiusM!) continue;
          out.push({
            ruleId: 'closure_critical_facility',
            dedupeKey: `closure_critical_facility:${e.id}:${f.id}`,
            level: 'enter',
            severity: f.kind === 'hospital' ? 'high' : 'moderate',
            reasonAr: `إغلاق على بعد ${d.toFixed(0)} م من ${f.nameAr ?? f.kind}`,
            locationAr: f.nameAr ?? 'مرفق حيوي',
            geometry: { type: 'Point', coordinates: f.point },
            districtIds: e.districtIds,
            sourceIds: [e.sourceId, f.sourceId],
            // القرب لا يثبت تعطل الوصول: نحتاج تحليل شبكة للمداخل
            confidence: 'low',
            suggestedActionAr: 'التحقق من مداخل المرفق البديلة، والتنسيق مع الجهة المختصة لضمان مسار إسعاف. القرار التشغيلي للجهة المخولة.',
            evidence: { eventId: e.id, facilityId: f.id, distanceM: Math.round(d), verification: e.verification },
          });
        }
      }
      return out;
    },
  },
  {
    id: 'water_on_road',
    titleAr: 'تجمع مياه على طريق مستخدم',
    descriptionAr: 'تجمع مياه مؤكد من جهة مختصة، أو بلاغ سيول من مزود المرور (يُعرض بثقة أقل).',
    params: [{ key: 'minDepthCm', labelAr: 'أدنى عمق للإطلاق عند القياس', unit: 'سم', default: 10 }],
    defaultPersistenceS: 0,
    defaultClearAfterS: 30 * 60,
    requiresAr: 'حساسات مياه أو بلاغات مؤكدة؛ أو أحداث «سيول» من مزود المرور',
    canEvaluate: (ctx) =>
      ctx.water.length || ctx.events.some((e) => e.type === 'flooding') ? { ok: true } : { ok: false, reasonAr: 'لا يوجد مصدر غمر متصل؛ وغياب البلاغ لا يعني سلامة الطريق' },
    evaluate: (ctx, p) => {
      const out: AlertCandidate[] = [];
      for (const w of ctx.water) {
        if (w.verification !== 'verified') continue;
        if (w.depthCm != null && w.depthCm < p.minDepthCm! && !w.causesClosure) continue;
        out.push({
          ruleId: 'water_on_road',
          dedupeKey: `water_on_road:${w.id}`,
          level: 'enter',
          severity: w.causesClosure || (w.depthCm ?? 0) >= 30 ? 'critical' : 'high',
          reasonAr: `تجمع مياه مؤكد${w.depthCm != null ? ` بعمق ${w.depthCm} سم` : ' (العمق غير مقاس)'}`,
          locationAr: 'موقع التجمع',
          geometry: { type: 'Point', coordinates: w.point },
          districtIds: [],
          sourceIds: [w.sourceId],
          confidence: 'high',
          suggestedActionAr: 'استبعاد المقطع من المسارات المقترحة وتوجيه فرق الصرف. قرار الإغلاق للجهة المخولة.',
          evidence: { depthCm: w.depthCm, observedAt: w.observedAt },
        });
      }
      for (const e of ctx.events.filter((x) => x.type === 'flooding')) {
        out.push({
          ruleId: 'water_on_road',
          dedupeKey: `water_on_road:${e.id}`,
          level: 'enter',
          severity: 'high',
          reasonAr: `بلاغ سيول/تجمع مياه من ${e.sourceId} (غير متحقق رسميًا)`,
          locationAr: [e.fromName, e.toName].filter(Boolean).join(' ← ') || 'موقع البلاغ',
          geometry: e.geometry,
          districtIds: e.districtIds,
          sourceIds: [e.sourceId],
          confidence: 'low',
          suggestedActionAr: 'إعطاء أولوية للتحقق الميداني قبل أي تحويل.',
          evidence: { eventId: e.id, verification: e.verification },
        });
      }
      return out;
    },
  },
  {
    id: 'adverse_weather',
    titleAr: 'ظروف جوية تؤثر على الرؤية والحركة',
    descriptionAr: 'رؤية منخفضة أو هبات رياح قوية أو هطول غزير (قيم نموذجية لخلية شبكية)، أو إنذار رسمي ساري.',
    params: [
      { key: 'visibilityM', labelAr: 'رؤية أقل من', unit: 'م', default: 1000 },
      { key: 'gustKmh', labelAr: 'هبات أعلى من', unit: 'كم/س', default: 60 },
      { key: 'rainMmH', labelAr: 'هطول أعلى من', unit: 'مم/س', default: 10 },
    ],
    defaultPersistenceS: 0,
    defaultClearAfterS: 60 * 60,
    requiresAr: 'Open-Meteo (نموذج) أو إنذارات المركز الوطني للأرصاد',
    canEvaluate: (ctx) => (ctx.weather.length || ctx.warnings.length ? { ok: true } : { ok: false, reasonAr: 'لا توجد قراءات طقس' }),
    evaluate: (ctx, p) => {
      const out: AlertCandidate[] = [];
      for (const w of ctx.weather.filter((x) => x.kind === 'current')) {
        const hits: string[] = [];
        let level: CandidateLevel | null = null;
        const bump = (l: CandidateLevel) => (level = level === 'enter' ? 'enter' : l);
        if (w.visibilityM != null && w.visibilityM < p.visibilityM! * 1.5) {
          hits.push(`رؤية ${w.visibilityM.toFixed(0)} م`);
          bump(w.visibilityM < p.visibilityM! ? 'enter' : 'hold');
        }
        if (w.windGustsKmh != null && w.windGustsKmh > p.gustKmh! * 0.85) {
          hits.push(`هبات ${w.windGustsKmh.toFixed(0)} كم/س`);
          bump(w.windGustsKmh > p.gustKmh! ? 'enter' : 'hold');
        }
        if (w.precipitationMm != null && w.precipitationMm > p.rainMmH! * 0.5) {
          hits.push(`هطول ${w.precipitationMm.toFixed(1)} مم/س`);
          bump(w.precipitationMm > p.rainMmH! ? 'enter' : 'hold');
        }
        if (!level) continue;
        out.push({
          ruleId: 'adverse_weather',
          dedupeKey: `adverse_weather:${w.locationId}`,
          level,
          severity: 'moderate',
          reasonAr: `${hits.join('، ')} (قيمة نموذجية بدقة نحو ${w.spatialResolutionKm ?? '?'} كم، وليست قياس محطة)`,
          locationAr: ctx.districtName(w.locationId) ?? w.locationId,
          geometry: { type: 'Point', coordinates: w.point },
          districtIds: [w.locationId],
          sourceIds: [w.sourceId],
          confidence: 'medium',
          suggestedActionAr: 'رفع الجاهزية ومراقبة السرعات على الطرق السريعة، والتحقق من الإنذارات الرسمية للمركز الوطني للأرصاد.',
          evidence: { visibilityM: w.visibilityM, gustKmh: w.windGustsKmh, precipitationMm: w.precipitationMm, observedAt: w.observedAt },
        });
      }
      for (const wr of ctx.warnings.filter((x) => new Date(x.from) <= ctx.now && new Date(x.to) >= ctx.now)) {
        out.push({
          ruleId: 'adverse_weather',
          dedupeKey: `adverse_weather:${wr.id}`,
          level: 'enter',
          severity: 'high',
          reasonAr: `إنذار رسمي: ${wr.titleAr} – ${wr.hazardsAr.join('، ')}`,
          locationAr: `${wr.regionAr}${wr.governoratesAr.length ? ' – ' + wr.governoratesAr.join('، ') : ''} (نطاق منطقة/محافظة)`,
          geometry: null,
          districtIds: [],
          sourceIds: [wr.sourceId],
          confidence: 'high',
          suggestedActionAr: wr.actionsAr.join('، ') || 'اتباع إرشادات المركز الوطني للأرصاد والدفاع المدني.',
          evidence: { from: wr.from, to: wr.to },
        });
      }
      return out;
    },
  },
  {
    id: 'source_stale',
    titleAr: 'تقادم بيانات مصدر أو انقطاعه',
    descriptionAr: 'مصدر مفعّل لم ينجح جلبه خلال أقصى عمر مسموح.',
    params: [],
    defaultPersistenceS: 0,
    defaultClearAfterS: 0,
    requiresAr: 'سجل صحة المصادر',
    canEvaluate: () => ({ ok: true }),
    evaluate: (ctx) => {
      const out: AlertCandidate[] = [];
      for (const s of ctx.sources.filter((x) => x.enabled)) {
        const age = s.lastSuccessAt ? (ctx.now.getTime() - new Date(s.lastSuccessAt).getTime()) / 1000 : Infinity;
        if (age <= s.maxAgeS) continue;
        out.push({
          ruleId: 'source_stale',
          dedupeKey: `source_stale:${s.sourceId}`,
          level: 'enter',
          severity: 'moderate',
          reasonAr: s.lastSuccessAt
            ? `آخر جلب ناجح قبل ${Math.round(age / 60)} دقيقة${s.lastError ? ` – آخر خطأ: ${s.lastError}` : ''}`
            : `لم ينجح أي جلب${s.lastError ? ` – ${s.lastError}` : ''}`,
          locationAr: s.sourceId,
          geometry: null,
          districtIds: [],
          sourceIds: [s.sourceId],
          confidence: 'high',
          suggestedActionAr: 'تُعرض طبقات هذا المصدر رمادية «غير معروف» حتى يعود. تحقق من المفتاح والحصة والشبكة.',
          evidence: { lastSuccessAt: s.lastSuccessAt, lastErrorAt: s.lastErrorAt },
        });
      }
      return out;
    },
  },
];

export const ruleDefaults = (r: AlertRule) => Object.fromEntries(r.params.map((p) => [p.key, p.default]));
export { segmentKey };
