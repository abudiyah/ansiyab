/**
 * نموذج المجال لمنصة انسياب.
 *
 * وحدة التحليل: مقطع طريق + اتجاه حركة (SegmentDirection).
 * وحدة التجميع والمقارنة: الحي (District) ضمن منطقة (Region).
 * كل سجل يحمل مصدره ووقت رصده ووقت استلامه وأصله (حي/تاريخي/متوقع/محاكاة).
 */

export type ISODateTime = string;
export type LngLat = [lng: number, lat: number];

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export type LineString = { type: 'LineString'; coordinates: LngLat[] };
export type Polygon = { type: 'Polygon'; coordinates: LngLat[][] };
export type MultiPolygon = { type: 'MultiPolygon'; coordinates: LngLat[][][] };
export type Point = { type: 'Point'; coordinates: LngLat };

/** أصل السجل. لا يُخلط «simulated» مع غيره دون وسم صريح. */
export type Provenance = 'live' | 'historical' | 'forecast' | 'simulated';

/** حالة التحقق لحدث أو بلاغ. */
export type VerificationStatus = 'verified' | 'provider_reported' | 'unverified';

// ───────────────────────── المنطقة والأحياء والطرق ─────────────────────────

/** منطقة/مدينة قابلة للإضافة دون إعادة بناء التطبيق. */
export interface Region {
  id: string;
  nameAr: string;
  nameEn: string;
  bbox: BBox;
  center: LngLat;
  timezone: string;
  /** أحياء العينة الأولى (أسماء كما في OSM) قبل التوسع لكامل المدينة. */
  sampleDistricts: { nameAr: string; nameEn: string; rationaleAr: string }[];
}

export type BoundaryQuality = 'polygon' | 'point_only';

export interface District {
  id: string;
  regionId: string;
  nameAr: string;
  nameEn?: string;
  /** null عندما لا يوجد مضلع موثوق: لا نختلق حدودًا. */
  geometry: Polygon | MultiPolygon | null;
  centroid: LngLat;
  boundaryQuality: BoundaryQuality;
  sourceId: string;
  sourceRef: string;
}

export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'unclassified'
  | 'link';

export type TravelDirection = 'fwd' | 'bwd';

export interface RoadSegment {
  id: string;
  regionId: string;
  nameAr?: string;
  nameEn?: string;
  ref?: string;
  roadClass: RoadClass;
  /** اتجاهات الحركة المسموحة على المقطع. fwd = باتجاه ترتيب نقاط الهندسة. */
  directions: TravelDirection[];
  geometry: LineString;
  lengthM: number;
  lanes?: number;
  maxSpeedKmh?: number;
  districtIds: string[];
  /** المقطع يعبر حدود حي (مدخل/مخرج). */
  isDistrictGateway: boolean;
  sourceId: string;
  sourceRef: string;
}

/** مفتاح وحدة التحليل: `${segmentId}:${direction}` */
export type SegmentDirectionKey = `${string}:${TravelDirection}`;

export const segmentKey = (segmentId: string, dir: TravelDirection): SegmentDirectionKey =>
  `${segmentId}:${dir}`;

export function parseSegmentKey(key: SegmentDirectionKey): { segmentId: string; direction: TravelDirection } {
  const idx = key.lastIndexOf(':');
  return { segmentId: key.slice(0, idx), direction: key.slice(idx + 1) as TravelDirection };
}

// ───────────────────────── القياسات ─────────────────────────

interface ObservationBase {
  sourceId: string;
  /** وقت الرصد كما يعلنه المصدر (أو أفضل تقدير موثّق له). */
  observedAt: ISODateTime;
  /** وقت استلام المنصة للقراءة. */
  receivedAt: ISODateTime;
  provenance: Provenance;
}

export interface SpeedObservation extends ObservationBase {
  segmentKey: SegmentDirectionKey;
  currentSpeedKmh: number | null;
  freeFlowSpeedKmh: number | null;
  currentTravelTimeS: number | null;
  freeFlowTravelTimeS: number | null;
  /** ثقة المزود 0..1 */
  confidence: number | null;
  roadClosure: boolean;
  /** مسافة مطابقة نقطة المزود بمقطع OSM بالمتر */
  matchDistanceM?: number;
}

/** قياسات عدادات/حساسات. لا تُشتق من لون الازدحام. */
export interface FlowObservation extends ObservationBase {
  segmentKey: SegmentDirectionKey;
  volumeVehPerHour: number | null;
  occupancyPct: number | null;
  densityVehPerKmPerLane: number | null;
  densityMethod: 'measured' | 'estimated_q_over_v' | null;
  meanWaitS: number | null;
  p95WaitS: number | null;
  queueLengthM: number | null;
  queueVehicles: number | null;
  stopsPerVehicle: number | null;
}

export type TrafficEventType =
  | 'accident'
  | 'breakdown'
  | 'roadworks'
  | 'lane_closure'
  | 'road_closure'
  | 'jam'
  | 'flooding'
  | 'weather_hazard'
  | 'other';

export type Severity = 'low' | 'moderate' | 'high' | 'critical' | 'unknown';

export interface TrafficEvent {
  id: string;
  sourceId: string;
  externalId: string;
  type: TrafficEventType;
  severity: Severity;
  geometry: Point | LineString;
  startTime: ISODateTime | null;
  endTime: ISODateTime | null;
  lastReportTime: ISODateTime | null;
  receivedAt: ISODateTime;
  verification: VerificationStatus;
  probability?: 'certain' | 'probable' | 'risk_of' | 'improbable';
  numberOfReports?: number | null;
  delayS: number | null;
  lengthM: number | null;
  lanesAffected: number | null;
  isClosure: boolean;
  descriptionAr?: string;
  descriptionEn?: string;
  fromName?: string;
  toName?: string;
  segmentKeys: SegmentDirectionKey[];
  districtIds: string[];
  provenance: Provenance;
  /** أوقات دورة حياة الحدث، عند توافرها من الجهة المختصة */
  verifiedAt?: ISODateTime | null;
  respondedAt?: ISODateTime | null;
  clearedAt?: ISODateTime | null;
  flowRestoredAt?: ISODateTime | null;
}

export interface WeatherObservation extends ObservationBase {
  locationId: string;
  point: LngLat;
  kind: 'current' | 'hourly';
  /** للتوقعات: الوقت المستهدف */
  validAt: ISODateTime;
  temperatureC: number | null;
  precipitationMm: number | null;
  rainMm: number | null;
  windSpeedKmh: number | null;
  windGustsKmh: number | null;
  visibilityM: number | null;
  weatherCode: number | null;
  dustUgM3: number | null;
  /** دقة النموذج المكانية التقريبية بالكيلومتر. القراءة نموذجية وليست محطة. */
  spatialResolutionKm: number | null;
}

export interface WeatherWarning {
  id: string;
  sourceId: string;
  titleAr: string;
  hazardsAr: string[];
  actionsAr: string[];
  regionAr: string;
  governoratesAr: string[];
  from: ISODateTime;
  to: ISODateTime;
  statusAr: string;
  /** الإنذار على مستوى المنطقة/المحافظة، ولا يُسقط على الحي كقياس */
  spatialScope: 'region' | 'governorate' | 'municipality';
  receivedAt: ISODateTime;
  provenance: Provenance;
}

export interface WaterObservation {
  id: string;
  sourceId: string;
  point: LngLat;
  observedAt: ISODateTime;
  receivedAt: ISODateTime;
  depthCm: number | null;
  verification: VerificationStatus;
  causesClosure: boolean;
  segmentKeys: SegmentDirectionKey[];
  provenance: Provenance;
}

export interface CriticalFacility {
  id: string;
  kind: 'hospital' | 'clinic' | 'fire_station' | 'police' | 'civil_defense' | 'school';
  nameAr?: string;
  point: LngLat;
  sourceId: string;
}

// ───────────────────────── التنبيهات والإجراءات ─────────────────────────

export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface ActionLogEntry {
  at: ISODateTime;
  actor: string;
  action: 'acknowledge' | 'note' | 'resolve' | 'reopen' | 'auto_resolve';
  note?: string;
  outcome?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Alert {
  id: string;
  ruleId: string;
  /** مفتاح منع التكرار: قاعدة + موقع */
  dedupeKey: string;
  status: AlertStatus;
  severity: Severity;
  reasonAr: string;
  locationAr: string;
  geometry: Point | LineString | null;
  districtIds: string[];
  firstDetectedAt: ISODateTime;
  lastEvaluatedAt: ISODateTime;
  sourceIds: string[];
  confidence: Confidence;
  suggestedActionAr: string;
  evidence: Record<string, unknown>;
  log: ActionLogEntry[];
  provenance: Provenance;
}
