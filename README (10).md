# منصة انسياب

منصة ذكية لرصد الحركة المرورية والمخاطر البيئية ودعم القرار في أحياء الرياض.

- **وحدة التحليل:** مقطع الطريق + اتجاه الحركة. **وحدة التجميع:** الحي.
- **مبدأ أساسي:** لا أرقام بلا مصدر. أي مؤشر بلا بيانات يظهر «غير متاح» مع السبب، ولا يُعرض أي مصدر «متصلًا» قبل اختبار فعلي.

> **الحالة (2026-10-23):** الكود مكتمل للنسخة الأولى ومختبر (48 اختبار وحدة و47 فحص واجهة)، لكن **لم يُختبر أي اتصال حي بعد** لأن شبكة بيئة البناء تحجب المصادر. انظر [docs/STATUS.md](docs/STATUS.md).

## التشغيل السريع

المتطلبات: Node.js 22.12 أو أحدث ([nodejs.org](https://nodejs.org)).

```bash
npm install
cp .env.example .env          # ثم أضف TOMTOM_API_KEY وADMIN_TOKEN إن توفرا
npm run probe                 # فحص الاتصال الفعلي بكل مصدر (يكتب data/runtime/source-status.json)
npm start                     # يبني الواجهة ويشغّل الخادم على http://localhost:8787
```

على Windows (PowerShell) استبدل `cp` بـ `copy .env.example .env`.

- **الوضع الحي (الافتراضي):** يجلب OSM وOpen-Meteo دون مفتاح، وTomTom عند وجود المفتاح.
- **وضع المحاكاة:** `MODE=simulation` في `.env`. يظهر فيه شريط دائم «بيانات محاكاة لأغراض العرض وليست حالة المرور الفعلية»، وشبكة اصطناعية.
- **التطوير:** شغّل `npm run dev:server` في نافذة و`npm run dev` في أخرى (الواجهة على 5173 مع وكيل إلى 8787).

## الاختبارات

```bash
npm test             # اختبارات الوحدة (المؤشرات، الموصلات، التنبيهات، المسارات، التنبؤ)
npm run test:e2e     # واجهة كاملة في وضع المحاكاة بمقاسَي حاسوب وجوال (Playwright)
npm run test:e2e:live  # فحص خادم حي يعمل فعلًا (شغّل npm start بـ MODE=live أولًا؛ BASE لتغيير العنوان)
```

للنشر كتطبيق ويب قابل للتثبيت (PWA) على Render أو أي استضافة Docker، انظر [docs/DEPLOY.md](docs/DEPLOY.md).

```bash
npm run typecheck
```

## البنية

```
packages/core     نموذج المجال، والمؤشرات، والتدرج اللوني، والتنبيهات، والمسارات، والتنبؤ، والموصلات، وسجل المصادر (TypeScript نقي)
apps/server       خادم Node: جدولة الجلب، والمخزن، وREST API، ووكيل يحفظ المفاتيح
apps/web          React + MapLibre GL، عربية RTL متجاوبة
db/schema.sql     مخطط PostgreSQL/PostGIS للتشغيل
scripts/          probe (فحص الاتصال)، وe2e، وتوليد الوثائق
docs/             الوثائق أدناه
```

**الاختيارات التقنية:** اخترنا TypeScript في الطرفين بدل FastAPI، لتُستخدم المعادلات نفسها في الخادم والواجهة من حزمة واحدة مختبرة. واخترنا MapLibre لأن ترخيصها مفتوح. أما التخزين في النسخة الأولى فملفات JSON/JSONL خلف واجهة مخزن قابلة للاستبدال بـ PostGIS.

## الوثائق

| الوثيقة | المحتوى |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | جدول كل وظيفة: حقيقية / تاريخية / تجريبية / غير متاحة، مع الدليل |
| [docs/SOURCES.md](docs/SOURCES.md) | سجل المصادر بالروابط وتاريخ التحقق والتصنيف |
| [docs/INDICATORS.md](docs/INDICATORS.md) | قاموس المؤشرات (34) والمعادلات والتدرج اللوني |
| [docs/ALERTS.md](docs/ALERTS.md) | قواعد التنبيهات ومنع التذبذب والتوصيات |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | نموذج المجال ومخطط البيانات وتدفقها والأمان |
| [docs/API.md](docs/API.md) | واجهات REST |
| [docs/TESTING.md](docs/TESTING.md) | نتائج الاختبارات، وما لم يُختبر، وخطة التحقق الميداني |
| [docs/COSTS_AND_KEYS.md](docs/COSTS_AND_KEYS.md) | المفاتيح والاتفاقيات وتقدير التكلفة بأسعار متحقق منها |
| [docs/PLAN_AND_ROADMAP.md](docs/PLAN_AND_ROADMAP.md) | الخطة من الهدف النهائي، والمراحل، والانتقال للتشغيل |

## النشر

خادم Linux واحد يكفي للتجربة: `npm ci && npm start` خلف وكيل عكسي (مثل Caddy أو Nginx) يوفر HTTPS، مع خدمة systemd لإعادة التشغيل. احفظ `data/runtime/` في مكان دائم. للتشغيل الفعلي انظر [docs/PLAN_AND_ROADMAP.md](docs/PLAN_AND_ROADMAP.md).

## التراخيص والنسب

بيانات الطرق والأحياء © OpenStreetMap contributors (ODbL)، وبلاطات الخريطة OpenFreeMap/OpenMapTiles، والطقس Open-Meteo (CC BY 4.0) وCAMS، وحركة المرور © TomTom عند التفعيل. والتوجيه OSRM.
