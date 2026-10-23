import { useEffect, useMemo, useState } from 'react';
import {
  classify,
  congestedLengthShare,
  haversineM,
  parseSegmentKey,
  segmentSpeedIndicators,
  SRI_SCALE,
  statesFor,
  UNAVAILABLE_REASON_AR,
  type Alert,
  type LngLat,
  type RuleStatus,
  type SegmentDirectionKey,
  type SourceHealth,
  type SpeedObservation,
  type TrafficEvent,
  type IndicatorValue,
  type WeatherObservation,
  type WeatherWarning,
} from '@ansiyab/core';
import { api, type DistrictSummary, type Meta, type Network, type RouteResponse } from './api.ts';
import { ago, CONFIDENCE_AR, EVENT_TYPE_AR, fmt, num, PROVENANCE_AR, SEVERITY_AR, STATUS_AR, timeAr } from './format.ts';

const segName = (network: Network, key: SegmentDirectionKey) => {
  const { segmentId, direction } = parseSegmentKey(key);
  const s = network.segments.find((x) => x.id === segmentId);
  return { s, label: `${s?.nameAr ?? s?.nameEn ?? s?.ref ?? 'بلا اسم'}${s && s.directions.length === 2 ? (direction === 'fwd' ? ' ↦' : ' ↤') : ''}` };
};
const mid = (c: LngLat[]) => c[Math.floor(c.length / 2)]!;

// ───────────────────────── لوحة القرار ─────────────────────────

export function DecisionPanel(p: {
  meta: Meta;
  network: Network | null;
  speed: Map<SegmentDirectionKey, SpeedObservation>;
  events: TrafficEvent[];
  weather: WeatherObservation[];
  warnings: WeatherWarning[];
  now: Date;
  summaries: DistrictSummary[];
  tomtomHealth: SourceHealth | null;
  onFly: (c: LngLat) => void;
}) {
  const { network, speed, now, meta } = p;
  const rows = useMemo(() => {
    if (!network) return [];
    return [...speed.entries()]
      .map(([k, o]) => {
        const ind = segmentSpeedIndicators(o, now, meta.policy);
        const { s, label } = segName(network, k);
        return { k, o, ind, s, label };
      })
      .filter((r) => r.s && r.ind.sri.available);
  }, [network, speed, now, meta.policy]);

  const val = (v: IndicatorValue) => (v.available ? v.value : -1);
  const topSri = [...rows].sort((a, b) => val(b.ind.sri) - val(a.ind.sri)).slice(0, 6);
  const topDelay = [...rows].filter((r) => r.ind.delay.available).sort((a, b) => val(b.ind.delay) - val(a.ind.delay)).slice(0, 6);
  const gateways = rows.filter((r) => r.s!.isDistrictGateway && val(r.ind.sri) >= 60);
  const smooth = rows.filter((r) => val(r.ind.sri) < 20);
  const closures = p.events.filter((e) => e.isClosure);
  const facilitiesAtRisk = (network?.facilities ?? [])
    .filter((f) => f.kind === 'hospital' || f.kind === 'fire_station')
    .map((f) => ({ f, c: closures.find((e) => (e.geometry.type === 'Point' ? [e.geometry.coordinates] : e.geometry.coordinates).some((q) => haversineM(q, f.point) <= 1500)) }))
    .filter((x) => x.c);
  const all = network ? congestedLengthShare(statesFor(network.segments, speed), 60, now, meta.policy) : null;
  const byType: Record<string, number> = {};
  for (const e of p.events) byType[e.type] = (byType[e.type] ?? 0) + 1;

  const Row = ({ r, metric }: { r: (typeof rows)[number]; metric: 'sri' | 'delay' }) => {
    const c = classify(SRI_SCALE, r.ind.sri);
    return (
      <li>
        <button className="row" onClick={() => p.onFly(mid(r.s!.geometry.coordinates))}>
          <span className="sw" style={{ background: c.color }} /> {r.label}
          <span className="val">{metric === 'sri' ? fmt(r.ind.sri) : fmt(r.ind.delay)}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="stack">
      <section className="card">
        <h3>الحالة العامة</h3>
        <div className="kpis">
          <Kpi label="تغطية الطرق بقراءات صالحة" v={all ? fmt(all.coverage) : 'غير متاح'} hint={all ? `${num(all.validLengthM / 1000, 1)} من ${num(all.totalLengthM / 1000, 1)} كم` : undefined} />
          <Kpi label="نسبة الأطوال المزدحمة (من المغطّى)" v={all ? fmt(all.share) : 'غير متاح'} />
          <Kpi label="أحداث نشطة" v={meta.sources.find((s) => s.id === 'tomtom-incidents')?.health?.lastSuccessAt || meta.config.mode === 'simulation' ? num(p.events.length) : 'غير متاح'} hint={Object.entries(byType).map(([k, n]) => `${EVENT_TYPE_AR[k]?.label ?? k}: ${n}`).join('، ')} />
          <Kpi label="إغلاقات" v={num(closures.length)} />
        </div>
        {!p.tomtomHealth?.lastSuccessAt && meta.config.mode === 'live' && (
          <p className="warn small">لا يوجد مصدر سرعات متصل ({meta.config.tomtomConfigured ? `آخر خطأ: ${p.tomtomHealth?.lastError ?? 'لم يُجلب بعد'}` : 'يلزم مفتاح TOMTOM_API_KEY'}). لذلك تظهر مؤشرات الازدحام «غير متاحة»، وليست صفرًا.</p>
        )}
      </section>

      <section className="card">
        <h3>أعلى ازدحام</h3>
        {topSri.length ? <ul className="list">{topSri.map((r) => <Row key={r.k} r={r} metric="sri" />)}</ul> : <Empty />}
        <h3>أطول تأخير</h3>
        {topDelay.length ? <ul className="list">{topDelay.map((r) => <Row key={r.k} r={r} metric="delay" />)}</ul> : <Empty />}
      </section>

      <section className="card">
        <h3>مداخل ومخارج الأحياء المتأثرة (مؤشر ≥ 60)</h3>
        {gateways.length ? <ul className="list">{gateways.map((r) => <Row key={r.k} r={r} metric="sri" />)}</ul> : <p className="muted small">{rows.length ? 'لا توجد مداخل فوق العتبة ضمن المقاطع المغطاة.' : 'لا توجد بيانات.'}</p>}
      </section>

      <section className="card">
        <h3>الحوادث والأعطال النشطة</h3>
        {p.events.length ? (
          <ul className="list">
            {p.events.slice(0, 12).map((e) => {
              const t = EVENT_TYPE_AR[e.type] ?? EVENT_TYPE_AR.other!;
              const c = e.geometry.type === 'Point' ? e.geometry.coordinates : mid(e.geometry.coordinates);
              return (
                <li key={e.id}>
                  <button className="row" onClick={() => p.onFly(c)}>
                    <span style={{ color: t.color }}>{t.glyph}</span> {t.label} {e.fromName ? `– ${e.fromName}` : ''}
                    <span className="val">{SEVERITY_AR[e.severity]}{e.provenance === 'simulated' ? ' · محاكاة' : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted small">لا توجد أحداث مبلّغة{meta.config.tomtomConfigured ? '' : ' (مصدر الحوادث غير متصل)'}. غياب البلاغ ليس دليل سلامة.</p>
        )}
      </section>

      <section className="card">
        <h3>طرق بتدفق سلس (ضمن التغطية)</h3>
        <p className="small">{smooth.length ? `${num(smooth.length)} مقطع/اتجاه مؤشرها أقل من 20، من أصل ${num(rows.length)} مغطّى.` : 'لا توجد بيانات كافية.'}</p>
        {smooth.length > 0 && <ul className="list">{smooth.slice(0, 5).map((r) => <Row key={r.k} r={r} metric="sri" />)}</ul>}
      </section>

      <section className="card">
        <h3>الظروف البيئية</h3>
        {p.warnings.length ? (
          p.warnings.map((w) => (
            <div key={w.id} className="warn-box">
              <b>{w.titleAr}</b> · {w.regionAr} {w.governoratesAr.join('، ')} · {timeAr(w.from)} ← {timeAr(w.to)}
              <div className="small">{w.hazardsAr.join('، ')}</div>
            </div>
          ))
        ) : (
          <p className="muted small">{meta.config.ncmConfigured ? 'لا توجد إنذارات سارية للرياض.' : 'إنذارات المركز الوطني للأرصاد غير متصلة (تتطلب اعتماد طلب الوصول).'}</p>
        )}
        <WeatherTable weather={p.weather} network={network} />
        <p className="muted small">قيم Open-Meteo مأخوذة من نماذج عالمية لخلية بدقة 9 إلى 25 كم، وليست قياسات محطات، ولا تمثل قياسًا خاصًا بكل حي.</p>
        <p className="muted small">المياه والسيول: لا يوجد مصدر غمر مؤكد متصل. وطبقة قابلية التعرض (من نموذج الارتفاعات) لم تُعالج بعد.</p>
      </section>

      <section className="card">
        <h3>مرافق حيوية قد يتأثر الوصول إليها</h3>
        {facilitiesAtRisk.length ? (
          <ul className="list">{facilitiesAtRisk.map(({ f }) => <li key={f.id}><button className="row" onClick={() => p.onFly(f.point)}>🏥 {f.nameAr ?? f.kind}<span className="val">إغلاق ضمن 1.5 كم</span></button></li>)}</ul>
        ) : (
          <p className="muted small">{network?.facilities.length ? 'لا توجد إغلاقات مبلّغة قرب المستشفيات أو الدفاع المدني.' : 'لم تُحمّل مواقع المرافق.'}</p>
        )}
      </section>

      <section className="card">
        <h3>جودة البيانات وفجوات التغطية</h3>
        <ul className="small">
          {meta.flowCycle.at && (
            <li>آخر دورة TomTom ({ago(meta.flowCycle.at)}): طُلبت {meta.flowCycle.requested} نقطة، منها {meta.flowCycle.valid} صالحة، و{meta.flowCycle.noMatch} بلا مطابقة مع OSM، و{meta.flowCycle.errors} خطأ.</li>
          )}
          {Object.entries(meta.intervalsMin).map(([k, v]) => <li key={k}>دورية جلب {k}: كل {v} دقيقة</li>)}
          {meta.networkNotesAr.map((n, i) => <li key={i}>{n}</li>)}
          <li>التغطية غير متساوية بين الأحياء، ونقاط المراقبة محدودة بالحصة المجانية.</li>
        </ul>
      </section>
    </div>
  );
}

function Kpi({ label, v, hint }: { label: string; v: string; hint?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-v">{v}</div>
      <div className="kpi-l">{label}</div>
      {hint && <div className="kpi-h">{hint}</div>}
    </div>
  );
}
const Empty = () => <p className="muted small">لا توجد قراءات سرعة صالحة.</p>;

function WeatherTable({ weather, network }: { weather: WeatherObservation[]; network: Network | null }) {
  if (!weather.length) return <p className="muted small">لا توجد قراءات طقس (Open-Meteo غير متصل أو لم يُجلب بعد).</p>;
  return (
    <table className="grid small">
      <thead>
        <tr><th>الموقع</th><th>هطول مم/س</th><th>هبات كم/س</th><th>رؤية كم</th><th>غبار µg/m³</th><th>الرصد</th></tr>
      </thead>
      <tbody>
        {weather.map((w) => (
          <tr key={w.locationId + w.validAt}>
            <td>{network?.districts.find((d) => d.id === w.locationId)?.nameAr ?? w.locationId}</td>
            <td>{num(w.precipitationMm, 1)}</td>
            <td>{num(w.windGustsKmh)}</td>
            <td>{w.visibilityM != null ? num(w.visibilityM / 1000, 1) : '—'}</td>
            <td>{num(w.dustUgM3)}</td>
            <td>{PROVENANCE_AR[w.provenance]} · {ago(w.observedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ───────────────────────── الأحياء ─────────────────────────

interface Reco { textAr: string; basisAr: string }
export function recommendationsFor(s: DistrictSummary): Reco[] {
  const out: Reco[] = [];
  const v = (x: DistrictSummary['meanSri']) => (x.available ? x.value : null);
  if (!s.coverage.available || (v(s.coverage) ?? 0) < 40)
    out.push({ textAr: 'إعطاء أولوية لتوسيع التغطية (نقاط مراقبة إضافية أو عدادات) قبل الاعتماد على مؤشرات الحي.', basisAr: `التغطية ${fmt(s.coverage)}` });
  if ((v(s.congestedShare) ?? 0) >= 30)
    out.push({ textAr: 'مراجعة توقيت الإشارات على المحاور المزدحمة، وتقييم مدخل بديل للحي.', basisAr: `نسبة الأطوال المزدحمة ${fmt(s.congestedShare)}` });
  if (s.closures > 0) out.push({ textAr: 'التحقق ميدانيًا من الإغلاقات وتحديث المسارات البديلة للمداخل المتأثرة.', basisAr: `${s.closures} إغلاق مبلّغ` });
  if ((s.activeEvents.accident ?? 0) + (s.activeEvents.breakdown ?? 0) > 0)
    out.push({ textAr: 'إعطاء أولوية للتحقق الميداني من الحوادث والأعطال وتقدير زمن الإزالة.', basisAr: `${(s.activeEvents.accident ?? 0) + (s.activeEvents.breakdown ?? 0)} حادث/عطل` });
  const w = s.weather;
  if (w && ((w.visibilityM ?? 1e9) < 1000 || (w.windGustsKmh ?? 0) > 60 || (w.precipitationMm ?? 0) > 10))
    out.push({ textAr: 'رفع الجاهزية ومراقبة السرعات على المحاور السريعة بسبب الظروف الجوية.', basisAr: 'قيم نموذجية من Open-Meteo' });
  if (s.boundaryQuality === 'point_only') out.push({ textAr: 'طلب حدود الحي المعتمدة من أمانة الرياض لتمكين التجميع والمقارنة.', basisAr: 'الحي نقطة فقط في OSM' });
  if (!out.length) out.push({ textAr: 'لا توجد توصية تشغيلية الآن ضمن البيانات المتاحة.', basisAr: 'لا شرط تجاوز العتبات' });
  return out;
}

export function DistrictsPanel(p: { meta: Meta; network: Network | null; selected: string[]; summaries: DistrictSummary[]; onToggle: (id: string) => void; onFly: (c: LngLat) => void }) {
  const [q, setQ] = useState('');
  const [hourly, setHourly] = useState<WeatherObservation[]>([]);
  useEffect(() => void api.weatherHourly().then(setHourly).catch(() => setHourly([])), []);
  if (!p.network) return <p className="muted">قاعدة الأحياء غير محمّلة.</p>;
  const sample = new Set(p.meta.sampleDistrictIds);
  const list = p.network.districts
    .filter((d) => !q || d.nameAr.includes(q))
    .sort((a, b) => Number(sample.has(b.id)) - Number(sample.has(a.id)) || a.nameAr.localeCompare(b.nameAr, 'ar'));
  return (
    <div className="stack">
      <section className="card">
        <h3>اختيار الأحياء للمقارنة (حتى 6)</h3>
        <input className="full" placeholder="تصفية بالاسم…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="district-list">
          {list.slice(0, 80).map((d) => (
            <label key={d.id} className={sample.has(d.id) ? 'sample' : ''}>
              <input type="checkbox" checked={p.selected.includes(d.id)} onChange={() => p.onToggle(d.id)} /> {d.nameAr}
              {d.boundaryQuality === 'point_only' && <span className="muted small"> (نقطة فقط)</span>}
              {sample.has(d.id) && <span className="tag">عينة</span>}
            </label>
          ))}
        </div>
      </section>

      {p.summaries.length > 0 && (
        <section className="card">
          <h3>المقارنة المعيارية</h3>
          <div className="scroll-x">
            <table className="grid small">
              <thead>
                <tr><th>الحي</th><th>التغطية</th><th>متوسط المؤشر (مرجّح بالطول)</th><th>% أطوال مزدحمة</th><th>مؤشر زمن الرحلة</th><th>تأخير ث/كم</th><th>أحداث/100 حارة·كم</th><th>الثقة</th></tr>
              </thead>
              <tbody>
                {p.summaries.map((s) => (
                  <tr key={s.districtId} className={s.comparable ? '' : 'dim'}>
                    <td>{s.nameAr}{!s.comparable && ' *'}</td>
                    <td>{fmt(s.coverage)}</td>
                    <td>{fmt(s.meanSri)}</td>
                    <td>{fmt(s.congestedShare)}</td>
                    <td>{fmt(s.travelTimeIndex, 2)}</td>
                    <td>{fmt(s.delayPerKm)}</td>
                    <td>{fmt(s.eventsPer100LaneKm, 1)}</td>
                    <td>{CONFIDENCE_AR[s.confidence]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">* غير قابل للمقارنة: التغطية أقل من 40% أو لا توجد حدود مضلعة. المؤشرات مرجّحة بطول المقاطع، ولا تعتمد على أعداد خام أو متوسط بسيط للسرعات. المقارنة بنفس نوع اليوم والساعة تتطلب سجلًا تاريخيًا.</p>
        </section>
      )}

      {p.summaries.map((s) => {
        const d = p.network!.districts.find((x) => x.id === s.districtId)!;
        const h = hourly.filter((w) => w.locationId === s.districtId);
        const nowT = Date.now();
        const window = h.filter((w) => Math.abs(new Date(w.validAt).getTime() - nowT) <= 6 * 3600e3);
        return (
          <section key={s.districtId} className="card district-card">
            <header>
              <h3>حي {s.nameAr}</h3>
              <button className="link" onClick={() => p.onFly(d.centroid)}>إظهار على الخريطة</button>
            </header>
            <p className="small">
              الثقة: <b>{CONFIDENCE_AR[s.confidence]}</b>
              {s.confidenceReasonsAr.length > 0 && ` (${s.confidenceReasonsAr.join('؛ ')})`} · طول الطرق المحمّلة {num(s.roadLengthKm, 1)} كم · {s.segmentDirections} مقطع/اتجاه
            </p>
            <h4>الحركة</h4>
            <table className="kv small">
              <tbody>
                <tr><th>التغطية</th><td>{fmt(s.coverage)}</td></tr>
                <tr><th>متوسط مؤشر انخفاض السرعة</th><td>{fmt(s.meanSri)}</td></tr>
                <tr><th>نسبة الأطوال المزدحمة</th><td>{fmt(s.congestedShare)}</td></tr>
                <tr><th>سرعة المتوسط المكاني</th><td>{fmt(s.spaceMeanSpeed)}</td></tr>
                <tr><th>مؤشر زمن الرحلة</th><td>{fmt(s.travelTimeIndex, 2)}</td></tr>
                <tr><th>التأخير لكل كم</th><td>{fmt(s.delayPerKm)}</td></tr>
                <tr><th>مقارنة بفترات مماثلة</th><td>{fmt(s.vsBaseline)}</td></tr>
                <tr><th>عمر أحدث قراءة</th><td>{s.freshestObsAgeS != null ? `${num(s.freshestObsAgeS / 60)} د` : '—'}</td></tr>
              </tbody>
            </table>
            <h4>الأحداث</h4>
            <p className="small">
              {Object.keys(s.activeEvents).length ? Object.entries(s.activeEvents).map(([k, n]) => `${EVENT_TYPE_AR[k]?.label ?? k}: ${n}`).join('، ') : 'لا أحداث مبلّغة'} · إغلاقات: {s.closures}
            </p>
            <h4>الظروف البيئية</h4>
            {window.length ? (
              <div className="scroll-x">
                <table className="grid small">
                  <thead><tr><th>الساعة</th><th>النوع</th><th>هطول</th><th>هبات</th><th>رؤية</th></tr></thead>
                  <tbody>
                    {window.map((w) => (
                      <tr key={w.validAt} className={w.provenance === 'forecast' ? 'fc' : ''}>
                        <td>{timeAr(w.validAt)}</td><td>{PROVENANCE_AR[w.provenance]}</td><td>{num(w.precipitationMm, 1)}</td><td>{num(w.windGustsKmh)}</td><td>{w.visibilityM != null ? num(w.visibilityM / 1000, 1) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted small">لا توجد قراءات طقس لهذا الحي.</p>
            )}
            <h4>التوصيات</h4>
            <ul className="recos">
              {recommendationsFor(s).map((r, i) => (
                <li key={i}>{r.textAr} <span className="muted small">(الأساس: {r.basisAr})</span></li>
              ))}
            </ul>
            <p className="muted small">التوصيات دعم للقرار. قرارات الإغلاق وتعديل الإشارات والتوجيه التشغيلي للجهة المخولة.</p>
          </section>
        );
      })}
    </div>
  );
}

// ───────────────────────── التنبيهات ─────────────────────────

export function AlertsPanel({ meta, onFly }: { meta: Meta; onFly: (c: LngLat) => void }) {
  const [data, setData] = useState<{ alerts: Alert[]; statuses: RuleStatus[] } | null>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [err, setErr] = useState<string | null>(null);
  const [token, setToken] = useState(() => {
    try {
      return sessionStorage.getItem('ansiyab.adminToken') ?? '';
    } catch {
      return '';
    }
  });
  const load = () => api.alerts().then(setData).catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  const act = async (a: Alert, action: string) => {
    const note = action === 'note' || action === 'resolve' ? prompt(action === 'resolve' ? 'النتيجة (مثال: تأكد ميدانيًا / إنذار خاطئ):' : 'ملاحظة الإجراء المتخذ:') ?? undefined : undefined;
    try {
      await api.alertAction(a.id, { action, note: action === 'note' ? note : undefined, outcome: action === 'resolve' ? note : undefined, actor: 'مشغل' });
      setErr(null);
      void load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const alerts = (data?.alerts ?? []).filter((a) => filter === 'all' || a.status !== 'resolved');
  return (
    <div className="stack">
      <section className="card">
        <h3>التنبيهات {filter === 'active' ? 'النشطة' : 'كلها'} ({alerts.length})</h3>
        <div className="row-btns">
          <button className={filter === 'active' ? 'on' : ''} onClick={() => setFilter('active')}>النشطة</button>
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>السجل الكامل</button>
        </div>
        <label className="small">
          رمز الإدارة (لتسجيل الإجراءات):
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              try {
                sessionStorage.setItem('ansiyab.adminToken', e.target.value);
              } catch {
                /* */
              }
            }}
          />
        </label>
        {!meta.config.adminConfigured && <p className="muted small">ADMIN_TOKEN غير مضبوط في الخادم، لذلك تسجيل الإجراءات معطل.</p>}
        {err && <p className="err">{err}</p>}
        {alerts.length === 0 && <p className="muted small">لا توجد تنبيهات. تحقق من «حالة القواعد» أدناه: بعض القواعد لا يمكن تقييمها بلا بيانات.</p>}
        {alerts.map((a) => (
          <article key={a.id} className={`alert sev-${a.severity} st-${a.status}`}>
            <header>
              <b>{meta.rules.find((r) => r.id === a.ruleId)?.titleAr ?? a.ruleId}</b>
              <span className="tag">{STATUS_AR[a.status]}</span>
              {a.provenance === 'simulated' && <span className="tag sim">محاكاة</span>}
            </header>
            <p>{a.reasonAr}</p>
            <table className="kv small">
              <tbody>
                <tr><th>الموقع</th><td>{a.locationAr}{a.geometry && <button className="link" onClick={() => onFly(a.geometry!.type === 'Point' ? a.geometry!.coordinates : mid(a.geometry!.coordinates))}> (خريطة)</button>}</td></tr>
                <tr><th>الوقت</th><td>منذ {timeAr(a.firstDetectedAt)} · آخر تقييم {ago(a.lastEvaluatedAt)}</td></tr>
                <tr><th>الشدة / الثقة</th><td>{SEVERITY_AR[a.severity]} / {CONFIDENCE_AR[a.confidence]}</td></tr>
                <tr><th>المصدر</th><td>{a.sourceIds.join('، ')}</td></tr>
                <tr><th>الإجراء المقترح</th><td>{a.suggestedActionAr}</td></tr>
              </tbody>
            </table>
            {a.log.length > 0 && (
              <ul className="log small">
                {a.log.map((l, i) => (
                  <li key={i}>{timeAr(l.at)} · {l.actor} · {l.action}{l.note ? ` · ${l.note}` : ''}{l.outcome ? ` · النتيجة: ${l.outcome}` : ''}</li>
                ))}
              </ul>
            )}
            {a.status !== 'resolved' && (
              <div className="row-btns">
                {a.status === 'open' && <button onClick={() => act(a, 'acknowledge')}>إقرار</button>}
                <button onClick={() => act(a, 'note')}>تسجيل إجراء</button>
                <button onClick={() => act(a, 'resolve')}>إغلاق مع النتيجة</button>
              </div>
            )}
          </article>
        ))}
      </section>
      <section className="card">
        <h3>حالة القواعد</h3>
        <ul className="small">
          {(data?.statuses ?? meta.ruleStatuses).map((s) => (
            <li key={s.ruleId}>
              {s.evaluable ? '✓' : '○'} {s.titleAr}: {s.enabled ? (s.evaluable ? `تُقيَّم (${s.candidates} مرشح)` : `غير قابلة للتقييم الآن: ${s.reasonAr}`) : 'معطلة'}
            </li>
          ))}
        </ul>
        <RulesEditor meta={meta} />
      </section>
    </div>
  );
}

function RulesEditor({ meta }: { meta: Meta }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(meta.rules.map((r) => [r.id, r.config])));
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <details>
      <summary>ضبط العتبات (يتطلب رمز الإدارة)</summary>
      {meta.rules.map((r) => (
        <fieldset key={r.id}>
          <legend>
            <label>
              <input type="checkbox" checked={draft[r.id]!.enabled} onChange={(e) => setDraft({ ...draft, [r.id]: { ...draft[r.id]!, enabled: e.target.checked } })} /> {r.titleAr}
            </label>
          </legend>
          <p className="muted small">{r.descriptionAr} · يتطلب: {r.requiresAr}</p>
          {r.params.map((pp) => (
            <label key={pp.key} className="small">
              {pp.labelAr} ({pp.unit})
              <input type="number" value={draft[r.id]!.params[pp.key] ?? pp.default} onChange={(e) => setDraft({ ...draft, [r.id]: { ...draft[r.id]!, params: { ...draft[r.id]!.params, [pp.key]: Number(e.target.value) } } })} />
            </label>
          ))}
          <label className="small">
            مدة الاستمرار قبل الإطلاق (د)
            <input type="number" value={Math.round(draft[r.id]!.persistenceS / 60)} onChange={(e) => setDraft({ ...draft, [r.id]: { ...draft[r.id]!, persistenceS: Number(e.target.value) * 60 } })} />
          </label>
        </fieldset>
      ))}
      <button onClick={() => api.saveRules(draft).then(() => setMsg('حُفظت القواعد')).catch((e) => setMsg(e.message))}>حفظ</button>
      {msg && <span className="small"> {msg}</span>}
    </details>
  );
}

// ───────────────────────── المسارات ─────────────────────────

export function RoutesPanel(p: { from: LngLat | null; to: LngLat | null; pick: 'from' | 'to' | null; onPick: (x: 'from' | 'to' | null) => void; route: RouteResponse | null; onRun: () => void; onClear: () => void; simulation: boolean }) {
  const fmtP = (x: LngLat | null) => (x ? `${x[1].toFixed(4)}، ${x[0].toFixed(4)}` : 'غير محدد');
  return (
    <div className="stack">
      <section className="card">
        <h3>مقارنة المسارات البديلة</h3>
        {p.simulation && <p className="warn small">التوجيه معطل في وضع المحاكاة لأن الشبكة اصطناعية.</p>}
        <p className="small">الانطلاق: <b>{fmtP(p.from)}</b> · الوجهة: <b>{fmtP(p.to)}</b></p>
        <div className="row-btns">
          <button className={p.pick ? 'on' : ''} onClick={() => p.onPick('from')}>تحديد النقطتين على الخريطة</button>
          <button onClick={p.onRun} disabled={!p.from || !p.to}>حساب</button>
          <button onClick={p.onClear}>مسح</button>
        </div>
        <p className="muted small">المحرك: OSRM (خادم العرض العام). يحسب الزمن من سرعات افتراضية في OSM، وليس من المرور الحي. المنصة تقيّم كل بديل مقابل الإغلاقات والازدحام المرصود والشوارع السكنية والتعرض البيئي المتاح.</p>
      </section>
      {p.route?.assessments.map((a) => (
        <section key={a.routeId} className={`card route ${a.excluded ? 'excluded' : a.rank === 1 ? 'best' : ''}`}>
          <h3>
            البديل {a.routeId.replace('r', '')} {a.excluded ? <span className="tag danger">مستبعد: يمر بإغلاق</span> : a.rank === 1 ? <span className="tag ok">الأفضل ضمن البيانات المتاحة</span> : <span className="tag">الترتيب {a.rank}</span>}
          </h3>
          <table className="kv small">
            <tbody>
              <tr><th>المسافة</th><td>{num(a.distanceKm, 1)} كم</td></tr>
              <tr><th>زمن المحرك (بلا مرور حي)</th><td>{num(a.engineDurationMin, 0)} د</td></tr>
              <tr><th>زمن معدّل بالمرور المرصود</th><td>{fmt(a.liveAdjustedDurationMin)}</td></tr>
              <tr><th>تغطية بيانات المرور على المسار</th><td>{fmt(a.trafficCoverage)}</td></tr>
              <tr><th>متوسط مؤشر انخفاض السرعة</th><td>{fmt(a.meanSri)}</td></tr>
              <tr><th>نسبة الشوارع السكنية</th><td>{fmt(a.residentialShare)}</td></tr>
              <tr><th>إغلاقات / أحداث / بلاغات سيول</th><td>{a.blockedByClosure.length} / {a.incidentsOnRoute.length} / {a.floodReports.length}</td></tr>
            </tbody>
          </table>
          <ul className="small">{a.notesAr.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
      ))}
    </div>
  );
}

// ───────────────────────── المصادر ─────────────────────────

export function SourcesPanel({ meta, onRefresh }: { meta: Meta; onRefresh: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="stack">
      <section className="card">
        <h3>سجل المصادر وحالة الاتصال</h3>
        <p className="muted small">لا يُصنَّف المصدر «متصلًا ومختبرًا» إلا بعد نجاح فحص فعلي خلال آخر 24 ساعة (npm run probe).</p>
        <button onClick={() => api.probe().then(() => { setMsg('اكتمل الفحص'); onRefresh(); }).catch((e) => setMsg(e.message))}>تشغيل فحص الاتصال الآن</button>
        {msg && <span className="small"> {msg}</span>}
      </section>
      {meta.sources.map((s) => (
        <section key={s.id} className="card source">
          <header>
            <b>{s.nameAr}</b> <span className={`tag cls-${s.effectiveClassification}`}>{s.effectiveClassificationAr}</span>
          </header>
          <table className="kv small">
            <tbody>
              <tr><th>المتغيرات</th><td>{s.variablesAr.join('، ')}</td></tr>
              <tr><th>التغطية</th><td>{s.coverageAr}</td></tr>
              <tr><th>دورية التحديث / التأخر</th><td>{s.updateFrequencyAr} / {s.latencyAr}</td></tr>
              <tr><th>طريقة الوصول</th><td>{s.accessAr}</td></tr>
              <tr><th>التكلفة</th><td>{s.costAr}</td></tr>
              <tr><th>شروط العرض والتخزين</th><td>{s.termsAr}</td></tr>
              <tr><th>المتطلب</th><td>{s.requirementAr}</td></tr>
              <tr><th>اختبار الاتصال</th><td>{s.connectionTest ? `${s.connectionTest.ok ? '✓' : '✗'} ${s.connectionTest.detail} (${timeAr(s.connectionTest.testedAt)})` : 'لم يُشغَّل'}</td></tr>
              <tr><th>الجلب التشغيلي</th><td>{s.health ? `آخر نجاح: ${ago(s.health.lastSuccessAt)}${s.health.lastError ? ` · آخر خطأ (${ago(s.health.lastErrorAt)}): ${s.health.lastError}` : ''}` : 'غير مفعّل'}</td></tr>
              <tr><th>التحقق من الوثائق</th><td>{s.verifiedAt} · {s.docs.map((d, i) => <a key={i} href={d.url} target="_blank" rel="noreferrer">{d.titleAr}</a>).reduce<React.ReactNode[]>((acc, x, i) => (i ? [...acc, ' · ', x] : [x]), [])}</td></tr>
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

// ───────────────────────── المؤشرات ─────────────────────────

export function IndicatorsPanel({ meta }: { meta: Meta }) {
  const groups = [...new Set(meta.indicators.map((i) => i.group))];
  const IMPL: Record<string, string> = { computed: 'محسوب', needs_data: 'يحتاج بيانات', needs_history: 'يحتاج سجلًا' };
  return (
    <div className="stack">
      <section className="card">
        <h3>قاموس المؤشرات</h3>
        <p className="muted small">أي مؤشر بلا بيانات يظهر «غير متاح» مع السبب: {Object.values(UNAVAILABLE_REASON_AR).join('، ')}.</p>
      </section>
      {groups.map((g) => (
        <section key={g} className="card">
          <h3>{g}</h3>
          {meta.indicators.filter((i) => i.group === g).map((i) => (
            <details key={i.id}>
              <summary>
                {i.n}. {i.nameAr} <span className={`tag impl-${i.impl}`}>{IMPL[i.impl]}</span>
              </summary>
              <table className="kv small">
                <tbody>
                  <tr><th>التعريف</th><td>{i.definitionAr}</td></tr>
                  <tr><th>المعادلة</th><td><code>{i.formula}</code></td></tr>
                  <tr><th>الوحدة</th><td>{i.unit}</td></tr>
                  <tr><th>المصدر</th><td>{i.sourceIds.join('، ') || '—'}</td></tr>
                  <tr><th>التواتر</th><td>{i.frequencyAr}</td></tr>
                  <tr><th>المستوى</th><td>{i.levels.join('، ')}</td></tr>
                  <tr><th>حدود الاستخدام</th><td>{i.limitsAr}</td></tr>
                </tbody>
              </table>
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}
