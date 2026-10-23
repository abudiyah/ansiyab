import { classify, flowIndicators, parseSegmentKey, segmentSpeedIndicators, SRI_SCALE, type ColorScale, type SegmentDirectionKey, type SpeedObservation, type TrafficEvent } from '@ansiyab/core';
import type { Meta, Network } from './api.ts';
import { ago, EVENT_TYPE_AR, fmt, num, PROVENANCE_AR, ROAD_CLASS_AR, SEVERITY_AR, timeAr, VERIFICATION_AR } from './format.ts';
import type { ColorBy } from './MapView.tsx';

export function Legend({ scale, colorBy, anyTraffic }: { scale: ColorScale; colorBy: ColorBy; anyTraffic: boolean }) {
  return (
    <div className="legend" aria-label="مفتاح الألوان">
      <b>{scale.titleAr}</b> <span className="muted small">({scale.unitAr})</span>
      <ul>
        {scale.classes.map((c) => (
          <li key={c.id}>
            <span className="sw" style={{ background: c.color }} />
            <span className="glyph">{c.glyph}</span>
            {c.labelAr}
            <span className="muted small"> {Number.isFinite(c.max) ? `${c.min}–<${c.max}` : `≥ ${c.min}`}</span>
          </li>
        ))}
        <li>
          <span className="sw dashed" />
          <span className="glyph">{scale.unknown.glyph}</span>
          {scale.unknown.labelAr}
        </li>
      </ul>
      <p className="muted small">{scale.noteAr}</p>
      {colorBy === 'density' && <p className="warn small">لا توجد قياسات كثافة من أي مصدر متصل حاليًا؛ تظهر كل الطرق «غير مقاسة».</p>}
      {colorBy === 'sri' && !anyTraffic && <p className="warn small">لا يوجد مصدر سرعات متصل؛ لذلك تظهر الطرق رمادية. هذا لا يعني أن الحركة سلسة.</p>}
      <p className="muted small">الطريق ثنائي الاتجاه يُرسم بخطين متوازيين، كل اتجاه على يمين حركته.</p>
    </div>
  );
}

export function SegmentDetails({ k, network, speed, events, now, meta }: { k: SegmentDirectionKey; network: Network; speed: Map<SegmentDirectionKey, SpeedObservation>; events: TrafficEvent[]; now: Date; meta: Meta }) {
  const { segmentId, direction } = parseSegmentKey(k);
  const s = network.segments.find((x) => x.id === segmentId);
  if (!s) return <p>المقطع غير موجود.</p>;
  const obs = speed.get(k);
  const ind = segmentSpeedIndicators(obs, now, meta.policy);
  const cls = classify(SRI_SCALE, ind.sri);
  const flow = flowIndicators(undefined, obs, s.lanes);
  const related = events.filter((e) => e.segmentKeys.includes(k));
  const districts = s.districtIds.map((id) => network.districts.find((d) => d.id === id)?.nameAr).filter(Boolean);
  const src = obs ? meta.sources.find((x) => x.id === obs.sourceId) : null;
  return (
    <div>
      <h3>{s.nameAr ?? s.nameEn ?? s.ref ?? 'طريق بلا اسم في OSM'}</h3>
      <p className="muted small">
        {ROAD_CLASS_AR[s.roadClass]} · الاتجاه: {s.directions.length === 1 ? 'اتجاه واحد' : direction === 'fwd' ? 'اتجاه رسم الطريق في OSM' : 'الاتجاه المعاكس لرسم OSM'} · {num(s.lengthM)} م
        {s.lanes ? ` · ${s.lanes} حارات (OSM)` : ''} {districts.length ? ` · ${districts.join('، ')}` : ''} {s.isDistrictGateway ? ' · مدخل/مخرج حي' : ''}
      </p>
      <div className="state-chip" style={{ borderColor: cls.color }}>
        <span className="sw" style={{ background: cls.color }} /> {cls.glyph} {cls.labelAr}
      </div>
      <table className="kv">
        <tbody>
          <tr><th>السرعة الحالية</th><td>{fmt(ind.speed)}</td></tr>
          <tr><th>سرعة التدفق الحر</th><td>{fmt(ind.freeFlow)}</td></tr>
          <tr><th>مؤشر انخفاض السرعة</th><td>{fmt(ind.sri)}</td></tr>
          <tr><th>مؤشر زمن الرحلة</th><td>{fmt(ind.tti, 2)}</td></tr>
          <tr><th>التأخير</th><td>{fmt(ind.delay)}</td></tr>
          <tr><th>حجم التدفق</th><td>{fmt(flow.volume)}</td></tr>
          <tr><th>الكثافة</th><td>{fmt(flow.density, 1)}</td></tr>
          <tr><th>الانتظار / الطابور</th><td>{fmt(flow.meanWait)} / {fmt(flow.queue)}</td></tr>
          <tr><th>المصدر</th><td>{obs ? `${src?.nameAr ?? obs.sourceId} (${PROVENANCE_AR[obs.provenance]})` : 'لا توجد قراءة'}</td></tr>
          <tr><th>الثقة</th><td>{obs?.confidence != null ? num(obs.confidence, 2) : '—'}{obs?.matchDistanceM != null ? ` · مسافة المطابقة ${obs.matchDistanceM} م` : ''}</td></tr>
          <tr><th>وقت الرصد</th><td>{obs ? `${timeAr(obs.observedAt)} (${ago(obs.observedAt, now.getTime())})` : '—'}</td></tr>
          {obs?.roadClosure && <tr><th>إغلاق</th><td className="warn">المزود يبلّغ بإغلاق الطريق</td></tr>}
        </tbody>
      </table>
      <h4>الأحداث المرتبطة ({related.length})</h4>
      {related.length === 0 ? <p className="muted small">لا توجد أحداث مبلّغة مرتبطة بهذا الاتجاه. غياب البلاغ لا يعني سلامة الطريق.</p> : related.map((e) => <EventDetails key={e.id} e={e} network={network} compact />)}
      <p className="muted small">
        <a href={s.sourceRef} target="_blank" rel="noreferrer">المقطع في OpenStreetMap</a>
      </p>
    </div>
  );
}

export function EventDetails({ e, network, compact }: { e: TrafficEvent; network: Network | null; compact?: boolean }) {
  const t = EVENT_TYPE_AR[e.type] ?? EVENT_TYPE_AR.other!;
  const districts = e.districtIds.map((id) => network?.districts.find((d) => d.id === id)?.nameAr).filter(Boolean);
  return (
    <div className={compact ? 'event compact' : 'event'}>
      <h3 style={{ color: t.color }}>
        {t.glyph} {t.label} {e.isClosure && <span className="tag danger">إغلاق</span>} {e.provenance === 'simulated' && <span className="tag sim">محاكاة</span>}
      </h3>
      <p>{e.descriptionAr}</p>
      <table className="kv">
        <tbody>
          <tr><th>الشدة</th><td>{SEVERITY_AR[e.severity]}</td></tr>
          <tr><th>التحقق</th><td>{VERIFICATION_AR[e.verification]}{e.probability ? ` · احتمال: ${e.probability}` : ''}{e.numberOfReports != null ? ` · ${e.numberOfReports} بلاغ` : ''}</td></tr>
          <tr><th>من / إلى</th><td>{e.fromName ?? '—'} / {e.toName ?? '—'}</td></tr>
          <tr><th>التأخير المرتبط</th><td>{e.isClosure ? 'غير منطبق (إغلاق)' : e.delayS != null ? `${num(e.delayS / 60, 1)} د (تقدير المزود)` : 'غير متاح'}</td></tr>
          <tr><th>الطول</th><td>{e.lengthM != null ? `${num(e.lengthM)} م` : '—'}</td></tr>
          <tr><th>الحارات المتأثرة</th><td>{e.lanesAffected ?? 'غير متاح من المصدر'}</td></tr>
          <tr><th>البداية / آخر بلاغ</th><td>{timeAr(e.startTime)} / {timeAr(e.lastReportTime)}</td></tr>
          <tr><th>النهاية المتوقعة</th><td>{timeAr(e.endTime)}</td></tr>
          <tr><th>زمن الاستجابة/الإزالة</th><td>غير متاح (يتطلب بيانات الجهات المستجيبة)</td></tr>
          <tr><th>الأحياء</th><td>{districts.join('، ') || '—'}</td></tr>
          <tr><th>المصدر</th><td>{e.sourceId} · استُلم {ago(e.receivedAt)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
