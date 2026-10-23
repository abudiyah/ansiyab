import type { LngLat, WeatherObservation } from '../domain/types.ts';
import { getJson, type Fetcher } from './http.ts';

export const OPEN_METEO_ID = 'open-meteo';
export const OPEN_METEO_AQ_ID = 'open-meteo-aq';

const CURRENT = ['temperature_2m', 'precipitation', 'rain', 'showers', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m'];
const HOURLY = ['temperature_2m', 'precipitation', 'rain', 'showers', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'visibility'];

export interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  utc_offset_seconds: number;
  current?: Record<string, number | string> & { time: string; interval: number };
  current_units?: Record<string, string>;
  hourly?: { time: string[]; [k: string]: (number | null)[] | string[] };
  hourly_units?: Record<string, string>;
}

export function forecastUrl(points: LngLat[], opts: { pastDays?: number; forecastDays?: number } = {}): string {
  const lat = points.map((p) => p[1].toFixed(4)).join(',');
  const lon = points.map((p) => p[0].toFixed(4)).join(',');
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=${CURRENT.join(',')}&hourly=${HOURLY.join(',')}` +
    `&past_days=${opts.pastDays ?? 1}&forecast_days=${opts.forecastDays ?? 2}&timezone=GMT&timeformat=iso8601`
  );
}

export function airQualityUrl(points: LngLat[]): string {
  const lat = points.map((p) => p[1].toFixed(4)).join(',');
  const lon = points.map((p) => p[0].toFixed(4)).join(',');
  return `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=dust,pm10&timezone=GMT`;
}

/** Open-Meteo يعيد كائنًا لموقع واحد ومصفوفة لعدة مواقع */
export async function fetchForecast(fetcher: Fetcher, points: LngLat[], opts?: { pastDays?: number; forecastDays?: number }): Promise<OpenMeteoResponse[]> {
  const r = await getJson<OpenMeteoResponse | OpenMeteoResponse[]>(fetcher, OPEN_METEO_ID, forecastUrl(points, opts));
  return Array.isArray(r) ? r : [r];
}

export async function fetchAirQuality(fetcher: Fetcher, points: LngLat[]): Promise<OpenMeteoResponse[]> {
  const r = await getJson<OpenMeteoResponse | OpenMeteoResponse[]>(fetcher, OPEN_METEO_AQ_ID, airQualityUrl(points));
  return Array.isArray(r) ? r : [r];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** أوقات Open-Meteo بصيغة "YYYY-MM-DDTHH:MM" بتوقيت GMT عند timezone=GMT */
const isoZ = (t: string) => (t.endsWith('Z') ? t : `${t}Z`);

/**
 * يحوّل الاستجابة إلى قراءات. «current» حالي، و«hourly» قبل الآن تاريخي (نموذجي)، وبعده متوقع.
 * الرؤية غير متاحة في current، فنأخذها من الساعة الأقرب ونوسمها بذلك.
 */
export function parseForecast(
  r: OpenMeteoResponse,
  locationId: string,
  receivedAt: string,
  now: Date,
  dust?: number | null,
): { current: WeatherObservation | null; hourly: WeatherObservation[] } {
  const point: LngLat = [r.longitude, r.latitude];
  const base = { sourceId: OPEN_METEO_ID, receivedAt, locationId, point, spatialResolutionKm: 25 };
  const hourly: WeatherObservation[] = [];
  const h = r.hourly;
  if (h?.time) {
    h.time.forEach((t, i) => {
      const at = new Date(isoZ(t));
      hourly.push({
        ...base,
        kind: 'hourly',
        observedAt: at.toISOString(),
        validAt: at.toISOString(),
        provenance: at.getTime() <= now.getTime() ? 'historical' : 'forecast',
        temperatureC: num(h.temperature_2m?.[i]),
        precipitationMm: num(h.precipitation?.[i]),
        rainMm: num(h.rain?.[i]),
        windSpeedKmh: num(h.wind_speed_10m?.[i]),
        windGustsKmh: num(h.wind_gusts_10m?.[i]),
        visibilityM: num(h.visibility?.[i]),
        weatherCode: num(h.weather_code?.[i]),
        dustUgM3: null,
      });
    });
  }
  let current: WeatherObservation | null = null;
  const c = r.current;
  if (c?.time) {
    const at = new Date(isoZ(String(c.time)));
    const nearest = hourly.reduce<WeatherObservation | null>(
      (best, x) => (!best || Math.abs(new Date(x.validAt).getTime() - at.getTime()) < Math.abs(new Date(best.validAt).getTime() - at.getTime()) ? x : best),
      null,
    );
    current = {
      ...base,
      kind: 'current',
      observedAt: at.toISOString(),
      validAt: at.toISOString(),
      provenance: 'live',
      temperatureC: num(c.temperature_2m),
      precipitationMm: num(c.precipitation),
      rainMm: num(c.rain),
      windSpeedKmh: num(c.wind_speed_10m),
      windGustsKmh: num(c.wind_gusts_10m),
      visibilityM: nearest?.visibilityM ?? null,
      weatherCode: num(c.weather_code),
      dustUgM3: dust ?? null,
    };
  }
  return { current, hourly };
}

/** وصف رموز WMO المستخدمة في Open-Meteo */
export const WMO_AR: Record<number, string> = {
  0: 'صحو', 1: 'صحو غالبًا', 2: 'غائم جزئيًا', 3: 'غائم',
  45: 'ضباب', 48: 'ضباب متجمد',
  51: 'رذاذ خفيف', 53: 'رذاذ', 55: 'رذاذ كثيف',
  61: 'مطر خفيف', 63: 'مطر', 65: 'مطر غزير',
  66: 'مطر متجمد', 67: 'مطر متجمد غزير',
  71: 'ثلج خفيف', 73: 'ثلج', 75: 'ثلج كثيف', 77: 'حبيبات ثلج',
  80: 'زخات خفيفة', 81: 'زخات', 82: 'زخات عنيفة',
  85: 'زخات ثلج', 86: 'زخات ثلج كثيفة',
  95: 'عاصفة رعدية', 96: 'عاصفة رعدية مع برد', 99: 'عاصفة رعدية مع برد كثيف',
};
