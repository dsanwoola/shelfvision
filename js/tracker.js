// ShelfVision — cross-frame object tracker.
// Deduplicates detections across video frames so a slow pan over a shelf
// counts each physical unit once. Pure logic, no DOM/TF dependencies (testable).

export function iou(a, b) {
  // boxes are [x, y, width, height]
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

export function bestLabel(votes) {
  let label = null;
  let best = 0;
  for (const [k, v] of Object.entries(votes)) {
    if (v > best) { best = v; label = k; }
  }
  return label;
}

export class Tracker {
  constructor({ maxAgeMs = 1600, matchIou = 0.25 } = {}) {
    this.tracks = [];
    this.nextId = 1;
    this.maxAgeMs = maxAgeMs;
    this.matchIou = matchIou;
  }

  // detections: [{ box: [x,y,w,h], label: string|'unknown', score: number }]
  update(detections, now) {
    const claimed = new Set();
    for (const det of detections) {
      let best = null;
      let bestIou = this.matchIou;
      for (const t of this.tracks) {
        if (claimed.has(t.id)) continue;
        if (now - t.lastSeen > this.maxAgeMs) continue;
        const v = iou(t.box, det.box);
        if (v > bestIou) { bestIou = v; best = t; }
      }
      if (best) {
        claimed.add(best.id);
        best.box = det.box;
        best.lastSeen = now;
        best.hits += 1;
        if (det.label !== 'unknown') {
          best.votes[det.label] = (best.votes[det.label] || 0) + det.score;
        }
      } else {
        this.tracks.push({
          id: this.nextId++,
          box: det.box,
          votes: det.label !== 'unknown' ? { [det.label]: det.score } : {},
          hits: 1,
          lastSeen: now,
        });
      }
    }
  }

  // Confirmed count per item label. minHits filters single-frame noise.
  tally(minHits = 2) {
    const counts = {};
    let unknown = 0;
    for (const t of this.tracks) {
      if (t.hits < minHits) continue;
      const label = bestLabel(t.votes);
      if (label) counts[label] = (counts[label] || 0) + 1;
      else unknown += 1;
    }
    return { counts, unknown };
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }
}
