import { describe, expect, it } from 'vitest';
import { overpass, tomtom, openMeteo, ncmEws, SegmentIndex, redactKey, splitBBox, type RoadSegment } from '../src/index.ts';

const now = new Date('2026-10-23T18:00:00Z');

// شارع ثنائي الاتجاه وطريق باتجاه واحد (من وسوم OSM)
const roadsResp: overpass.OverpassResponse = {
  elements: [
    { type: 'way', id: 1, tags: { highway: 'primary', name: 'طريق العليا', oneway: 'yes', lanes: '3', maxspeed: '70' },
      geometry: [{ lat: 24.69, lon: 46.68 }, { lat: 24.70, lon: 46.68 }] },
    { type: 'way', id: 2, tags: { highway: 'residential', name: 'شارع ١' },
      geometry: [{ lat: 24.695, lon: 46.681 }, { lat: 24.695, lon: 46.690 }] },
    { type: 'way', id: 3, tags: { highway: 'motorway', name: 'طريق الملك فهد' },
      geometry: [{ lat: 24.70, lon: 46.67 }, { lat: 24.69, lon: 46.67 }] },
  ],
};

describe('Overpass: الطرق والأحياء', () => {
  it('يقسم المستطيل إلى مربعات تغطيه دون تجاوز الضلع', () => {
    const tiles = splitBBox({ minLng: 46.66, minLat: 24.68, maxLng: 46.70, maxLat: 24.71 }, 0.015);
    expect(tiles).toHaveLength(3 * 2);
    for (const t of tiles) expect(t.maxLng - t.minLng).toBeLessThanOrEqual(0.015 + 1e-12);
    expect(Math.min(...tiles.map((t) => t.minLng))).toBe(46.66);
    expect(Math.max(...tiles.map((t) => t.maxLat))).toBeCloseTo(24.71, 12);
  });
  it('ينتقل إلى الخادم البديل عند فشل الرئيسي', async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return url.includes('primary') ? new Response('busy', { status: 503 }) : Response.json({ elements: [] });
    };
    await expect(overpass.runOverpass(fetcher, 'q', ['https://primary/x', 'https://mirror/x'], [0])).resolves.toEqual({ elements: [] });
    // محاولتان على الرئيسي (503 قابل لإعادة المحاولة) ثم البديل
    expect(calls).toEqual(['https://primary/x', 'https://primary/x', 'https://mirror/x']);
    await expect(overpass.runOverpass(fetcher, 'q', ['https://primary/x'], [])).rejects.toThrow('HTTP 503');
  });

  it('يحدد الاتجاهات من وسوم OSM', () => {
    expect(overpass.directionsFromTags({ oneway: 'yes' })).toEqual(['fwd']);
    expect(overpass.directionsFromTags({ oneway: '-1' })).toEqual(['bwd']);
    expect(overpass.directionsFromTags({ highway: 'motorway' })).toEqual(['fwd']);
    expect(overpass.directionsFromTags({ highway: 'primary', junction: 'roundabout' })).toEqual(['fwd']);
    expect(overpass.directionsFromTags({ highway: 'primary' })).toEqual(['fwd', 'bwd']);
  });
  it('يحوّل الطرق ويحسب الأطوال ويربطها بالأحياء ويكشف المداخل', () => {
    const district = { id: 'd1', regionId: 'riyadh', nameAr: 'العليا', geometry: { type: 'Polygon' as const, coordinates: [[[46.675, 24.685], [46.695, 24.685], [46.695, 24.697], [46.675, 24.697], [46.675, 24.685]] as [number, number][]] }, centroid: [46.685, 24.69] as [number, number], boundaryQuality: 'polygon' as const, sourceId: 'x', sourceRef: 'x' };
    const segs = overpass.parseRoads(roadsResp, 'riyadh', [district]);
    expect(segs).toHaveLength(3);
    const w1 = segs.find((s) => s.id === 'osm:w1')!;
    expect(w1.directions).toEqual(['fwd']);
    expect(w1.lanes).toBe(3);
    expect(w1.lengthM).toBeGreaterThan(1100);
    expect(w1.lengthM).toBeLessThan(1120);
    expect(w1.districtIds).toEqual(['d1']);
    expect(w1.isDistrictGateway).toBe(true); // يبدأ داخل الحي وينتهي خارجه
    expect(segs.find((s) => s.id === 'osm:w2')!.directions).toEqual(['fwd', 'bwd']);
  });
  it('يجمع حلقات العلاقة ويفضّل المضلع على النقطة لنفس الاسم', () => {
    const resp: overpass.OverpassResponse = { elements: [
      { type: 'node', id: 10, lat: 24.69, lon: 46.68, tags: { place: 'suburb', name: 'حي العليا' } },
      { type: 'relation', id: 20, tags: { boundary: 'administrative', admin_level: '10', name: 'العليا', 'name:en': 'Al Olaya' }, members: [
        { type: 'way', ref: 1, role: 'outer', geometry: [{ lat: 24.68, lon: 46.67 }, { lat: 24.68, lon: 46.69 }] },
        { type: 'way', ref: 2, role: 'outer', geometry: [{ lat: 24.70, lon: 46.69 }, { lat: 24.68, lon: 46.69 }] }, // معكوس
        { type: 'way', ref: 3, role: 'outer', geometry: [{ lat: 24.70, lon: 46.69 }, { lat: 24.70, lon: 46.67 }, { lat: 24.68, lon: 46.67 }] },
      ] },
      { type: 'node', id: 11, lat: 24.66, lon: 46.73, tags: { place: 'neighbourhood', name: 'الملز' } },
      { type: 'relation', id: 30, tags: { boundary: 'administrative', admin_level: '9', name: 'بلدية العليا' }, members: [] },
    ] };
    const ds = overpass.parseDistricts(resp, 'riyadh');
    expect(ds).toHaveLength(2);
    const olaya = ds.find((d) => d.nameAr === 'العليا')!;
    expect(olaya.boundaryQuality).toBe('polygon');
    expect(olaya.geometry?.type).toBe('Polygon');
    expect(ds.find((d) => d.nameAr === 'الملز')!.boundaryQuality).toBe('point_only');
    expect(ds.find((d) => d.nameAr === 'الملز')!.geometry).toBeNull();
  });
  it('تطبيع الأسماء العربية', () => {
    expect(overpass.normalizeArabicName('حي الإسكان')).toBe(overpass.normalizeArabicName('الاسكان'));
    expect(overpass.normalizeArabicName('الروضة')).toBe('الروضه');
  });
  it('ترتيب bbox في Overpass (جنوب,غرب,شمال,شرق)', () => {
    expect(overpass.overpassBBox({ minLng: 46, minLat: 24, maxLng: 47, maxLat: 25 })).toBe('24,46,25,47');
  });
});

describe('TomTom Flow Segment Data', () => {
  const segs: RoadSegment[] = overpass.parseRoads(roadsResp, 'riyadh');
  const idx = new SegmentIndex(segs);
  // صيغة flowSegmentData كما في الوثائق
  const resp: tomtom.TomTomFlowResponse = { flowSegmentData: {
    frc: 'FRC2', currentSpeed: 28, freeFlowSpeed: 64, currentTravelTime: 143, freeFlowTravelTime: 62, confidence: 0.92, roadClosure: false,
    coordinates: { coordinate: [{ latitude: 24.6905, longitude: 46.68004 }, { latitude: 24.6955, longitude: 46.68003 }, { latitude: 24.6995, longitude: 46.68002 }] } } };
  it('يطابق المقطع والاتجاه ويحفظ الحقول بوحداتها', () => {
    const r = tomtom.parseFlowSegment(resp, idx, now.toISOString());
    expect(r.obs?.segmentKey).toBe('osm:w1:fwd');
    expect(r.obs).toMatchObject({ currentSpeedKmh: 28, freeFlowSpeedKmh: 64, confidence: 0.92, provenance: 'live', sourceId: 'tomtom-flow' });
  });
  it('يرفض الاتجاه المعاكس على طريق باتجاه واحد', () => {
    const rev = { flowSegmentData: { ...resp.flowSegmentData, coordinates: { coordinate: [...resp.flowSegmentData.coordinates.coordinate].reverse() } } };
    expect(tomtom.parseFlowSegment(rev, idx, now.toISOString()).obs).toBeNull();
  });
  it('يطابق الاتجاه المعاكس bwd على شارع ثنائي الاتجاه', () => {
    const r = tomtom.parseFlowSegment({ flowSegmentData: { ...resp.flowSegmentData, coordinates: { coordinate: [
      { latitude: 24.69502, longitude: 46.689 }, { latitude: 24.69502, longitude: 46.685 }, { latitude: 24.69502, longitude: 46.682 }] } } }, idx, now.toISOString());
    expect(r.obs?.segmentKey).toBe('osm:w2:bwd');
  });
  it('لا يطابق نقطة بعيدة', () => {
    const far = { flowSegmentData: { ...resp.flowSegmentData, coordinates: { coordinate: [{ latitude: 24.8, longitude: 46.8 }, { latitude: 24.81, longitude: 46.8 }] } } };
    expect(tomtom.parseFlowSegment(far, idx, now.toISOString()).reason).toBe('no_osm_match');
  });
  it('ميزانية الطلبات: 20,000/شهر و12 نقطة', () => {
    expect(tomtom.pollingIntervalForBudget(20000, 12)).toBe(29);
    expect(tomtom.pollingIntervalForBudget(2500, 1)).toBe(20);
  });
  it('لا يُكشف المفتاح في الروابط المسجلة', () => {
    expect(redactKey(tomtom.flowSegmentUrl([46.6, 24.7], 'SECRET123'))).not.toContain('SECRET123');
  });
});

describe('TomTom Incident Details v5', () => {
  const idx = new SegmentIndex(overpass.parseRoads(roadsResp, 'riyadh'));
  const resp: tomtom.TomTomIncidentsResponse = { incidents: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[46.68, 24.691], [46.68, 24.695]] },
      properties: { id: 'abc', iconCategory: 1, magnitudeOfDelay: 3, events: [{ description: 'حادث', code: 201, iconCategory: 1 }],
        startTime: '2026-10-23T17:30:00Z', endTime: null, from: 'تقاطع أ', to: 'تقاطع ب', length: 420, delay: 380,
        probabilityOfOccurrence: 'certain', numberOfReports: 3, lastReportTime: '2026-10-23T17:55:00Z' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [46.67, 24.695] },
      properties: { id: 'cl1', iconCategory: 8, magnitudeOfDelay: 4, delay: 0, length: 0 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [46.685, 24.695] },
      properties: { id: 'fl1', iconCategory: 11, magnitudeOfDelay: 0 } },
  ] };
  it('يحوّل الأنواع والشدة ويربط المقاطع', () => {
    const ev = tomtom.parseIncidents(resp, idx, now.toISOString());
    expect(ev[0]).toMatchObject({ type: 'accident', severity: 'high', delayS: 380, verification: 'provider_reported', isClosure: false });
    expect(ev[0]!.segmentKeys).toContain('osm:w1:fwd');
    expect(ev[1]).toMatchObject({ type: 'road_closure', isClosure: true, severity: 'critical', delayS: null });
    expect(ev[2]).toMatchObject({ type: 'flooding', verification: 'provider_reported' });
  });
  it('رابط الحوادث يطلب العربية والحاضر فقط', () => {
    const u = tomtom.incidentsUrl({ minLng: 46.45, minLat: 24.45, maxLng: 47, maxLat: 25.05 }, 'k');
    expect(u).toContain('language=ar');
    expect(u).toContain('timeValidityFilter=present');
    expect(u).toContain('bbox=46.45,24.45,47,25.05');
  });
});

describe('Open-Meteo', () => {
  const r: openMeteo.OpenMeteoResponse = {
    latitude: 24.71, longitude: 46.67, timezone: 'GMT', utc_offset_seconds: 0,
    current: { time: '2026-10-23T17:45', interval: 900, temperature_2m: 29.1, precipitation: 0, rain: 0, showers: 0, weather_code: 1, wind_speed_10m: 14.2, wind_gusts_10m: 31.0 },
    hourly: { time: ['2026-10-23T17:00', '2026-10-23T18:00', '2026-10-23T19:00'], temperature_2m: [30, 29, 28], precipitation: [0, 0, 1.2], rain: [0, 0, 1], showers: [0, 0, 0.2],
      weather_code: [1, 1, 61], wind_speed_10m: [10, 12, 15], wind_gusts_10m: [20, 25, 40], visibility: [24000, 18000, null] },
  };
  it('يفصل الحالي والتاريخي والمتوقع ويأخذ الرؤية من الساعة الأقرب', () => {
    const p = openMeteo.parseForecast(r, 'd1', now.toISOString(), now);
    expect(p.current).toMatchObject({ provenance: 'live', windGustsKmh: 31, visibilityM: 18000, observedAt: '2026-10-23T17:45:00.000Z' });
    expect(p.hourly.map((h) => h.provenance)).toEqual(['historical', 'historical', 'forecast']);
    expect(p.hourly[2]!.visibilityM).toBeNull(); // القيمة المفقودة تبقى null
  });
  it('رابط متعدد المواقع', () => {
    expect(openMeteo.forecastUrl([[46.6, 24.7], [46.7, 24.8]])).toContain('latitude=24.7000,24.8000');
  });
});

describe('المركز الوطني للأرصاد (EWS)', () => {
  it('يصفّي إنذارات الرياض ويُبقي نطاقها على مستوى المنطقة/المحافظة', () => {
    const w = ncmEws.parseNotifications([
      { Id: 1, alertTypeAr: 'أمطار غزيرة', fromDate: '2026-10-23T12:00:00Z', toDate: '2026-10-23T23:00:00Z', alertStatusAr: 'ساري', regionAR: 'منطقة الرياض',
        AlertHazards: [{ id: 1, descriptionAr: 'سيول', descriptionEn: 'Floods' }], AlertActions: [{ id: 2, descriptionAr: 'الابتعاد عن الأودية', descriptionEn: '' }],
        Governorates: [{ nameAr: 'الرياض' }] },
      { Id: 2, alertTypeAr: 'غبار', fromDate: '2026-10-23T12:00:00Z', toDate: '2026-10-23T23:00:00Z', regionAR: 'المنطقة الشرقية' },
    ], now.toISOString());
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ titleAr: 'أمطار غزيرة', spatialScope: 'governorate', hazardsAr: ['سيول'] });
  });
});
