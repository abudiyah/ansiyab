import type { LngLat, LineString } from '../domain/types.ts';
import { getJson, type Fetcher } from './http.ts';

export const OSRM_ID = 'osrm-demo';
export const OSRM_DEMO = 'https://router.project-osrm.org';

export interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: LineString;
  legs: { summary: string }[];
}
export interface OsrmResponse {
  code: string;
  message?: string;
  routes: OsrmRoute[];
}

export function routeUrl(from: LngLat, to: LngLat, base = OSRM_DEMO): string {
  return `${base}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?alternatives=3&overview=full&geometries=geojson&steps=false`;
}

export async function fetchRoutes(fetcher: Fetcher, from: LngLat, to: LngLat, base?: string): Promise<OsrmRoute[]> {
  const r = await getJson<OsrmResponse>(fetcher, OSRM_ID, routeUrl(from, to, base));
  if (r.code !== 'Ok') throw new Error(`OSRM: ${r.code} ${r.message ?? ''}`);
  return r.routes;
}
