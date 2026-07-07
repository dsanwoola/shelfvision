// ShelfVision — on-device AI pipeline.
// MobileNet v2 produces 1280-dim embeddings for item recognition (k-NN over
// trained samples); COCO-SSD localises objects on the shelf. Everything runs
// in the browser via TensorFlow.js — no images ever leave the device.

/* global tf, mobilenet, cocoSsd */

export const AI = {
  net: null,        // mobilenet feature extractor
  detector: null,   // coco-ssd object localiser
  ready: false,
  samples: [],      // [{ item_code, embedding: Float32Array }]
  threshold: 0.72,  // cosine similarity gate for "known item"
  topK: 7,
};

export async function loadModels(onStatus = () => {}) {
  if (AI.ready) return;
  onStatus('Loading TensorFlow.js backend…');
  await tf.ready();
  onStatus('Loading item recogniser (MobileNet v2)…');
  AI.net = await mobilenet.load({ version: 2, alpha: 1.0 });
  onStatus('Loading shelf detector (COCO-SSD)…');
  AI.detector = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  // Warm up so the first real frame is fast.
  onStatus('Warming up models…');
  const warm = document.createElement('canvas');
  warm.width = warm.height = 224;
  AI.net.infer(warm, true).dispose();
  await AI.detector.detect(warm);
  AI.ready = true;
  onStatus('AI models ready');
}

export function setSamples(samples) {
  AI.samples = samples;
}

export function setThreshold(t) {
  AI.threshold = t;
}

// Both vectors are L2-normalised, so dot product == cosine similarity.
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// L2-normalised embedding from a canvas/image/video element.
export function embed(source) {
  const t = tf.tidy(() => {
    const e = AI.net.infer(source, true).squeeze();
    return e.div(e.norm());
  });
  const arr = new Float32Array(t.dataSync());
  t.dispose();
  return arr;
}

// k-NN classification over trained samples.
// Returns { label, score } — label 'unknown' when nothing clears the threshold.
export function classify(embedding) {
  if (!AI.samples.length) return { label: 'unknown', score: 0 };
  const sims = AI.samples.map((s) => ({ code: s.item_code, sim: cosine(embedding, s.embedding) }));
  sims.sort((a, b) => b.sim - a.sim);
  const top = sims.slice(0, AI.topK).filter((s) => s.sim >= AI.threshold);
  if (!top.length) return { label: 'unknown', score: sims[0].sim };
  const votes = {};
  for (const s of top) votes[s.code] = (votes[s.code] || 0) + s.sim;
  let label = null;
  let best = 0;
  for (const [k, v] of Object.entries(votes)) {
    if (v > best) { best = v; label = k; }
  }
  const labelSims = top.filter((s) => s.code === label).map((s) => s.sim);
  return { label, score: labelSims.reduce((a, b) => a + b, 0) / labelSims.length };
}

// Localise candidate objects in a frame. Class-agnostic: we only use the
// boxes; identification is done by our trained classifier.
export async function detectObjects(source, maxBoxes = 25, minScore = 0.3) {
  const preds = await AI.detector.detect(source, maxBoxes, minScore);
  return preds.map((p) => ({ box: p.bbox, detScore: p.score }));
}

// Crop a box (with padding) out of a source frame into a 224×224 canvas.
const cropCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
export function cropBox(source, box, pad = 0.08) {
  const sw = source.videoWidth || source.width;
  const sh = source.videoHeight || source.height;
  let [x, y, w, h] = box;
  const px = w * pad;
  const py = h * pad;
  x = Math.max(0, x - px);
  y = Math.max(0, y - py);
  w = Math.min(sw - x, w + 2 * px);
  h = Math.min(sh - y, h + 2 * py);
  cropCanvas.width = 224;
  cropCanvas.height = 224;
  const ctx = cropCanvas.getContext('2d');
  ctx.drawImage(source, x, y, w, h, 0, 0, 224, 224);
  return cropCanvas;
}

// Full frame → detections with classified labels.
export async function analyseFrame(source) {
  const objects = await detectObjects(source);
  const out = [];
  for (const obj of objects) {
    const crop = cropBox(source, obj.box);
    const { label, score } = classify(embed(crop));
    out.push({ box: obj.box, label, score, detScore: obj.detScore });
  }
  return out;
}

// Small thumbnail for the training gallery.
export function makeThumb(source, size = 96) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const sw = source.videoWidth || source.width;
  const sh = source.videoHeight || source.height;
  const side = Math.min(sw, sh);
  c.getContext('2d').drawImage(source, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.7);
}
