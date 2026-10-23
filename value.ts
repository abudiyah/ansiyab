/**
 * قيمة مؤشر: إما متاحة بوحدة، أو غير متاحة مع سبب.
 * لا نستخدم الصفر بديلًا عن غياب البيانات.
 */
export type IndicatorValue =
  | { available: true; value: number; unit: string; estimated?: boolean; note?: string }
  | { available: false; reason: UnavailableReason; detailAr?: string };

export type UnavailableReason =
  | 'no_data'
  | 'stale'
  | 'invalid_reference'
  | 'insufficient_history'
  | 'insufficient_coverage'
  | 'source_not_connected'
  | 'not_measured';

export const UNAVAILABLE_REASON_AR: Record<UnavailableReason, string> = {
  no_data: 'لا توجد قراءة',
  stale: 'القراءة متقادمة',
  invalid_reference: 'القيمة المرجعية مفقودة أو صفرية',
  insufficient_history: 'السجل التاريخي غير كافٍ',
  insufficient_coverage: 'التغطية غير كافية',
  source_not_connected: 'المصدر غير متصل',
  not_measured: 'غير مقاس من أي مصدر متاح',
};

export const ok = (value: number, unit: string, extra?: { estimated?: boolean; note?: string }): IndicatorValue => ({
  available: true,
  value,
  unit,
  ...extra,
});

export const na = (reason: UnavailableReason, detailAr?: string): IndicatorValue =>
  detailAr === undefined ? { available: false, reason } : { available: false, reason, detailAr };

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function formatIndicator(v: IndicatorValue, digits = 0): string {
  if (!v.available) return `غير متاح (${v.detailAr ?? UNAVAILABLE_REASON_AR[v.reason]})`;
  const n = v.value.toLocaleString('ar-SA', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return `${v.estimated ? '≈ ' : ''}${n}${v.unit ? ' ' + v.unit : ''}`;
}
