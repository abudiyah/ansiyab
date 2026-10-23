import type { IndicatorValue } from './value.ts';

export interface ScaleClass {
  id: string;
  /** الحد الأدنى شاملًا */
  min: number;
  /** الحد الأعلى غير شامل (إلا للفئة الأخيرة) */
  max: number;
  labelAr: string;
  color: string;
  /** رمز مساند للون لمن لا يميز الألوان */
  glyph: string;
}

export interface ColorScale {
  id: 'sri' | 'density';
  titleAr: string;
  unitAr: string;
  noteAr: string;
  classes: ScaleClass[];
  unknown: { labelAr: string; color: string; glyph: string };
}

const UNKNOWN = { labelAr: 'غير معروف (بيانات مفقودة أو متقادمة)', color: '#9aa0a6', glyph: '?' };

/** حدود تصميمية أولية قابلة للمعايرة، وليست معيارًا رسميًا. */
export const SRI_SCALE: ColorScale = {
  id: 'sri',
  titleAr: 'مؤشر انخفاض السرعة',
  unitAr: '0–100',
  noteAr: 'حدود تصميمية أولية قابلة للمعايرة، وليست معيارًا رسميًا. يقيس انخفاض السرعة عن التدفق الحر، وليس عدد المركبات أو الإشغال.',
  classes: [
    { id: 'free', min: 0, max: 20, labelAr: 'تدفق سلس', color: '#1a9850', glyph: '●' },
    { id: 'light', min: 20, max: 40, labelAr: 'تباطؤ بسيط', color: '#91cf60', glyph: '◐' },
    { id: 'moderate', min: 40, max: 60, labelAr: 'ازدحام متوسط', color: '#fee08b', glyph: '◑' },
    { id: 'heavy', min: 60, max: 80, labelAr: 'ازدحام مرتفع', color: '#fc8d59', glyph: '◕' },
    { id: 'severe', min: 80, max: 100, labelAr: 'ازدحام شديد', color: '#d73027', glyph: '■' },
  ],
  unknown: UNKNOWN,
};

/**
 * فئات الكثافة (مركبة/كم/حارة). مأخوذة من حدود مستويات الخدمة للطرق السريعة في HCM
 * (11/18/26/35/45 سيارة ركاب/ميل/حارة) محوّلة إلى الكيلومتر. تُعرض فقط عند توافر كثافة مقاسة أو مقدّرة.
 */
export const DENSITY_SCALE: ColorScale = {
  id: 'density',
  titleAr: 'الكثافة',
  unitAr: 'مركبة/كم/حارة',
  noteAr: 'مستوحاة من حدود مستوى الخدمة للطرق السريعة (HCM) بعد التحويل إلى كم؛ تحتاج معايرة محلية.',
  classes: [
    { id: 'A-B', min: 0, max: 11.2, labelAr: 'منخفضة', color: '#1a9850', glyph: '●' },
    { id: 'C', min: 11.2, max: 16.2, labelAr: 'معتدلة', color: '#91cf60', glyph: '◐' },
    { id: 'D', min: 16.2, max: 21.7, labelAr: 'مرتفعة نسبيًا', color: '#fee08b', glyph: '◑' },
    { id: 'E', min: 21.7, max: 28.0, labelAr: 'قريبة من السعة', color: '#fc8d59', glyph: '◕' },
    { id: 'F', min: 28.0, max: Infinity, labelAr: 'فوق السعة', color: '#d73027', glyph: '■' },
  ],
  unknown: { ...UNKNOWN, labelAr: 'غير مقاسة' },
};

export function classify(scale: ColorScale, v: IndicatorValue): { color: string; labelAr: string; glyph: string; classId: string } {
  if (!v.available) return { ...scale.unknown, classId: 'unknown' };
  const last = scale.classes[scale.classes.length - 1]!;
  for (const c of scale.classes) {
    if (v.value >= c.min && (v.value < c.max || (c === last && v.value <= c.max))) {
      return { color: c.color, labelAr: c.labelAr, glyph: c.glyph, classId: c.id };
    }
  }
  return { ...scale.unknown, classId: 'unknown' };
}

/** تعبير MapLibre للتلوين حسب خاصية رقمية، والرمادي عند غيابها. */
export function maplibreStepExpression(scale: ColorScale, property: string): unknown[] {
  const steps: unknown[] = ['step', ['get', property], scale.classes[0]!.color];
  for (const c of scale.classes.slice(1)) steps.push(c.min, c.color);
  return ['case', ['==', ['typeof', ['get', property]], 'number'], steps, scale.unknown.color];
}
