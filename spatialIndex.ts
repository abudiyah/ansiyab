import type { LngLat, RoadSegment, SegmentDirectionKey, TravelDirection } from '../domain/types.ts';
import { segmentKey } from '../domain/types.ts';
import { angleDiffDeg, bboxOf, pointToLine } from './geo.ts';

/** شبكة خلايا بسيطة لمطابقة النقاط بأقرب مقطع طريق. */
export class SegmentIndex {
  private cells = new Map<string, RoadSegment[]>();
  constructor(
    public readonly segments: RoadSegment[],
    private readonly cellDeg = 0.005,
  ) {
    for (const s of segments) {
      const b = bboxOf(s.geometry.coordinates);
      for (let x = Math.floor(b.minLng / cellDeg); x <= Math.floor(b.maxLng / cellDeg); x++) {
        for (let y = Math.floor(b.minLat / cellDeg); y <= Math.floor(b.maxLat / cellDeg); y++) {
          const k = `${x}|${y}`;
          const arr = this.cells.get(k);
          if (arr) arr.push(s);
          else this.cells.set(k, [s]);
        }
      }
    }
  }

  private candidates(p: LngLat): RoadSegment[] {
    const cx = Math.floor(p[0] / this.cellDeg);
    const cy = Math.floor(p[1] / this.cellDeg);
    const seen = new Set<RoadSegment>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const s of this.cells.get(`${cx + dx}|${cy + dy}`) ?? []) seen.add(s);
    return [...seen];
  }

  /**
   * أقرب مقطع ضمن maxDistanceM. إذا أُعطي اتجاه حركة (bearing) يُحدَّد اتجاه المقطع
   * (fwd/bwd) ويُرفض التطابق إن كان الاتجاه غير مسموح على المقطع (طريق باتجاه واحد).
   */
  match(
    p: LngLat,
    opts: { maxDistanceM: number; bearing?: number; maxAngleDeg?: number },
  ): { segment: RoadSegment; direction: TravelDirection; key: SegmentDirectionKey; distanceM: number } | null {
    let best: { segment: RoadSegment; direction: TravelDirection; distanceM: number } | null = null;
    for (const s of this.candidates(p)) {
      const r = pointToLine(p, s.geometry.coordinates);
      if (r.distanceM > opts.maxDistanceM) continue;
      let direction: TravelDirection = s.directions[0] ?? 'fwd';
      if (opts.bearing !== undefined) {
        const fwdDiff = angleDiffDeg(opts.bearing, r.bearing);
        const bwdDiff = angleDiffDeg(opts.bearing, (r.bearing + 180) % 360);
        direction = fwdDiff <= bwdDiff ? 'fwd' : 'bwd';
        const diff = Math.min(fwdDiff, bwdDiff);
        if (diff > (opts.maxAngleDeg ?? 45)) continue;
        if (!s.directions.includes(direction)) continue;
      }
      if (!best || r.distanceM < best.distanceM) best = { segment: s, direction, distanceM: r.distanceM };
    }
    return best ? { ...best, key: segmentKey(best.segment.id, best.direction) } : null;
  }

  near(p: LngLat, maxDistanceM: number): { segment: RoadSegment; distanceM: number }[] {
    const out: { segment: RoadSegment; distanceM: number }[] = [];
    for (const s of this.candidates(p)) {
      const d = pointToLine(p, s.geometry.coordinates).distanceM;
      if (d <= maxDistanceM) out.push({ segment: s, distanceM: d });
    }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }
}
