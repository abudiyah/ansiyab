import type { Region } from '../domain/types.ts';

/**
 * سجل المناطق. لإضافة مدينة جديدة يكفي إضافة عنصر هنا (bbox ومركز وأحياء عينة):
 * الموصلات والمؤشرات والواجهة تعمل على أي Region دون تعديل.
 */
export const REGIONS: Region[] = [
  {
    id: 'riyadh',
    nameAr: 'الرياض',
    nameEn: 'Riyadh',
    // نطاق تقريبي يغطي الكتلة العمرانية لمدينة الرياض (يُراجع مع حدود الأمانة الرسمية)
    bbox: { minLng: 46.45, minLat: 24.45, maxLng: 47.0, maxLat: 25.05 },
    center: [46.6753, 24.7136],
    timezone: 'Asia/Riyadh',
    sampleDistricts: [
      { nameAr: 'العليا', nameEn: 'Al Olaya', rationaleAr: 'مركز أعمال كثيف وطرق شريانية رئيسية (طريق الملك فهد، العليا)' },
      { nameAr: 'الملز', nameEn: 'Al Malaz', rationaleAr: 'حي قديم كثيف بشبكة شوارع متعامدة ومرافق حكومية' },
      { nameAr: 'النرجس', nameEn: 'An Narjis', rationaleAr: 'حي شمالي حديث سريع النمو، يختبر اكتمال بيانات OSM للأحياء الجديدة' },
      { nameAr: 'العزيزية', nameEn: 'Al Aziziyah', rationaleAr: 'جنوب المدينة، حركة شاحنات ومستودعات ومخارج طرق إقليمية' },
      { nameAr: 'الروضة', nameEn: 'Ar Rawdah', rationaleAr: 'شرق المدينة، سكني متوسط الكثافة قرب طريق الدائري الشرقي' },
      { nameAr: 'الياسمين', nameEn: 'Al Yasmin', rationaleAr: 'شمالي سكني قرب طريق أبي بكر الصديق وطريق الملك سلمان' },
    ],
  },
];

export const getRegion = (id: string): Region => {
  const r = REGIONS.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown region ${id}`);
  return r;
};
