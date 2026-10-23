import type { BBox, LngLat, MultiPolygon, Polygon } from '../domain/types.ts';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lineLengthM(coords: LngLat[]): number {
  let L = 0;
  for (let i = 1; i < coords.length; i++) L += haversineM(coords[i - 1]!, coords[i]!);
  return L;
}

/** اتجاه (0–360) من a إلى b */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** إسقاط محلي متساوي المسافات تقريبًا (كافٍ لمسافات مدينة) */
function project(p: LngLat, lat0: number): [number, number] {
  return [rad(p[0]) * R * Math.cos(rad(lat0)), rad(p[1]) * R];
}

/** أقصر مسافة من نقطة إلى خط متعدد، مع موضع الإسقاط واتجاه الضلع الأقرب. */
export function pointToLine(p: LngLat, line: LngLat[]): { distanceM: number; segmentIndex: number; bearing: number; t: number } {
  let best = { distanceM: Infinity, segmentIndex: -1, bearing: 0, t: 0 };
  const lat0 = p[1];
  const P = project(p, lat0);
  for (let i = 1; i < line.length; i++) {
    const A = project(line[i - 1]!, lat0);
    const B = project(line[i]!, lat0);
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = A[0] + t * dx;
    const cy = A[1] + t * dy;
    const d = Math.hypot(P[0] - cx, P[1] - cy);
    if (d < best.distanceM) best = { distanceM: d, segmentIndex: i - 1, bearing: bearingDeg(line[i - 1]!, line[i]!), t };
  }
  return best;
}

export function pointInRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: LngLat, g: Polygon | MultiPolygon): boolean {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    if (!poly[0] || !pointInRing(p, poly[0])) continue;
    let inHole = false;
    for (const hole of poly.slice(1)) if (pointInRing(p, hole)) inHole = true;
    if (!inHole) return true;
  }
  return false;
}

export function bboxOf(coords: LngLat[]): BBox {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [x, y] of coords) {
    if (x < minLng) minLng = x;
    if (y < minLat) minLat = y;
    if (x > maxLng) maxLng = x;
    if (y > maxLat) maxLat = y;
  }
  return { minLng, minLat, maxLng, maxLat };
}

export function polygonCoords(g: Polygon | MultiPolygon): LngLat[] {
  return g.type === 'Polygon' ? g.coordinates.flat() : g.coordinates.flat(2);
}

export function ringCentroid(ring: LngLat[]): LngLat {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const f = xj * yi - xi * yj;
    a += f;
    cx += (xj + xi) * f;
    cy += (yj + yi) * f;
  }
  if (a === 0) {
    const b = bboxOf(ring);
    return [(b.minLng + b.maxLng) / 2, (b.minLat + b.maxLat) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function bboxArea(b: BBox): number {
  const w = haversineM([b.minLng, b.minLat], [b.maxLng, b.minLat]);
  const h = haversineM([b.minLng, b.minLat], [b.minLng, b.maxLat]);
  return (w * h) / 1e6;
}

export function bboxContains(b: BBox, p: LngLat): boolean {
  return p[0] >= b.minLng && p[0] <= b.maxLng && p[1] >= b.minLat && p[1] <= b.maxLat;
}

export function expandBBox(b: BBox, meters: number): BBox {
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.cos(rad((b.minLat + b.maxLat) / 2)));
  return { minLng: b.minLng - dLng, minLat: b.minLat - dLat, maxLng: b.maxLng + dLng, maxLat: b.maxLat + dLat };
}

/** يقسم المستطيل إلى شبكة مربعات لا يتجاوز ضلعها maxDeg درجة (لتصغير استعلامات المصادر المزدحمة) */
export function splitBBox(b: BBox, maxDeg: number): BBox[] {
  const nx = Math.max(1, Math.ceil((b.maxLng - b.minLng) / maxDeg - 1e-9));
  const ny = Math.max(1, Math.ceil((b.maxLat - b.minLat) / maxDeg - 1e-9));
  const dx = (b.maxLng - b.minLng) / nx, dy = (b.maxLat - b.minLat) / ny;
  const out: BBox[] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      out.push({ minLng: b.minLng + i * dx, minLat: b.minLat + j * dy, maxLng: b.minLng + (i + 1) * dx, maxLat: b.minLat + (j + 1) * dy });
  return out;
}

/** عينات نقاط على خط كل stepM متر */
export function sampleLine(coords: LngLat[], stepM: number): LngLat[] {
  const out: LngLat[] = [];
  if (coords.length === 0) return out;
  out.push(coords[0]!);
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const d = haversineM(a, b);
    let pos = stepM - carry;
    while (pos <= d) {
      const t = pos / d;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      pos += stepM;
    }
    carry = (carry + d) % stepM;
  }
  return out;
}
