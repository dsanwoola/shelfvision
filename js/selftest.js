// ShelfVision — in-browser self tests for the pure counting logic.
// Open index.html?selftest=1 and check the console.

import { Tracker, iou, bestLabel } from './tracker.js';
import { cosine, classify, setSamples, setThreshold, AI } from './ai.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.error(`SELFTEST FAIL: ${name}`); }
}

export function run() {
  // --- iou ---
  check('iou identical boxes = 1', Math.abs(iou([0, 0, 10, 10], [0, 0, 10, 10]) - 1) < 1e-9);
  check('iou disjoint boxes = 0', iou([0, 0, 10, 10], [20, 20, 5, 5]) === 0);
  const half = iou([0, 0, 10, 10], [5, 0, 10, 10]); // overlap 50 / union 150
  check('iou half-overlap ≈ 1/3', Math.abs(half - 1 / 3) < 1e-9);

  // --- bestLabel ---
  check('bestLabel picks max vote', bestLabel({ a: 1.2, b: 3.4, c: 0.1 }) === 'b');
  check('bestLabel empty = null', bestLabel({}) === null);

  // --- Tracker: same object across frames counted once ---
  let tr = new Tracker();
  tr.update([{ box: [100, 100, 50, 50], label: 'COKE', score: 0.9 }], 0);
  tr.update([{ box: [104, 101, 50, 50], label: 'COKE', score: 0.9 }], 350);
  tr.update([{ box: [108, 102, 50, 50], label: 'COKE', score: 0.9 }], 700);
  let t = tr.tally(2);
  check('tracker dedups one object over 3 frames', t.counts.COKE === 1 && !t.unknown);

  // --- Tracker: two separate objects counted separately ---
  tr = new Tracker();
  const frame = [
    { box: [0, 0, 40, 40], label: 'COKE', score: 0.9 },
    { box: [200, 0, 40, 40], label: 'COKE', score: 0.9 },
  ];
  tr.update(frame, 0);
  tr.update(frame, 350);
  t = tr.tally(2);
  check('tracker counts two distinct units', t.counts.COKE === 2);

  // --- Tracker: single-frame noise filtered by minHits ---
  tr = new Tracker();
  tr.update([{ box: [0, 0, 40, 40], label: 'PEPSI', score: 0.9 }], 0);
  t = tr.tally(2);
  check('minHits filters one-frame blips', !t.counts.PEPSI);

  // --- Tracker: unknown objects tallied separately ---
  tr = new Tracker();
  tr.update([{ box: [0, 0, 40, 40], label: 'unknown', score: 0 }], 0);
  tr.update([{ box: [2, 1, 40, 40], label: 'unknown', score: 0 }], 350);
  t = tr.tally(2);
  check('unknown objects reported', t.unknown === 1 && Object.keys(t.counts).length === 0);

  // --- Tracker: label votes settle flicker ---
  tr = new Tracker();
  tr.update([{ box: [0, 0, 40, 40], label: 'FANTA', score: 0.95 }], 0);
  tr.update([{ box: [1, 1, 40, 40], label: 'SPRITE', score: 0.6 }], 350);
  tr.update([{ box: [2, 2, 40, 40], label: 'FANTA', score: 0.9 }], 700);
  t = tr.tally(2);
  check('vote-weighted label wins over flicker', t.counts.FANTA === 1 && !t.counts.SPRITE);

  // --- Tracker: stale tracks not re-matched after maxAge ---
  tr = new Tracker();
  tr.update([{ box: [0, 0, 40, 40], label: 'COKE', score: 0.9 }], 0);
  tr.update([{ box: [0, 0, 40, 40], label: 'COKE', score: 0.9 }], 300);
  tr.update([{ box: [0, 0, 40, 40], label: 'COKE', score: 0.9 }], 5000); // long gap → new unit
  tr.update([{ box: [1, 1, 40, 40], label: 'COKE', score: 0.9 }], 5300);
  t = tr.tally(2);
  check('re-appearance after maxAge = new track', t.counts.COKE === 2);

  // --- cosine / k-NN classify ---
  const e1 = new Float32Array([1, 0, 0]);
  const e2 = new Float32Array([0, 1, 0]);
  const e3 = new Float32Array([Math.SQRT1_2, Math.SQRT1_2, 0]);
  check('cosine orthogonal = 0', cosine(e1, e2) === 0);
  check('cosine identical = 1', Math.abs(cosine(e1, e1) - 1) < 1e-6);

  const savedSamples = AI.samples;
  const savedThreshold = AI.threshold;
  setThreshold(0.7);
  setSamples([
    { item_code: 'COKE', embedding: e1 },
    { item_code: 'COKE', embedding: e1 },
    { item_code: 'PEPSI', embedding: e2 },
  ]);
  check('classify matches nearest cluster', classify(new Float32Array([0.99, 0.14, 0])).label === 'COKE');
  setThreshold(0.8); // e3 has cosine ≈0.707 to both clusters → below 0.8
  check('classify below threshold = unknown', classify(e3).label === 'unknown');
  setThreshold(0.95);
  check('strict threshold rejects weak match', classify(new Float32Array([0.8, 0.6, 0])).label === 'unknown');
  setSamples(savedSamples);
  setThreshold(savedThreshold);

  const summary = `SELFTEST ${failed === 0 ? 'PASS' : 'FAIL'}: ${passed}/${passed + failed} checks passed`;
  console.log(summary);
  if (failures.length) console.log('Failures:', failures);
  window.__SELFTEST = { passed, failed, failures };
  return failed === 0;
}
