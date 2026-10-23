import type { BBox, LngLat } from '../domain/types.ts';
import { getJson, type Fetcher } from './http.ts';

export const NOMINATIM_ID = 'nominatim';

export interface GeocodeHit {
  displayName: string;
  point: LngLat;
  osmType: string;
  osmId: number;
  category: string;
  type: string;
}

/** بحث عند الضغط على «بحث» فقط (سياسة Nominatim تمنع الإكمال التلقائي) */
export function searchUrl(q: string, viewbox: BBox): string {
  const vb = `${viewbox.minLng},${viewbox.maxLat},${viewbox.maxLng},${viewbox.minLat}`;
  return `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=8&countrycodes=sa&accept-language=ar&viewbox=${vb}&bounded=1`;
}

export async function geocode(fetcher: Fetcher, q: string, viewbox: BBox): Promise<GeocodeHit[]> {
  const r = await getJson<{ display_name: string; lat: string; lon: string; osm_type: string; osm_id: number; category: string; type: string }[]>(
    fetcher,
    NOMINATIM_ID,
    searchUrl(q, viewbox),
  );
  return r.map((x) => ({ displayName: x.display_name, point: [Number(x.lon), Number(x.lat)], osmType: x.osm_type, osmId: x.osm_id, category: x.category, type: x.type }));
}
