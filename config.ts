import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** قراءة ملف .env بسيطة (بلا اعتماديات). متغيرات البيئة الفعلية لها الأولوية. */
function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k!] !== undefined) continue;
    process.env[k!] = raw!.replace(/^['"]|['"]$/g, '');
  }
}

export const ROOT = resolve(import.meta.dirname, '../../..');
loadDotEnv(resolve(ROOT, '.env'));

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const int = (k: string, d: number) => {
  const v = Number.parseInt(env(k), 10);
  return Number.isFinite(v) ? v : d;
};

export type Mode = 'live' | 'simulation';

export const config = {
  mode: (env('MODE', 'live') === 'simulation' ? 'simulation' : 'live') as Mode,
  port: int('PORT', 8787),
  regionId: env('REGION', 'riyadh'),
  dataDir: resolve(ROOT, env('DATA_DIR', './data/runtime')),
  tomtomKey: env('TOMTOM_API_KEY'),
  tomtomFlowQuota: int('TOMTOM_FLOW_MONTHLY_QUOTA', 20000),
  tomtomIncidentsQuota: int('TOMTOM_INCIDENTS_MONTHLY_QUOTA', 2500),
  tomtomMonitorPoints: int('TOMTOM_MONITOR_POINTS', 12),
  tomtomRasterTiles: env('TOMTOM_RASTER_TILES', 'true') === 'true',
  ncmBaseUrl: env('NCM_EWS_BASE_URL'),
  ncmAuthHeader: env('NCM_EWS_AUTH_HEADER'),
  hereKey: env('HERE_API_KEY'),
  adminToken: env('ADMIN_TOKEN'),
  /** قائمة مفصولة بفواصل تُجرَّب بالترتيب */
  overpassEndpoints: env('OVERPASS_ENDPOINT', 'https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter')
    .split(',').map((s) => s.trim()).filter(Boolean),
  /** أقصى ضلع (بالدرجات) لمربع استعلام الطرق */
  /** مهل إعادة المحاولة على الخادم نفسه عند 429/502/503/504 */
  overpassRetryDelaysMs: env('OVERPASS_RETRY_DELAYS_MS', '15000,60000,120000').split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0),
  overpassTileDeg: Number(env('OVERPASS_TILE_DEG', '0.015')) || 0.015,
  osrmBase: env('OSRM_BASE', 'https://router.project-osrm.org'),
  roadsScope: env('ROADS_SCOPE', 'sample'),
  webDist: resolve(ROOT, 'apps/web/dist'),
};

/** ما يُسمح بإظهاره للواجهة: وجود المفتاح فقط، لا قيمته */
export const publicConfig = () => ({
  mode: config.mode,
  regionId: config.regionId,
  tomtomConfigured: !!config.tomtomKey,
  tomtomRasterTiles: !!config.tomtomKey && config.tomtomRasterTiles,
  ncmConfigured: !!config.ncmBaseUrl,
  hereConfigured: !!config.hereKey,
  adminConfigured: !!config.adminToken,
});
