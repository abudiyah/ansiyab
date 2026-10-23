import { formatIndicator, type IndicatorValue } from '@ansiyab/core';

export const fmt = (v: IndicatorValue, digits = 0) => formatIndicator(v, digits);

export const num = (n: number | null | undefined, digits = 0) =>
  n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('ar-SA', { maximumFractionDigits: digits });

const rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'لا يوجد';
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export const timeAr = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '—';

export const EVENT_TYPE_AR: Record<string, { label: string; glyph: string; color: string }> = {
  accident: { label: 'حادث', glyph: '⚠', color: '#c0392b' },
  breakdown: { label: 'مركبة معطلة', glyph: '⛭', color: '#8e44ad' },
  roadworks: { label: 'أعمال طرق', glyph: '⚒', color: '#d35400' },
  lane_closure: { label: 'إغلاق حارة', glyph: '⇥', color: '#e67e22' },
  road_closure: { label: 'إغلاق طريق', glyph: '⛔', color: '#7b0000' },
  jam: { label: 'ازدحام مُبلّغ', glyph: '≋', color: '#b03a2e' },
  flooding: { label: 'سيول/تجمع مياه', glyph: '≈', color: '#1f6fb2' },
  weather_hazard: { label: 'خطر جوي', glyph: '☁', color: '#566573' },
  other: { label: 'أخرى', glyph: '•', color: '#566573' },
};

export const SEVERITY_AR: Record<string, string> = { low: 'منخفضة', moderate: 'متوسطة', high: 'مرتفعة', critical: 'حرجة', unknown: 'غير معروفة' };
export const CONFIDENCE_AR: Record<string, string> = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };
export const VERIFICATION_AR: Record<string, string> = { verified: 'متحقق رسميًا', provider_reported: 'بلاغ مزود (غير متحقق رسميًا)', unverified: 'غير متحقق' };
export const PROVENANCE_AR: Record<string, string> = { live: 'حي', historical: 'تاريخي', forecast: 'متوقع', simulated: 'محاكاة' };
export const STATUS_AR: Record<string, string> = { open: 'مفتوح', acknowledged: 'قيد المعالجة', resolved: 'مغلق' };
export const ROAD_CLASS_AR: Record<string, string> = { motorway: 'طريق سريع', trunk: 'طريق رئيسي', primary: 'شرياني', secondary: 'تجميعي', tertiary: 'فرعي', residential: 'سكني', unclassified: 'غير مصنف', link: 'وصلة' };
