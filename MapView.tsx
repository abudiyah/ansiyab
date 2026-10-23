import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MLMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type * as GeoJSON from 'geojson';
import { maplibreStepExpression, segmentKey, segmentSpeedIndicators, type ColorScale, type LngLat, type SegmentDirectionKey, type SpeedObservation, type TrafficEvent, type WeatherObservation } from '@ansiyab/core';
import type { Meta, Network, RouteResponse } from './api.ts';
import { EVENT_TYPE_AR } from './format.ts';

try {
  // إضافة تشكيل النص العربي وترتيبه من اليمين لليسار في تسميات الخريطة
  void maplibregl.setRTLTextPlugin('/vendor/mapbox-gl-rtl-text.js', true);
} catch {
  /* مُحمّل مسبقًا */
}

export type ColorBy = 'sri' | 'density';
export interface LayerToggles {
  traffic: boolean;
  providerTiles: boolean;
  districts: boolean;
  events: boolean;
  weather: boolean;
  facilities: boolean;
  routes: boolean;
}

const BASEMAP_URL = 'https://tiles.openfreemap.org/styles/liberty';

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef1f2' } }],
};

/** يجلب نمط الخريطة الأساسية ويحوّل التسميات إلى العربية؛ ويعود لنمط بسيط إن تعذّر الوصول */
async function loadBasemap(): Promise<{ style: StyleSpecification | string; ok: boolean; error?: string }> {
  try {
    const r = await fetch(BASEMAP_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const style = (await r.json()) as StyleSpecification;
    for (const l of style.layers) {
      if (l.type === 'symbol' && l.layout && 'text-field' in l.layout) {
        (l.layout as Record<string, unknown>)['text-field'] = ['coalesce', ['get', 'name:ar'], ['get', 'name']];
      }
    }
    return { style, ok: true };
  } catch (e) {
    return { style: FALLBACK_STYLE, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function segmentsGeoJSON(network: Network, speed: Map<SegmentDirectionKey, SpeedObservation>, now: Date, maxAgeS: number, minConfidence: number) {
  const features: GeoJSON.Feature[] = [];
  for (const s of network.segments) {
    for (const d of s.directions) {
      const key = segmentKey(s.id, d);
      const obs = speed.get(key);
      const ind = segmentSpeedIndicators(obs, now, { maxAgeS });
      const lowConf = obs?.confidence != null && obs.confidence < minConfidence;
      const coords = d === 'fwd' ? s.geometry.coordinates : [...s.geometry.coordinates].reverse();
      features.push({
        type: 'Feature',
        id: features.length,
        geometry: { type: 'LineString', coordinates: coords },
        properties: {
          key,
          segId: s.id,
          dir: d,
          cls: s.roadClass,
          // لا نضع قيمة عند الغياب: التعبير اللوني يعرض الرمادي
          ...(ind.sri.available && !lowConf ? { sri: ind.sri.value } : {}),
          known: ind.sri.available && !lowConf ? 1 : 0,
          twoWay: s.directions.length === 2 ? 1 : 0,
          gateway: s.isDistrictGateway ? 1 : 0,
        },
      });
    }
  }
  return { type: 'FeatureCollection' as const, features };
}

function districtsGeoJSON(network: Network, selected: string[], sample: string[]) {
  return {
    type: 'FeatureCollection' as const,
    features: network.districts
      .filter((d) => d.geometry)
      .map((d) => ({
        type: 'Feature' as const,
        geometry: d.geometry!,
        properties: { id: d.id, name: d.nameAr, selected: selected.includes(d.id) ? 1 : 0, sample: sample.includes(d.id) ? 1 : 0 },
      })),
  };
}

interface Props {
  meta: Meta;
  network: Network | null;
  speed: Map<SegmentDirectionKey, SpeedObservation>;
  events: TrafficEvent[];
  weather: WeatherObservation[];
  now: Date;
  colorBy: ColorBy;
  layers: LayerToggles;
  minConfidence: number;
  selectedDistricts: string[];
  route: RouteResponse | null;
  routePick: 'from' | 'to' | null;
  flyTo: { center: LngLat; zoom?: number; at: number } | null;
  onSegment: (key: SegmentDirectionKey) => void;
  onDistrict: (id: string) => void;
  onEvent: (e: TrafficEvent) => void;
  onMapPick: (p: LngLat) => void;
  onBasemapStatus: (s: { ok: boolean; error?: string }) => void;
}

export function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const cb = useRef(p);
  cb.current = p;

  useEffect(() => {
    let disposed = false;
    void loadBasemap().then(({ style, ok, error }) => {
      if (disposed || !el.current) return;
      cb.current.onBasemapStatus({ ok, error });
      const m = new maplibregl.Map({
        container: el.current,
        style,
        center: p.meta.region.center,
        zoom: 11,
        maxBounds: [
          [p.meta.region.bbox.minLng - 0.3, p.meta.region.bbox.minLat - 0.3],
          [p.meta.region.bbox.maxLng + 0.3, p.meta.region.bbox.maxLat + 0.3],
        ],
        attributionControl: { compact: true, customAttribution: 'بيانات الطرق والأحياء © OpenStreetMap contributors (ODbL)' },
      });
      map.current = m;
      // للاختبارات الآلية فقط (?e2e=1)
      if (new URLSearchParams(location.search).has('e2e')) (window as unknown as { __map: MLMap }).__map = m;
      m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-left');
      m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      // تحديد الموقع لا يعمل إلا بعد ضغط المستخدم وموافقة المتصفح
      m.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-left');
      m.on('load', () => {
        m.addSource('districts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'districts-fill', type: 'fill', source: 'districts', paint: { 'fill-color': ['case', ['==', ['get', 'selected'], 1], '#0b5d5e', '#5d6d7e'], 'fill-opacity': ['case', ['==', ['get', 'selected'], 1], 0.12, ['==', ['get', 'sample'], 1], 0.05, 0.015] } });
        m.addLayer({ id: 'districts-line', type: 'line', source: 'districts', paint: { 'line-color': ['case', ['==', ['get', 'selected'], 1], '#0b5d5e', '#7f8c8d'], 'line-width': ['case', ['==', ['get', 'selected'], 1], 2.5, ['==', ['get', 'sample'], 1], 1.4, 0.6], 'line-dasharray': [3, 2] } });

        if (cb.current.meta.config.tomtomRasterTiles) {
          m.addSource('tomtom', { type: 'raster', tiles: ['/api/tiles/tomtom/flow/{z}/{x}/{y}.png'], tileSize: 256, attribution: 'حركة المرور © TomTom' });
          m.addLayer({ id: 'tomtom', type: 'raster', source: 'tomtom', paint: { 'raster-opacity': 0.85 }, layout: { visibility: 'none' } });
        }

        // إزاحة كل اتجاه إلى يمين حركته (حركة يمينية)؛ zoom يجب أن يكون في أعلى التعبير
        const OFFSET: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 12, ['case', ['==', ['get', 'twoWay'], 1], 1, 0], 16, ['case', ['==', ['get', 'twoWay'], 1], 4, 0]];
        m.addSource('segments', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        const width: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'cls'], ['motorway', 'trunk'], 2.5, ['primary', 'secondary'], 1.8, 0.8], 16, ['match', ['get', 'cls'], ['motorway', 'trunk'], 7, ['primary', 'secondary'], 5, 3]];
        // اللون الرمادي المتقطع للمقاطع بلا بيانات (رمز مساند للون)
        m.addLayer({ id: 'segments-unknown', type: 'line', source: 'segments', filter: ['==', ['get', 'known'], 0], paint: { 'line-color': '#9aa0a6', 'line-width': width, 'line-dasharray': [1.5, 1.5], 'line-offset': OFFSET }, layout: { 'line-cap': 'butt' } });
        m.addLayer({ id: 'segments-known', type: 'line', source: 'segments', filter: ['==', ['get', 'known'], 1], paint: { 'line-color': '#1a9850', 'line-width': width, 'line-offset': OFFSET }, layout: { 'line-cap': 'round' } });
        m.addLayer({ id: 'segments-hit', type: 'line', source: 'segments', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 10, 'line-offset': OFFSET } });

        m.addSource('facilities', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'facilities', type: 'circle', source: 'facilities', paint: { 'circle-radius': 5, 'circle-color': ['match', ['get', 'kind'], 'hospital', '#e74c3c', 'fire_station', '#f39c12', 'police', '#2c3e50', '#95a5a6'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });

        m.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'routes-casing', type: 'line', source: 'routes', paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': 0.9 } });
        m.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': ['case', ['==', ['get', 'excluded'], 1], '#7b0000', ['==', ['get', 'rank'], 1], '#0b5d5e', '#5dade2'], 'line-width': 5, 'line-dasharray': ['case', ['==', ['get', 'excluded'], 1], ['literal', [1, 1]], ['literal', [1, 0]]] } });

        m.on('click', 'segments-hit', (e) => {
          const f = e.features?.[0];
          if (f && !cb.current.routePick) cb.current.onSegment(f.properties.key as SegmentDirectionKey);
        });
        m.on('click', 'districts-fill', (e) => {
          const hitSeg = m.queryRenderedFeatures(e.point, { layers: ['segments-hit'] }).length;
          const f = e.features?.[0];
          if (f && !hitSeg && !cb.current.routePick) cb.current.onDistrict(f.properties.id as string);
        });
        m.on('click', (e) => cb.current.routePick && cb.current.onMapPick([e.lngLat.lng, e.lngLat.lat]));
        for (const id of ['segments-hit', 'districts-fill']) {
          m.on('mouseenter', id, () => (m.getCanvas().style.cursor = 'pointer'));
          m.on('mouseleave', id, () => (m.getCanvas().style.cursor = ''));
        }
        setReady(true);
      });
    });
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // التلوين حسب المؤشر المختار
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const scale: ColorScale = p.meta.scales[p.colorBy];
    m.setPaintProperty('segments-known', 'line-color', maplibreStepExpression(scale, p.colorBy === 'sri' ? 'sri' : 'density') as maplibregl.ExpressionSpecification);
  }, [ready, p.colorBy, p.meta]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !p.network) return;
    (m.getSource('segments') as GeoJSONSource).setData(segmentsGeoJSON(p.network, p.speed, p.now, p.meta.policy.maxAgeS, p.minConfidence));
  }, [ready, p.network, p.speed, p.now, p.minConfidence, p.meta.policy.maxAgeS]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !p.network) return;
    (m.getSource('districts') as GeoJSONSource).setData(districtsGeoJSON(p.network, p.selectedDistricts, p.meta.sampleDistrictIds));
    (m.getSource('facilities') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: p.network.facilities.filter((f) => f.kind !== 'clinic').map((f) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: f.point }, properties: { kind: f.kind, name: f.nameAr ?? '' } })),
    });
  }, [ready, p.network, p.selectedDistricts, p.meta.sampleDistrictIds]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    for (const r of p.route?.routes ?? []) {
      const a = p.route!.assessments.find((x) => x.routeId === r.id);
      fc.features.push({ type: 'Feature', geometry: r.geometry, properties: { id: r.id, rank: a?.rank ?? 99, excluded: a?.excluded ? 1 : 0 } });
    }
    fc.features.sort((x, y) => (y.properties!.rank as number) - (x.properties!.rank as number));
    (m.getSource('routes') as GeoJSONSource).setData(fc);
  }, [ready, p.route]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const vis = (id: string, on: boolean) => m.getLayer(id) && m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    for (const id of ['segments-unknown', 'segments-known', 'segments-hit']) vis(id, p.layers.traffic);
    for (const id of ['districts-fill', 'districts-line']) vis(id, p.layers.districts);
    vis('facilities', p.layers.facilities);
    vis('tomtom', p.layers.providerTiles);
    for (const id of ['routes', 'routes-casing']) vis(id, p.layers.routes);
  }, [ready, p.layers]);

  // الأحداث والطقس كعلامات HTML (رمز + لون) حتى لا تعتمد على خطوط الخريطة الأساسية
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    markers.current.forEach((x) => x.remove());
    markers.current = [];
    if (p.layers.events) {
      for (const e of p.events) {
        const t = EVENT_TYPE_AR[e.type] ?? EVENT_TYPE_AR.other!;
        const div = document.createElement('button');
        div.className = `ev-marker${e.isClosure ? ' closure' : ''}${e.provenance === 'simulated' ? ' sim' : ''}`;
        div.style.background = t.color;
        div.textContent = t.glyph;
        div.title = `${t.label}${e.provenance === 'simulated' ? ' (محاكاة)' : ''}`;
        div.setAttribute('aria-label', div.title);
        div.onclick = (ev) => {
          ev.stopPropagation();
          cb.current.onEvent(e);
        };
        const at = e.geometry.type === 'Point' ? e.geometry.coordinates : e.geometry.coordinates[Math.floor(e.geometry.coordinates.length / 2)]!;
        markers.current.push(new maplibregl.Marker({ element: div }).setLngLat(at).addTo(m));
      }
    }
    if (p.layers.weather) {
      for (const w of p.weather) {
        const div = document.createElement('div');
        div.className = `wx-marker${w.provenance === 'simulated' ? ' sim' : ''}`;
        const vis = w.visibilityM != null ? `${(w.visibilityM / 1000).toFixed(1)} كم` : '—';
        div.innerHTML = `<b>☁</b> ${w.precipitationMm != null ? w.precipitationMm.toFixed(1) + ' مم' : '—'} · ༄ ${w.windGustsKmh != null ? Math.round(w.windGustsKmh) + ' كم/س' : '—'} · 👁 ${vis}`;
        div.title = `طقس نموذجي (${w.sourceId}) – ${w.provenance === 'simulated' ? 'محاكاة' : w.kind === 'current' ? 'حالي' : 'ساعي'}`;
        markers.current.push(new maplibregl.Marker({ element: div, anchor: 'bottom', offset: [0, -14] }).setLngLat(w.point).addTo(m));
      }
    }
    if (p.layers.districts && p.network) {
      for (const d of p.network.districts.filter((x) => p.meta.sampleDistrictIds.includes(x.id) || p.selectedDistricts.includes(x.id))) {
        const div = document.createElement('div');
        div.className = `district-label${d.boundaryQuality === 'point_only' ? ' point-only' : ''}`;
        div.textContent = d.nameAr + (d.boundaryQuality === 'point_only' ? ' (بلا حدود)' : '');
        div.onclick = () => cb.current.onDistrict(d.id);
        markers.current.push(new maplibregl.Marker({ element: div }).setLngLat(d.centroid).addTo(m));
      }
    }
  }, [ready, p.events, p.weather, p.layers.events, p.layers.weather, p.layers.districts, p.network, p.selectedDistricts, p.meta.sampleDistrictIds]);

  useEffect(() => {
    if (ready && p.flyTo) map.current?.flyTo({ center: p.flyTo.center, zoom: p.flyTo.zoom ?? 14 });
  }, [ready, p.flyTo]);

  useEffect(() => {
    if (map.current) map.current.getCanvas().style.cursor = p.routePick ? 'crosshair' : '';
  }, [p.routePick]);

  return <div ref={el} className="map" role="application" aria-label="خريطة الرياض التفاعلية" />;
}
