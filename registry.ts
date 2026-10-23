/**
 * سجل مصادر البيانات. كل معلومة عن المصدر موثقة برابط وتاريخ تحقق.
 * «classification» هو التصنيف الموثّق؛ ولا يصبح المصدر «متصلًا ومختبرًا» إلا بعد نجاح
 * سكربت الفحص (npm run probe) الذي يكتب النتيجة في data/runtime/source-status.json.
 */

export type SourceClassification =
  | 'connected_tested' // متصل ومختبر
  | 'needs_key' // يحتاج مفتاحًا
  | 'needs_agreement' // يحتاج اتفاقية
  | 'unverified' // غير متحقق منه
  | 'unavailable'; // غير متاح

export const CLASSIFICATION_AR: Record<SourceClassification, string> = {
  connected_tested: 'متصل ومختبر',
  needs_key: 'يحتاج مفتاحًا',
  needs_agreement: 'يحتاج اتفاقية',
  unverified: 'غير متحقق منه',
  unavailable: 'غير متاح',
};

export type DataDomain =
  | 'boundaries_roads'
  | 'speed_congestion'
  | 'flow_counts'
  | 'incidents'
  | 'weather'
  | 'weather_warnings'
  | 'flooding'
  | 'terrain'
  | 'routing'
  | 'geocoding'
  | 'basemap';

export interface SourceDescriptor {
  id: string;
  nameAr: string;
  provider: string;
  domain: DataDomain;
  variablesAr: string[];
  coverageAr: string;
  updateFrequencyAr: string;
  latencyAr: string;
  accessAr: string;
  costAr: string;
  termsAr: string;
  classification: SourceClassification;
  /** ما يلزم لرفع التصنيف (مفتاح، اتفاقية، فتح الشبكة…) */
  requirementAr: string;
  /** مفتاح متغير البيئة إن احتاج المصدر مفتاحًا */
  envKey?: string;
  /** يعمل من المتصفح مباشرة دون خادم (CORS، بلا مفتاح) */
  browserDirect: boolean;
  /** أقصى عمر للقراءة قبل اعتبارها متقادمة */
  maxAgeS: number;
  docs: { titleAr: string; url: string }[];
  verifiedAt: string;
}

const V = '2026-10-23';

export const SOURCES: SourceDescriptor[] = [
  {
    id: 'osm-overpass',
    nameAr: 'OpenStreetMap عبر Overpass API',
    provider: 'OpenStreetMap contributors / overpass-api.de، ومرآة VK Maps (maps.mail.ru) احتياطية',
    domain: 'boundaries_roads',
    variablesAr: ['حدود الأحياء (حيث رُسمت كمضلعات)', 'نقاط أسماء الأحياء', 'الطرق وتصنيفها واتجاهها وحاراتها وسرعتها القصوى', 'المستشفيات والدفاع المدني'],
    coverageAr: 'عالمية؛ اكتمال حدود أحياء الرياض متفاوت ويُقاس داخل التطبيق لكل حي (مضلع/نقطة فقط)',
    updateFrequencyAr: 'تعديلات المتطوعين مستمرة؛ نخزن نسخة محلية ونحدّثها أسبوعيًا',
    latencyAr: 'دقائق من تعديل OSM',
    accessAr: 'HTTP GET/POST بلا مفتاح؛ يدعم الاستدعاء من المتصفح',
    costAr: 'مجاني للاستخدام الخفيف: أقل من 10,000 استعلام و1 جيجابايت يوميًا للمثيل الرئيسي، ويُقسم على 100 للاستخدام المنتظم',
    termsAr: 'بيانات ODbL 1.0 مع نسب «© OpenStreetMap contributors». يُمنع التشغيل المتوازي، ويجب الانتظار بعد أخطاء 429/406، والاستخدام التجاري يتطلب خادمًا ذاتيًا',
    classification: 'unverified',
    requirementAr: 'بلا مفتاح. اختُبر في 2026-10-23 عبر المرآة maps.mail.ru (الخادم الرئيسي overpass-api.de محجوب في بيئة البناء). المرآة بطيئة وتعيد 504 تحت الضغط، والاستخدام المنتظم يتطلب خادمًا ذاتيًا',
    browserDirect: true,
    maxAgeS: 30 * 24 * 3600,
    docs: [
      { titleAr: 'Overpass API – ويكي OSM (حدود الاستخدام وقائمة الخوادم العامة، ومنها مرآة VK Maps)', url: 'https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances' },
      { titleAr: 'ترخيص ODbL لبيانات OSM', url: 'https://www.openstreetmap.org/copyright' },
    ],
    verifiedAt: V,
  },
  {
    id: 'rcrc-geoportal',
    nameAr: 'البوابة الجيومكانية لأمانة منطقة الرياض',
    provider: 'أمانة منطقة الرياض',
    domain: 'boundaries_roads',
    variablesAr: ['الأحياء والشوارع', 'حدود البلديات', 'المرافق العامة', 'قطع الأراضي'],
    coverageAr: 'منطقة الرياض (مرجع رسمي)',
    updateFrequencyAr: 'غير معلن',
    latencyAr: 'غير معلن',
    accessAr: 'بوابة خرائط تفاعلية للعرض والتصدير اليدوي (Shapefile)؛ لم نجد واجهة API موثقة',
    costAr: 'غير معلن',
    termsAr: 'تخضع لشروط استخدام الأمانة؛ لم نجد ترخيصًا مفتوحًا لإعادة النشر',
    classification: 'needs_agreement',
    requirementAr: 'طلب رسمي من الأمانة لحدود الأحياء المعتمدة وطبقة الشوارع مع الترخيص',
    browserDirect: false,
    maxAgeS: 365 * 24 * 3600,
    docs: [
      { titleAr: 'صفحة البوابة الجيومكانية', url: 'https://alriyadh.gov.sa/en/gis-portal' },
      { titleAr: 'الخريطة', url: 'https://mapservice.alriyadh.gov.sa/geoportal/geomap' },
      { titleAr: 'شروط الاستخدام', url: 'https://alriyadh.gov.sa/en/content/terms-of-use' },
    ],
    verifiedAt: V,
  },
  {
    id: 'tomtom-flow',
    nameAr: 'TomTom Traffic Flow (Segment Data)',
    provider: 'TomTom',
    domain: 'speed_congestion',
    variablesAr: ['السرعة الحالية', 'سرعة التدفق الحر', 'زمن الرحلة الحالي والحر', 'الثقة 0–1', 'إغلاق الطريق', 'فئة الطريق FRC0–FRC6'],
    coverageAr: 'تغطية المزود للرياض غير مثبتة لكل طريق؛ تُقاس داخل التطبيق كنسبة المقاطع ذات الاستجابة الصالحة',
    updateFrequencyAr: 'لحظي (نموذج مروري يتجدد؛ لم تعلن الوثيقة دورية محددة)',
    latencyAr: 'دقائق',
    accessAr: 'REST: flowSegmentData/{style}/{zoom}/json?point=lat,lon&key=…؛ استعلام لكل نقطة',
    costAr: 'الخطة المجانية: 20,000 طلب شهريًا لبيانات المقاطع، و200,000 لبلاطات التدفق؛ وأسعار ما بعد المجاني غير منشورة في الصفحة',
    termsAr: 'وفق اتفاقية TomTom للمطورين: قيود على التخزين وإعادة التوزيع؛ نخزن الحد الأدنى اللازم ونذكر المصدر',
    classification: 'needs_key',
    requirementAr: 'مفتاح TOMTOM_API_KEY في ملف ‎.env على الخادم',
    envKey: 'TOMTOM_API_KEY',
    browserDirect: false,
    maxAgeS: 15 * 60,
    docs: [
      { titleAr: 'Flow Segment Data – الحقول والوحدات', url: 'https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/traffic-flow/flow-segment-data' },
      { titleAr: 'تسعير TomTom', url: 'https://docs.tomtom.com/pricing' },
    ],
    verifiedAt: V,
  },
  {
    id: 'tomtom-incidents',
    nameAr: 'TomTom Traffic Incidents (Incident Details v5)',
    provider: 'TomTom',
    domain: 'incidents',
    variablesAr: ['نوع الحدث (حادث، عطل، أعمال طرق، إغلاق حارة/طريق، سيول، ضباب، رياح…)', 'حجم التأخير', 'التأخير بالثواني', 'الطول', 'من/إلى', 'وقت البدء والانتهاء وآخر بلاغ', 'احتمال الحدوث', 'عدد البلاغات', 'وصف بالعربية'],
    coverageAr: 'مربع حتى 10,000 كم²، ويكفي لكامل الرياض؛ والتغطية الفعلية تُقاس بعدد الأحداث وزمن آخر بلاغ',
    updateFrequencyAr: 'لحظي حسب معرّف نموذج المرور (t)',
    latencyAr: 'دقائق',
    accessAr: 'REST: /traffic/services/5/incidentDetails?bbox=…&fields=…&language=ar',
    costAr: 'الخطة المجانية: 2,500 طلب شهريًا (التحديث كل 20 دقيقة يستهلك نحو 2,200)',
    termsAr: 'وفق اتفاقية TomTom للمطورين',
    classification: 'needs_key',
    requirementAr: 'مفتاح TOMTOM_API_KEY نفسه',
    envKey: 'TOMTOM_API_KEY',
    browserDirect: false,
    maxAgeS: 30 * 60,
    docs: [{ titleAr: 'Incident Details – المعاملات والحقول', url: 'https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/traffic-incidents/incident-details' }],
    verifiedAt: V,
  },
  {
    id: 'here-traffic',
    nameAr: 'HERE Traffic API v7',
    provider: 'HERE Technologies',
    domain: 'speed_congestion',
    variablesAr: ['التدفق اللحظي', 'الحوادث اللحظية'],
    coverageAr: 'غير متحقق منها للرياض',
    updateFrequencyAr: 'لحظي (حسب الوثائق العامة)',
    latencyAr: 'غير متحقق',
    accessAr: 'REST: ‎/flow و‎/incidents',
    costAr: 'لم نتمكن من التحقق من حصة الخطة المجانية من صفحة الأسعار',
    termsAr: 'وفق شروط HERE',
    classification: 'needs_key',
    requirementAr: 'مفتاح HERE_API_KEY، ثم تنفيذ الموصل. هذا الموصل مؤجل لصالح TomTom في النسخة الأولى',
    envKey: 'HERE_API_KEY',
    browserDirect: false,
    maxAgeS: 15 * 60,
    docs: [{ titleAr: 'نظرة عامة على Traffic API v7', url: 'https://docs.here.com/traffic-api/reference/traffic-v7-api-overview' }],
    verifiedAt: V,
  },
  {
    id: 'authority-counters',
    nameAr: 'عدادات وحساسات ورادارات الجهات المختصة',
    provider: 'الإدارة العامة للمرور / أمانة الرياض / الهيئة الملكية لمدينة الرياض',
    domain: 'flow_counts',
    variablesAr: ['حجم التدفق (مركبة/س)', 'الإشغال %', 'الكثافة', 'الطوابير والانتظار عند الإشارات'],
    coverageAr: 'غير معروفة',
    updateFrequencyAr: 'غير معلن',
    latencyAr: 'غير معلن',
    accessAr: 'لم نجد واجهة عامة موثقة',
    costAr: 'غير معلن',
    termsAr: 'تتطلب اتفاقية مشاركة بيانات',
    classification: 'needs_agreement',
    requirementAr: 'اتفاقية مع الجهة المشغلة لأنظمة العد والإشارات (مع واجهة للقراءات ومخطط الحساسات)',
    browserDirect: false,
    maxAgeS: 5 * 60,
    docs: [],
    verifiedAt: V,
  },
  {
    id: 'open-meteo',
    nameAr: 'Open-Meteo Forecast API',
    provider: 'Open-Meteo',
    domain: 'weather',
    variablesAr: ['الهطول ومكوناته (مم/الساعة السابقة)', 'سرعة الرياح على 10م وهباتها (كم/س)', 'مدى الرؤية (م، ساعي)', 'رمز الطقس WMO', 'الحرارة', 'السجل الماضي حتى 92 يومًا'],
    coverageAr: 'عالمية عبر نماذج عالمية فقط في منطقتنا (ECMWF IFS 9–25 كم وغيره): قيمة نموذجية لخلية شبكية وليست قياس محطة',
    updateFrequencyAr: 'عدة مرات يوميًا حسب النموذج؛ نجلب كل 15 دقيقة',
    latencyAr: 'ساعات (تشغيل النماذج)',
    accessAr: 'REST بلا مفتاح ويدعم CORS',
    costAr: 'مجاني لغير التجاري: 600/دقيقة، 5,000/ساعة، 10,000/يوم، 300,000/شهر. التجاري باشتراك',
    termsAr: 'CC BY 4.0؛ والاستخدام التجاري يتطلب اشتراكًا',
    classification: 'unverified',
    requirementAr: 'بلا مفتاح. اختُبر في 2026-10-23 (HTTP 200 وكل الحقول المتوقعة). الاستخدام التجاري يتطلب اشتراكًا',
    browserDirect: true,
    maxAgeS: 3 * 3600,
    docs: [
      { titleAr: 'وثائق المتغيرات والمعاملات', url: 'https://open-meteo.com/en/docs' },
      { titleAr: 'الشروط والحدود', url: 'https://open-meteo.com/en/terms' },
    ],
    verifiedAt: V,
  },
  {
    id: 'open-meteo-aq',
    nameAr: 'Open-Meteo Air Quality (الغبار)',
    provider: 'Open-Meteo / CAMS',
    domain: 'weather',
    variablesAr: ['الغبار قرب السطح (ميكروغرام/م³)', 'PM10'],
    coverageAr: 'عالمية؛ دقة CAMS العالمية 0.4° (نحو 45 كم) وزمنية 3 ساعات',
    updateFrequencyAr: 'كل 12 ساعة (توقع 5 أيام)',
    latencyAr: 'ساعات',
    accessAr: 'REST بلا مفتاح',
    costAr: 'كما في Open-Meteo',
    termsAr: 'CC BY 4.0؛ مع نسب CAMS',
    classification: 'unverified',
    requirementAr: 'بلا مفتاح. اختُبر في 2026-10-23. قيم الغبار تقدير نموذج CAMS بدقة ~40 كم، لا قياس محطة',
    browserDirect: true,
    maxAgeS: 6 * 3600,
    docs: [{ titleAr: 'Air Quality API', url: 'https://open-meteo.com/en/docs/air-quality-api' }],
    verifiedAt: V,
  },
  {
    id: 'ncm-ews',
    nameAr: 'نظام الإنذار المبكر – المركز الوطني للأرصاد',
    provider: 'المركز الوطني للأرصاد',
    domain: 'weather_warnings',
    variablesAr: ['الإنذارات السارية (النوع، الحالة، المخاطر، الإجراءات)', 'المنطقة والمحافظات والبلديات', 'من/إلى', 'الطقس الحالي وتوقع 5 أيام للمدن'],
    coverageAr: 'المملكة؛ النطاق المكاني للإنذار منطقة/محافظة/بلدية (نقاط) بلا مضلعات',
    updateFrequencyAr: 'عند إصدار الإنذار أو تعديله',
    latencyAr: 'دقائق',
    accessAr: 'REST/JSON (GetNotifications، GetWeatherInfo)؛ الوصول بعد تعبئة نموذج طلب واعتماده',
    costAr: 'غير معلن',
    termsAr: 'وفق موافقة المركز',
    classification: 'needs_agreement',
    requirementAr: 'تقديم نموذج طلب واجهات المركز، واستلام جداول الترميز (Excel) وبيانات الوصول، ثم ضبط NCM_EWS_BASE_URL',
    envKey: 'NCM_EWS_BASE_URL',
    browserDirect: false,
    maxAgeS: 30 * 60,
    docs: [
      { titleAr: 'دليل EWS API التقني v2 (منشور على بوابة اختبار المركز)', url: 'https://ncmpublic.centric.ae/Developers%20Guide/EWS%20API%20Technical%20Guide%20V.2.0.pdf' },
    ],
    verifiedAt: V,
  },
  {
    id: 'water-sensors',
    nameAr: 'حساسات تجمع المياه وبلاغات الغمر المؤكدة',
    provider: 'الدفاع المدني / أمانة الرياض',
    domain: 'flooding',
    variablesAr: ['موقع التجمع', 'العمق المقاس', 'الإغلاق', 'وقت التحقق'],
    coverageAr: 'غير معروفة',
    updateFrequencyAr: 'غير معلن',
    latencyAr: 'غير معلن',
    accessAr: 'لم نجد واجهة عامة',
    costAr: 'غير معلن',
    termsAr: 'تتطلب اتفاقية',
    classification: 'unavailable',
    requirementAr: 'اتفاقية مع الجهة المختصة. أحداث «Flooding» من TomTom تُعرض كبلاغ مزود وليست قياس غمر',
    browserDirect: false,
    maxAgeS: 30 * 60,
    docs: [{ titleAr: 'صفحة الكوارث الطبيعية – أمانة الرياض', url: 'https://alriyadh.gov.sa/en/content/natural-disasters' }],
    verifiedAt: V,
  },
  {
    id: 'copernicus-dem',
    nameAr: 'Copernicus DEM GLO-30',
    provider: 'Copernicus / ESA',
    domain: 'terrain',
    variablesAr: ['ارتفاع السطح (DSM) بدقة 30 م'],
    coverageAr: 'عالمية؛ الدقة الرأسية المطلقة أقل من 4 م (LE90)',
    updateFrequencyAr: 'ثابت (إصدارات)',
    latencyAr: 'غير منطبق',
    accessAr: 'تحميل بعد التسجيل (Copernicus Browser أو API أو S3)',
    costAr: 'مجاني',
    termsAr: 'ترخيص مجاني مع إشعار المصدر عند إعادة التوزيع',
    classification: 'unverified',
    requirementAr: 'تسجيل وتحميل البلاطات، ثم معالجة مسبقة لحساب الانخفاضات والتصريف. يُستخدم لقابلية التعرض فقط، لا لإثبات الغمر',
    browserDirect: false,
    maxAgeS: Infinity,
    docs: [{ titleAr: 'وصف مجموعة COP-DEM', url: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM' }],
    verifiedAt: V,
  },
  {
    id: 'osrm-demo',
    nameAr: 'OSRM (خادم العرض العام)',
    provider: 'Project OSRM',
    domain: 'routing',
    variablesAr: ['مسار وبدائل', 'المسافة', 'الزمن المقدّر من سرعات OSM الافتراضية (ليس مرورًا حيًا)'],
    coverageAr: 'شبكة OSM',
    updateFrequencyAr: 'تحديث دوري لبيانات OSM',
    latencyAr: 'غير منطبق',
    accessAr: 'REST بلا مفتاح',
    costAr: 'مجاني دون ضمانات؛ للتشغيل الفعلي يلزم خادم OSRM ذاتي',
    termsAr: 'يُمنع الاستخدام المفرط وبيع الوصول؛ يجب نسب ODbL وOSRM؛ وقد يُسحب الوصول دون إشعار',
    classification: 'unverified',
    requirementAr: 'بلا مفتاح. اختُبر في 2026-10-23. خادم عرض عام بلا سرعات حية، ويفضَّل خادم ذاتي للتشغيل',
    browserDirect: true,
    maxAgeS: Infinity,
    docs: [{ titleAr: 'سياسة استخدام خادم العرض', url: 'https://github.com/Project-OSRM/osrm-backend/wiki/API%20Usage%20Policy' }],
    verifiedAt: V,
  },
  {
    id: 'nominatim',
    nameAr: 'Nominatim (البحث الجغرافي)',
    provider: 'OSM Foundation',
    domain: 'geocoding',
    variablesAr: ['البحث بالاسم عن حي أو طريق أو موقع'],
    coverageAr: 'بيانات OSM',
    updateFrequencyAr: 'دقائق',
    latencyAr: 'غير منطبق',
    accessAr: 'REST بلا مفتاح',
    costAr: 'مجاني ضمن السياسة',
    termsAr: 'حد أقصى طلب واحد في الثانية، ولا إكمال تلقائي، ويلزم User-Agent أو Referer معرِّف، والتخزين المؤقت، ونسب OSM',
    classification: 'unverified',
    requirementAr: 'بلا مفتاح. اختُبر في 2026-10-23 بحد طلب واحد في الثانية',
    browserDirect: true,
    maxAgeS: Infinity,
    docs: [{ titleAr: 'سياسة استخدام Nominatim', url: 'https://operations.osmfoundation.org/policies/nominatim/' }],
    verifiedAt: V,
  },
  {
    id: 'openfreemap',
    nameAr: 'OpenFreeMap (الخريطة الأساسية)',
    provider: 'OpenFreeMap / OpenMapTiles / OSM',
    domain: 'basemap',
    variablesAr: ['بلاطات متجهية وأسماء الشوارع والأحياء'],
    coverageAr: 'عالمية',
    updateFrequencyAr: 'دوري',
    latencyAr: 'غير منطبق',
    accessAr: 'بلا مفتاح وبلا تسجيل',
    costAr: 'مجاني بلا حدود معلنة لعرض الخرائط',
    termsAr: 'يلزم نسب OpenMapTiles وOpenStreetMap (تضيفه MapLibre تلقائيًا)',
    classification: 'unverified',
    requirementAr: 'بلا مفتاح. اختُبر في 2026-10-23 (ملف النمط liberty)',
    browserDirect: true,
    maxAgeS: Infinity,
    docs: [{ titleAr: 'OpenFreeMap', url: 'https://openfreemap.org' }],
    verifiedAt: V,
  },
];

export const getSource = (id: string) => SOURCES.find((s) => s.id === id);

/** نتيجة فحص الاتصال الفعلي لمصدر */
export interface ConnectionTestResult {
  sourceId: string;
  ok: boolean;
  testedAt: string;
  httpStatus: number | null;
  latencyMs: number | null;
  detail: string;
  /** حقول متوقعة وُجدت في الاستجابة (لمطابقة المخطط) */
  fieldsFound?: string[];
  fieldsMissing?: string[];
  sample?: unknown;
}

/** التصنيف الفعّال = الموثّق، أو «متصل ومختبر» عند نجاح فحص حديث. */
export function effectiveClassification(s: SourceDescriptor, test?: ConnectionTestResult, now = new Date(), maxTestAgeH = 24): SourceClassification {
  if (test?.ok && (now.getTime() - new Date(test.testedAt).getTime()) / 3600e3 <= maxTestAgeH) return 'connected_tested';
  return s.classification;
}
