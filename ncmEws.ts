import type { WeatherWarning } from '../domain/types.ts';
import { getJson, type Fetcher } from './http.ts';

/**
 * موصل نظام الإنذار المبكر للمركز الوطني للأرصاد (GetNotifications).
 * الحقول وفق «EWS API Technical Guide V2.0». الوصول يتطلب نموذج طلب واعتمادًا من المركز،
 * لذا الرابط الأساسي يُضبط من البيئة (NCM_EWS_BASE_URL) ولا يُفعَّل الموصل دونه.
 */
export const NCM_EWS_ID = 'ncm-ews';

export interface NcmNotification {
  Id: number | string;
  Title?: string;
  alertTypeAr?: string;
  alertTypeEn?: string;
  fromDate: string;
  toDate: string;
  LastModified?: string;
  alertStatusAr?: string;
  alertStatusEn?: string;
  AlertHazards?: { id: number; descriptionAr: string; descriptionEn: string }[];
  AlertActions?: { id: number; descriptionAr: string; descriptionEn: string }[];
  regionID?: number;
  regionAR?: string;
  regionEn?: string;
  Governorates?: { nameAr?: string; NameAr?: string; nameEn?: string; longitude?: number; latitude?: number; municipalities?: unknown[] }[];
  otherLocationsAR?: string | null;
}

export async function fetchNotifications(fetcher: Fetcher, baseUrl: string, headers?: Record<string, string>): Promise<NcmNotification[]> {
  const url = baseUrl.replace(/\/$/, '') + '/getnotifications';
  const r = await getJson<NcmNotification[] | { data: NcmNotification[] }>(fetcher, NCM_EWS_ID, url, headers ? { headers } : undefined);
  return Array.isArray(r) ? r : (r.data ?? []);
}

/** يحتفظ بإنذارات منطقة الرياض فقط. النطاق يبقى «منطقة/محافظة» ولا يُحوَّل إلى قياس للحي. */
export function parseNotifications(items: NcmNotification[], receivedAt: string, regionMatchAr = 'الرياض'): WeatherWarning[] {
  return items
    .filter((n) => (n.regionAR ?? '').includes(regionMatchAr) || (n.Governorates ?? []).some((g) => (g.nameAr ?? g.NameAr ?? '').includes(regionMatchAr)))
    .map((n) => {
      const govs = (n.Governorates ?? []).map((g) => g.nameAr ?? g.NameAr ?? '').filter(Boolean);
      return {
        id: `${NCM_EWS_ID}:${n.Id}`,
        sourceId: NCM_EWS_ID,
        titleAr: n.alertTypeAr ?? n.Title ?? 'إنذار',
        hazardsAr: (n.AlertHazards ?? []).map((h) => h.descriptionAr),
        actionsAr: (n.AlertActions ?? []).map((a) => a.descriptionAr),
        regionAr: n.regionAR ?? '',
        governoratesAr: govs,
        from: new Date(n.fromDate).toISOString(),
        to: new Date(n.toDate).toISOString(),
        statusAr: n.alertStatusAr ?? '',
        spatialScope: govs.length ? 'governorate' : 'region',
        receivedAt,
        provenance: 'live' as const,
      };
    });
}
