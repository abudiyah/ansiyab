// ينسخ إضافة النص العربي لـ MapLibre إلى public/vendor (رخصة BSD من Mapbox)
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
let dir = process.cwd();
let src = null;
while (dir !== dirname(dir)) {
  const p = join(dir, 'node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js');
  if (existsSync(p)) { src = p; break; }
  dir = dirname(dir);
}
if (!src) throw new Error('mapbox-gl-rtl-text not installed');
mkdirSync(resolve('public/vendor'), { recursive: true });
copyFileSync(src, resolve('public/vendor/mapbox-gl-rtl-text.js'));
