-- منصة انسياب: مخطط PostgreSQL + PostGIS للتشغيل الفعلي.
-- النسخة الأولى تخزن في ملفات JSON/JSONL (apps/server/src/store.ts) بنفس الكيانات،
-- وهذا المخطط هو الهدف عند الانتقال إلى التشغيل (المرحلة 7 في docs/ROADMAP.md).
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE region (
  id text PRIMARY KEY,
  name_ar text NOT NULL,
  name_en text,
  bbox geometry(Polygon, 4326) NOT NULL,
  timezone text NOT NULL
);

CREATE TABLE source (
  id text PRIMARY KEY,
  name_ar text NOT NULL,
  domain text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('connected_tested','needs_key','needs_agreement','unverified','unavailable')),
  max_age_s integer,
  terms_ar text,
  docs jsonb,
  verified_at date
);

CREATE TABLE source_test (
  id bigserial PRIMARY KEY,
  source_id text REFERENCES source(id),
  tested_at timestamptz NOT NULL,
  ok boolean NOT NULL,
  http_status integer,
  latency_ms integer,
  fields_found text[],
  fields_missing text[],
  detail text
);

CREATE TABLE district (
  id text PRIMARY KEY,
  region_id text REFERENCES region(id),
  name_ar text NOT NULL,
  name_en text,
  geom geometry(MultiPolygon, 4326),         -- NULL عند غياب حدود موثوقة
  centroid geometry(Point, 4326) NOT NULL,
  boundary_quality text NOT NULL CHECK (boundary_quality IN ('polygon','point_only')),
  source_id text REFERENCES source(id),
  source_ref text
);
CREATE INDEX ON district USING gist (geom);

CREATE TABLE road_segment (
  id text PRIMARY KEY,
  region_id text REFERENCES region(id),
  name_ar text, name_en text, ref text,
  road_class text NOT NULL,
  directions text[] NOT NULL,                 -- {fwd} أو {bwd} أو {fwd,bwd}
  geom geometry(LineString, 4326) NOT NULL,
  length_m double precision NOT NULL,
  lanes smallint,
  max_speed_kmh smallint,
  is_district_gateway boolean NOT NULL DEFAULT false,
  source_id text REFERENCES source(id),
  source_ref text
);
CREATE INDEX ON road_segment USING gist (geom);

CREATE TABLE segment_district (
  segment_id text REFERENCES road_segment(id),
  district_id text REFERENCES district(id),
  PRIMARY KEY (segment_id, district_id)
);

-- وحدة التحليل: مقطع + اتجاه
CREATE TABLE speed_observation (
  segment_id text REFERENCES road_segment(id),
  direction text NOT NULL CHECK (direction IN ('fwd','bwd')),
  source_id text REFERENCES source(id),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('live','historical','forecast','simulated')),
  current_speed_kmh real,
  free_flow_speed_kmh real,
  current_travel_time_s real,
  free_flow_travel_time_s real,
  confidence real,
  road_closure boolean NOT NULL DEFAULT false,
  match_distance_m real,
  PRIMARY KEY (segment_id, direction, source_id, observed_at)
);
-- للتشغيل: تقسيم زمني شهري (PARTITION BY RANGE (observed_at)) أو TimescaleDB

CREATE TABLE flow_observation (
  segment_id text REFERENCES road_segment(id),
  direction text NOT NULL CHECK (direction IN ('fwd','bwd')),
  source_id text REFERENCES source(id),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  provenance text NOT NULL,
  volume_veh_h real, occupancy_pct real,
  density_veh_km_lane real, density_method text CHECK (density_method IN ('measured','estimated_q_over_v')),
  mean_wait_s real, p95_wait_s real, queue_length_m real, queue_vehicles real, stops_per_vehicle real,
  PRIMARY KEY (segment_id, direction, source_id, observed_at)
);

CREATE TABLE traffic_event (
  id text PRIMARY KEY,                       -- source_id:external_id (منع التكرار)
  source_id text REFERENCES source(id),
  external_id text NOT NULL,
  type text NOT NULL,
  severity text NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL,
  start_time timestamptz, end_time timestamptz, last_report_time timestamptz,
  first_received_at timestamptz NOT NULL, last_received_at timestamptz NOT NULL,
  verification text NOT NULL CHECK (verification IN ('verified','provider_reported','unverified')),
  probability text, number_of_reports integer,
  delay_s real, length_m real, lanes_affected smallint, is_closure boolean NOT NULL,
  description_ar text, from_name text, to_name text,
  verified_at timestamptz, responded_at timestamptz, cleared_at timestamptz, flow_restored_at timestamptz,
  provenance text NOT NULL,
  UNIQUE (source_id, external_id)
);
CREATE INDEX ON traffic_event USING gist (geom);
CREATE TABLE event_segment (event_id text REFERENCES traffic_event(id), segment_id text, direction text, PRIMARY KEY (event_id, segment_id, direction));

CREATE TABLE weather_observation (
  location_id text NOT NULL,
  source_id text REFERENCES source(id),
  geom geometry(Point, 4326) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('current','hourly')),
  valid_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  provenance text NOT NULL,
  temperature_c real, precipitation_mm real, rain_mm real, wind_speed_kmh real, wind_gusts_kmh real,
  visibility_m real, weather_code smallint, dust_ug_m3 real, spatial_resolution_km real,
  PRIMARY KEY (location_id, source_id, kind, valid_at, received_at)
);

CREATE TABLE weather_warning (
  id text PRIMARY KEY,
  source_id text REFERENCES source(id),
  title_ar text, hazards_ar text[], actions_ar text[],
  region_ar text, governorates_ar text[],
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL,
  status_ar text, spatial_scope text NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE TABLE water_observation (
  id text PRIMARY KEY,
  source_id text REFERENCES source(id),
  geom geometry(Point, 4326) NOT NULL,
  observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
  depth_cm real,
  verification text NOT NULL,
  causes_closure boolean NOT NULL DEFAULT false
);

CREATE TABLE critical_facility (
  id text PRIMARY KEY, kind text NOT NULL, name_ar text,
  geom geometry(Point, 4326) NOT NULL, source_id text REFERENCES source(id)
);

CREATE TABLE alert_rule_config (
  rule_id text PRIMARY KEY, enabled boolean NOT NULL, params jsonb NOT NULL,
  persistence_s integer NOT NULL, clear_after_s integer NOT NULL, cooldown_s integer NOT NULL,
  updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert (
  id text PRIMARY KEY,
  rule_id text NOT NULL,
  dedupe_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
  severity text NOT NULL,
  reason_ar text NOT NULL, location_ar text,
  geom geometry(Geometry, 4326),
  district_ids text[],
  first_detected_at timestamptz NOT NULL, last_evaluated_at timestamptz NOT NULL,
  source_ids text[] NOT NULL, confidence text NOT NULL,
  suggested_action_ar text, evidence jsonb, provenance text NOT NULL
);
CREATE UNIQUE INDEX alert_one_active_per_key ON alert (dedupe_key) WHERE status <> 'resolved';

CREATE TABLE alert_action (
  id bigserial PRIMARY KEY,
  alert_id text REFERENCES alert(id),
  at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL CHECK (action IN ('acknowledge','note','resolve','reopen','auto_resolve')),
  note text, outcome text
);

-- سجل تدقيق لكل إجراء معدِّل (بدون بيانات شخصية للمواطنين)
CREATE TABLE audit_log (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor text, type text NOT NULL, payload jsonb);
