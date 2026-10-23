import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LngLat, SegmentDirectionKey, SpeedObservation, TrafficEvent } from '@ansiyab/core';
import { api, type DistrictSummary, type GeocodeHit, type Meta, type Network, type RouteResponse, type StateSnapshot } from './api.ts';
import { MapView, type ColorBy, type LayerToggles } from './MapView.tsx';
import { AlertsPanel, DecisionPanel, DistrictsPanel, IndicatorsPanel, RoutesPanel, SourcesPanel } from './Panels.tsx';
import { EventDetails, Legend, SegmentDetails } from './Details.tsx';
import { ago, EVENT_TYPE_AR, timeAr } from './format.ts';

type Tab = 'decision' | 'districts' | 'alerts' | 'routes' | 'sources' | 'indicators';
type Temporal = 'current' | 'historical' | 'forecast';

const TABS: { id: Tab; label: string }[] = [
  { id: 'decision', label: 'لوحة القرار' },
  { id: 'districts', label: 'الأحياء' },
  { id: 'alerts', label: 'التنبيهات' },
  { id: 'routes', label: 'المسارات' },
  { id: 'sources', label: 'المصادر' },
  { id: 'indicators', label: 'المؤشرات' },
];

const POLL_MS = 60_000;

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('decision');
  const [temporal, setTemporal] = useState<Temporal>('current');
  const [histAt, setHistAt] = useState<string | null>(null);
  const [colorBy, setColorBy] = useState<ColorBy>('sri');
  const [layers, setLayers] = useState<LayerToggles>({ traffic: true, providerTiles: false, districts: true, events: true, weather: true, facilities: false, routes: true });
  const [eventTypes, setEventTypes] = useState<Set<string>>(new Set(Object.keys(EVENT_TYPE_AR)));
  const [minSeverity, setMinSeverity] = useState<number>(0);
  const [maxEventAgeH, setMaxEventAgeH] = useState<number>(24);
  const [minConfidence, setMinConfidence] = useState<number>(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [summaries, setSummaries] = useState<DistrictSummary[]>([]);
  const [segmentSel, setSegmentSel] = useState<SegmentDirectionKey | null>(null);
  const [eventSel, setEventSel] = useState<TrafficEvent | null>(null);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [routeFrom, setRouteFrom] = useState<LngLat | null>(null);
  const [routeTo, setRouteTo] = useState<LngLat | null>(null);
  const [routePick, setRoutePick] = useState<'from' | 'to' | null>(null);
  const [flyTo, setFlyTo] = useState<{ center: LngLat; zoom?: number; at: number } | null>(null);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<GeocodeHit[] | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<{ ok: boolean; error?: string } | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tick, setTick] = useState(0);

  const refreshMeta = useCallback(() => api.meta().then(setMeta).catch((e) => setError(String(e.message ?? e))), []);

  useEffect(() => {
    void refreshMeta();
    const t = setInterval(refreshMeta, POLL_MS);
    return () => clearInterval(t);
  }, [refreshMeta]);

  useEffect(() => {
    if (!meta) return;
    const load = () =>
      api.network().then((n) => {
        setNetwork(n);
        setNetworkError(null);
        setSelected((s) => (s.length ? s : meta.sampleDistrictIds.slice(0, 2)));
      }).catch((e) => setNetworkError(e.message));
    if (!network || network.builtAt !== meta.networkBuiltAt) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.networkBuiltAt]);

  const at = temporal === 'historical' ? histAt ?? undefined : undefined;

  // جلب الحالة: كل دقيقة في الوضع الحالي. عمر البيانات يُعرض من وقت الرصد وليس من وقت الجلب
  useEffect(() => {
    if (temporal === 'forecast') return;
    let alive = true;
    const load = () =>
      api.state(at).then((s) => {
        if (!alive) return;
        setState(s);
        setFetchedAt(new Date().toISOString());
        setError(null);
      }).catch((e) => alive && setError(e.message));
    void load();
    const t = temporal === 'current' ? setInterval(load, POLL_MS) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [temporal, at]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!selected.length || !network) return setSummaries([]);
    api.districts(selected, at).then(setSummaries).catch(() => setSummaries([]));
  }, [selected, network, state, at]);

  const speed = useMemo(() => new Map<SegmentDirectionKey, SpeedObservation>((state?.speed ?? []).map((o) => [o.segmentKey, o])), [state]);
  const now = useMemo(() => (state ? new Date(state.at) : new Date()), [state, tick]);

  const SEV: Record<string, number> = { unknown: 0, low: 1, moderate: 2, high: 3, critical: 4 };
  const events = useMemo(
    () =>
      (state?.events ?? []).filter((e) => {
        if (!eventTypes.has(e.type)) return false;
        if ((SEV[e.severity] ?? 0) < minSeverity) return false;
        const ref = e.lastReportTime ?? e.startTime ?? e.receivedAt;
        return !ref || (now.getTime() - new Date(ref).getTime()) / 3600e3 <= maxEventAgeH;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, eventTypes, minSeverity, maxEventAgeH, now],
  );

  const onSearch = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setSearchErr(null);
    const q = search.trim();
    if (!q) return;
    // البحث المحلي أولًا في الأحياء والطرق المحمّلة
    const local: GeocodeHit[] = [];
    for (const d of network?.districts ?? []) if (d.nameAr.includes(q)) local.push({ displayName: `حي ${d.nameAr}`, point: d.centroid, category: 'district', type: d.id });
    const seen = new Set<string>();
    for (const s of network?.segments ?? []) {
      const n = s.nameAr ?? s.nameEn ?? '';
      if (n && n.includes(q) && !seen.has(n)) {
        seen.add(n);
        const c = s.geometry.coordinates;
        local.push({ displayName: n, point: c[Math.floor(c.length / 2)]!, category: 'road', type: s.roadClass });
      }
    }
    try {
      const remote = await api.geocode(q);
      setHits([...local.slice(0, 8), ...remote]);
    } catch (e) {
      setHits(local.slice(0, 12));
      setSearchErr(`بحث Nominatim غير متاح: ${(e as Error).message}`);
    }
  };

  const pickHit = (h: GeocodeHit) => {
    setFlyTo({ center: h.point, zoom: h.category === 'district' ? 14 : 15, at: Date.now() });
    if (h.category === 'district') toggleDistrict(h.type, true);
    setHits(null);
  };

  const toggleDistrict = (id: string, only = false) =>
    setSelected((s) => (only ? (s.includes(id) ? s : [...s, id]) : s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-6)));

  const runRoute = async (from: LngLat, to: LngLat) => {
    try {
      setRoute(await api.route(from, to));
      setLayers((l) => ({ ...l, routes: true }));
    } catch (e) {
      setRoute(null);
      alert(`تعذّر حساب المسار: ${(e as Error).message}`);
    }
  };

  const onMapPick = (p: LngLat) => {
    if (routePick === 'from') {
      setRouteFrom(p);
      setRoutePick('to');
    } else if (routePick === 'to') {
      setRouteTo(p);
      setRoutePick(null);
      if (routeFrom) void runRoute(routeFrom, p);
    }
  };

  if (!meta) {
    return (
      <div className="boot">
        <h1>منصة انسياب</h1>
        <p>{error ? `تعذّر الاتصال بخادم المنصة: ${error}` : 'جارٍ التحميل…'}</p>
        {error && <p className="muted">شغّل الخادم بالأمر <code>npm start</code> (انظر README).</p>}
      </div>
    );
  }

  const live = meta.config.mode === 'live';
  const anyTraffic = !live || meta.sources.some((s) => s.id === 'tomtom-flow' && s.health?.lastSuccessAt);
  const tomtomHealth = meta.sources.find((s) => s.id === 'tomtom-flow')?.health;
  const freshest = state?.speed.length ? state.speed.reduce((a, o) => (o.observedAt > a ? o.observedAt : a), state.speed[0]!.observedAt) : null;

  return (
    <div className={`app${panelOpen ? '' : ' panel-closed'}`}>
      {meta.simulationBannerAr && (
        <div className="sim-banner" role="alert">
          ⚠ {meta.simulationBannerAr}
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>〰</span>
          <div>
            <h1>منصة انسياب</h1>
            <p>رصد الحركة المرورية والمخاطر البيئية ودعم القرار في أحياء {meta.region.nameAr}</p>
          </div>
        </div>
        <form className="search" onSubmit={onSearch} role="search">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن حي أو طريق أو موقع…" aria-label="بحث" />
          <button type="submit">بحث</button>
          {hits && (
            <ul className="hits">
              {searchErr && <li className="muted small">{searchErr}</li>}
              {hits.length === 0 && <li className="muted">لا نتائج</li>}
              {hits.map((h, i) => (
                <li key={i}>
                  <button type="button" onClick={() => pickHit(h)}>
                    <span className="tag">{h.category === 'district' ? 'حي' : h.category === 'road' ? 'طريق' : 'موقع'}</span> {h.displayName}
                  </button>
                </li>
              ))}
              <li><button type="button" className="link" onClick={() => setHits(null)}>إغلاق</button></li>
            </ul>
          )}
        </form>
        <div className="temporal" role="tablist" aria-label="الإطار الزمني">
          {(['current', 'historical', 'forecast'] as Temporal[]).map((t) => (
            <button key={t} role="tab" aria-selected={temporal === t} className={temporal === t ? 'on' : ''} onClick={() => setTemporal(t)}>
              {t === 'current' ? 'حالي' : t === 'historical' ? 'تاريخي' : 'متوقع'}
            </button>
          ))}
        </div>
        <div className="status">
          <span className={`pill ${live ? (anyTraffic ? 'ok' : 'warn') : 'sim'}`}>
            {live ? (anyTraffic ? 'وضع حي' : 'وضع حي: لا يوجد مصدر مرور متصل') : 'وضع محاكاة'}
          </span>
          <span className="small">
            أحدث رصد للسرعات: {freshest ? `${timeAr(freshest)} (${ago(freshest)})` : 'لا يوجد'}
            {' · '}آخر جلب من الخادم: {ago(fetchedAt)}
          </span>
        </div>
        <button className="panel-toggle" onClick={() => setPanelOpen((x) => !x)} aria-expanded={panelOpen}>
          {panelOpen ? 'إخفاء اللوحة' : 'إظهار اللوحة'}
        </button>
      </header>

      {temporal === 'historical' && <HistorySlider meta={meta} value={histAt} onChange={setHistAt} />}
      {temporal === 'forecast' && <ForecastNotice />}

      <main className="body">
        <section className="map-wrap">
          <MapView
            meta={meta}
            network={network}
            speed={temporal === 'forecast' ? new Map() : speed}
            events={temporal === 'current' ? events : []}
            weather={temporal === 'forecast' ? [] : (state?.weather ?? [])}
            now={now}
            colorBy={colorBy}
            layers={layers}
            minConfidence={minConfidence}
            selectedDistricts={selected}
            route={route}
            routePick={routePick}
            flyTo={flyTo}
            onSegment={(k) => {
              setSegmentSel(k);
              setEventSel(null);
            }}
            onDistrict={(id) => {
              toggleDistrict(id);
              setTab('districts');
            }}
            onEvent={(e) => {
              setEventSel(e);
              setSegmentSel(null);
            }}
            onMapPick={onMapPick}
            onBasemapStatus={setBasemap}
          />
          {!network && (
            <div className="map-overlay">
              {networkError ? (
                <>
                  <b>قاعدة الطرق والأحياء غير متاحة.</b> {networkError}
                </>
              ) : (
                'جارٍ تحميل الطرق والأحياء…'
              )}
            </div>
          )}
          {basemap && !basemap.ok && (
            <div className="map-note">الخريطة الأساسية (OpenFreeMap) غير متاحة: {basemap.error}. تُعرض طبقات المنصة على خلفية بسيطة.</div>
          )}
          {routePick && <div className="map-note pick">انقر على الخريطة لتحديد {routePick === 'from' ? 'نقطة الانطلاق' : 'الوجهة'}</div>}
          <div className="map-controls">
            <details open={typeof window !== 'undefined' && window.innerWidth > 1100}>
              <summary>الطبقات والمرشحات</summary>
              <fieldset>
                <legend>الطبقات</legend>
                {(
                  [
                    ['traffic', 'المرور (مقاطع واتجاهات)'],
                    ['providerTiles', 'بلاطات TomTom (مفتاح المزود)'],
                    ['districts', 'حدود الأحياء'],
                    ['events', 'الحوادث والأعطال والإغلاقات'],
                    ['weather', 'الطقس'],
                    ['facilities', 'المرافق الحيوية'],
                    ['routes', 'المسارات'],
                  ] as [keyof LayerToggles, string][]
                ).map(([k, l]) => (
                  <label key={k} className={k === 'providerTiles' && !meta.config.tomtomRasterTiles ? 'disabled' : ''}>
                    <input type="checkbox" checked={layers[k]} disabled={k === 'providerTiles' && !meta.config.tomtomRasterTiles} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {l}
                    {k === 'providerTiles' && !meta.config.tomtomRasterTiles && <span className="muted small"> (يحتاج مفتاحًا)</span>}
                  </label>
                ))}
                <label className="muted small">المياه: غير متصلة (لا يوجد مصدر غمر مؤكد)</label>
              </fieldset>
              <fieldset>
                <legend>لون الطريق حسب</legend>
                <select value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)}>
                  <option value="sri">مؤشر انخفاض السرعة</option>
                  <option value="density">الكثافة (عند توافرها)</option>
                </select>
              </fieldset>
              <fieldset>
                <legend>الأحداث</legend>
                <div className="chips">
                  {Object.entries(EVENT_TYPE_AR).map(([k, v]) => (
                    <label key={k} className="chip">
                      <input
                        type="checkbox"
                        checked={eventTypes.has(k)}
                        onChange={(e) => {
                          const s = new Set(eventTypes);
                          if (e.target.checked) s.add(k);
                          else s.delete(k);
                          setEventTypes(s);
                        }}
                      />
                      <span style={{ color: v.color }}>{v.glyph}</span> {v.label}
                    </label>
                  ))}
                </div>
                <label>
                  الشدة الدنيا
                  <select value={minSeverity} onChange={(e) => setMinSeverity(Number(e.target.value))}>
                    <option value={0}>الكل</option>
                    <option value={2}>متوسطة فأعلى</option>
                    <option value={3}>مرتفعة فأعلى</option>
                    <option value={4}>حرجة</option>
                  </select>
                </label>
                <label>
                  آخر بلاغ خلال
                  <select value={maxEventAgeH} onChange={(e) => setMaxEventAgeH(Number(e.target.value))}>
                    <option value={1}>ساعة</option>
                    <option value={3}>3 ساعات</option>
                    <option value={24}>24 ساعة</option>
                  </select>
                </label>
              </fieldset>
              <fieldset>
                <legend>جودة البيانات</legend>
                <label>
                  أدنى ثقة للمزود
                  <select value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))}>
                    <option value={0}>الكل</option>
                    <option value={0.5}>0.5</option>
                    <option value={0.8}>0.8</option>
                  </select>
                </label>
                <p className="muted small">القراءات الأقل ثقة أو الأقدم من {Math.round(meta.policy.maxAgeS / 60)} دقيقة تظهر رمادية متقطعة.</p>
              </fieldset>
            </details>
            <Legend scale={meta.scales[colorBy]} colorBy={colorBy} anyTraffic={anyTraffic} />
          </div>
          {(segmentSel || eventSel) && (
            <aside className="details" aria-live="polite">
              <button className="close" onClick={() => { setSegmentSel(null); setEventSel(null); }} aria-label="إغلاق">×</button>
              {segmentSel && network && <SegmentDetails k={segmentSel} network={network} speed={speed} events={state?.events ?? []} now={now} meta={meta} />}
              {eventSel && <EventDetails e={eventSel} network={network} />}
            </aside>
          )}
        </section>

        {panelOpen && (
          <aside className="panel">
            <nav className="tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="panel-body">
              {error && <div className="err">خطأ في جلب البيانات: {error}</div>}
              {tab === 'decision' && <DecisionPanel meta={meta} network={network} speed={speed} events={state?.events ?? []} weather={state?.weather ?? []} warnings={state?.warnings ?? []} now={now} summaries={summaries} tomtomHealth={tomtomHealth ?? null} onFly={(c) => setFlyTo({ center: c, zoom: 15, at: Date.now() })} />}
              {tab === 'districts' && <DistrictsPanel meta={meta} network={network} selected={selected} summaries={summaries} onToggle={toggleDistrict} onFly={(c) => setFlyTo({ center: c, zoom: 14, at: Date.now() })} />}
              {tab === 'alerts' && <AlertsPanel meta={meta} onFly={(c) => setFlyTo({ center: c, zoom: 15, at: Date.now() })} />}
              {tab === 'routes' && (
                <RoutesPanel
                  from={routeFrom}
                  to={routeTo}
                  pick={routePick}
                  onPick={setRoutePick}
                  route={route}
                  onRun={() => routeFrom && routeTo && runRoute(routeFrom, routeTo)}
                  onClear={() => { setRoute(null); setRouteFrom(null); setRouteTo(null); }}
                  simulation={!live}
                />
              )}
              {tab === 'sources' && <SourcesPanel meta={meta} onRefresh={refreshMeta} />}
              {tab === 'indicators' && <IndicatorsPanel meta={meta} />}
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}

function HistorySlider({ meta, value, onChange }: { meta: Meta; value: string | null; onChange: (v: string) => void }) {
  const { from, to, observations } = meta.history;
  if (!from || !to) {
    return <div className="timebar muted">لا يوجد سجل تاريخي للسرعات بعد. يبدأ التسجيل عند اتصال مصدر سرعات، ويُحفظ في الخادم. أما طقس الساعات الماضية فيظهر من أرشيف Open-Meteo.</div>;
  }
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  const v = value ? new Date(value).getTime() : b;
  return (
    <div className="timebar">
      <label>
        الاستعراض التاريخي ({observations.toLocaleString('ar-SA')} قراءة):
        <input type="range" min={a} max={b} step={5 * 60e3} value={v} onChange={(e) => onChange(new Date(Number(e.target.value)).toISOString())} />
      </label>
      <b>{timeAr(new Date(v).toISOString())}</b>
      <span className="muted small">بيانات مؤرشفة، وليست الحالة الآن. الأحداث لا تُعرض تاريخيًا في هذه النسخة.</span>
    </div>
  );
}

function ForecastNotice() {
  const [r, setR] = useState<Awaited<ReturnType<typeof api.forecast>> | null>(null);
  useEffect(() => void api.forecast().then(setR).catch(() => setR(null)), []);
  return (
    <div className="timebar forecast">
      <b>التنبؤ غير مفعّل.</b>{' '}
      {r ? `${r.readiness.reasonAr ?? ''}. تُفعَّل آفاق ${r.horizonsMin.join(' و')} دقيقة بعد ${r.readiness.requiredDays} يومًا من السجل، مع مقارنة بخط أساس واختبار زمني يمنع تسرب المستقبل.` : 'تعذّر جلب حالة الجاهزية.'}
      {' '}توقعات الطقس الساعية متاحة في بطاقة الحي، موسومة «متوقع».
    </div>
  );
}
