// ShelfVision — application wiring (views, audit flow, training flow, sync).

import * as db from './db.js';
import * as ai from './ai.js';
import * as erp from './erpnext.js';
import { Tracker } from './tracker.js';
import { startCamera, stopCamera } from './camera.js';

const $ = (id) => document.getElementById(id);

const state = {
  items: [],            // catalog: {item_code, item_name, uom, image, source}
  itemsByCode: {},
  warehouses: [],
  tracker: new Tracker(),
  counting: false,
  processingVideo: false,
  trainCameraOn: false,
  auditCameraOn: false,
  sampleCounts: {},     // item_code -> number of training samples
  stockLevels: null,    // item_code -> actual_qty (variance column)
  lastAuditMeta: null,
};

// ---------------------------------------------------------------- utilities

function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function once(el, ev) {
  return new Promise((res) => el.addEventListener(ev, res, { once: true }));
}

function setModelStatus(text, ready = false) {
  const el = $('model-status');
  el.textContent = text;
  el.classList.toggle('ready', ready);
}

function itemName(code) {
  return state.itemsByCode[code]?.item_name || code;
}

// ------------------------------------------------------------------- views

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') renderHistory();
  if (name === 'train') renderTrainSummary();
}

// ------------------------------------------------------------------ models

let modelsLoading = null;
function ensureModels() {
  if (!modelsLoading) {
    modelsLoading = ai
      .loadModels((s) => setModelStatus(s))
      .then(() => setModelStatus('AI ready · on-device', true))
      .catch((e) => {
        setModelStatus('AI failed to load');
        modelsLoading = null;
        throw new Error(`Could not load AI models (network needed on first run): ${e.message}`);
      });
  }
  return modelsLoading;
}

async function rebuildClassifier() {
  const samples = await db.getAllSamples();
  ai.setSamples(samples);
  state.sampleCounts = {};
  for (const s of samples) {
    state.sampleCounts[s.item_code] = (state.sampleCounts[s.item_code] || 0) + 1;
  }
  $('trained-count').textContent = `${Object.keys(state.sampleCounts).length} items trained`;
}

// ----------------------------------------------------------------- catalog

async function loadCatalog() {
  state.items = await db.getAllItems();
  state.itemsByCode = Object.fromEntries(state.items.map((i) => [i.item_code, i]));
  const dl = $('item-list');
  dl.innerHTML = '';
  for (const it of state.items) {
    const o = document.createElement('option');
    o.value = it.item_code;
    o.label = it.item_name;
    dl.appendChild(o);
  }
  try {
    state.warehouses = JSON.parse(localStorage.getItem('sv_warehouses')) || [];
  } catch { state.warehouses = []; }
  const wl = $('warehouse-list');
  wl.innerHTML = '';
  for (const w of state.warehouses) {
    const o = document.createElement('option');
    o.value = w.name;
    wl.appendChild(o);
  }
}

// -------------------------------------------------------------- audit flow

function drawOverlay(video, dets) {
  const canvas = $('audit-overlay');
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;
  const sx = canvas.width / vw, sy = canvas.height / vh;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 2;
  ctx.font = '12px system-ui, sans-serif';
  for (const d of dets) {
    const [x, y, w, h] = d.box;
    const known = d.label !== 'unknown';
    ctx.strokeStyle = known ? '#22d3ee' : 'rgba(255,255,255,0.35)';
    ctx.strokeRect(x * sx, y * sy, w * sx, h * sy);
    if (known) {
      const text = `${itemName(d.label)} ${(d.score * 100).toFixed(0)}%`;
      const tw = ctx.measureText(text).width + 8;
      ctx.fillStyle = 'rgba(8,47,73,0.85)';
      ctx.fillRect(x * sx, Math.max(0, y * sy - 18), tw, 18);
      ctx.fillStyle = '#22d3ee';
      ctx.fillText(text, x * sx + 4, Math.max(12, y * sy - 5));
    }
  }
}

function renderLiveTally() {
  const { counts, unknown } = state.tracker.tally(2);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const el = $('live-tally');
  el.innerHTML = '';
  for (const [code, qty] of entries) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${itemName(code)}</span><b>${qty}</b>`;
    el.appendChild(li);
  }
  if (unknown > 0) {
    const li = document.createElement('li');
    li.className = 'unknown';
    li.innerHTML = `<span>Unrecognised objects</span><b>${unknown}</b>`;
    el.appendChild(li);
  }
  if (!entries.length && !unknown) {
    el.innerHTML = '<li class="hint-li">Pan slowly across the shelf…</li>';
  }
}

async function countLoop() {
  const video = $('audit-video');
  while (state.counting) {
    if (video.readyState >= 2) {
      try {
        const dets = await ai.analyseFrame(video);
        state.tracker.update(dets, performance.now());
        drawOverlay(video, dets);
        renderLiveTally();
      } catch (e) {
        console.error('frame error', e);
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function toggleAuditCamera() {
  const video = $('audit-video');
  if (state.auditCameraOn) {
    stopLiveCount();
    stopCamera(video);
    state.auditCameraOn = false;
    $('btn-audit-camera').textContent = '📷 Start camera';
    return;
  }
  try {
    await ensureModels();
    await startCamera(video);
    state.auditCameraOn = true;
    $('btn-audit-camera').textContent = '⏹ Stop camera';
    $('btn-audit-count').disabled = false;
  } catch (e) {
    toast(e.message, 'error');
  }
}

function stopLiveCount() {
  if (!state.counting) return;
  state.counting = false;
  $('btn-audit-count').textContent = '▶ Start counting';
  finishCount();
}

async function toggleCounting() {
  if (state.counting) {
    stopLiveCount();
    return;
  }
  await rebuildClassifier();
  if (!Object.keys(state.sampleCounts).length) {
    toast('No trained items yet — use the Train tab first.', 'warn');
  }
  state.tracker = new Tracker();
  state.counting = true;
  $('btn-audit-count').textContent = '⏸ Finish & review';
  $('audit-review').classList.add('hidden');
  countLoop();
}

async function processVideoFile(file) {
  if (state.processingVideo) return;
  const video = $('audit-video');
  try {
    await ensureModels();
    await rebuildClassifier();
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  stopLiveCount();
  stopCamera(video);
  state.auditCameraOn = false;
  $('btn-audit-camera').textContent = '📷 Start camera';

  state.processingVideo = true;
  state.tracker = new Tracker();
  const url = URL.createObjectURL(file);
  video.src = url;
  video.muted = true;
  await once(video, 'loadedmetadata');
  const step = 0.35;
  const bar = $('video-progress');
  bar.classList.remove('hidden');
  try {
    for (let t = 0; t < video.duration; t += step) {
      video.currentTime = Math.min(t, video.duration - 0.05);
      await once(video, 'seeked');
      const dets = await ai.analyseFrame(video);
      state.tracker.update(dets, t * 1000);
      drawOverlay(video, dets);
      renderLiveTally();
      bar.value = t / video.duration;
    }
    finishCount();
    toast('Video analysed ✔', 'ok');
  } catch (e) {
    toast(`Video analysis failed: ${e.message}`, 'error');
  } finally {
    bar.classList.add('hidden');
    state.processingVideo = false;
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
}

function finishCount() {
  const { counts, unknown } = state.tracker.tally(2);
  state.lastAuditMeta = {
    date: new Date().toISOString(),
    warehouse: $('audit-warehouse').value.trim(),
    unknown,
  };
  renderReview(counts, unknown);
  $('audit-review').classList.remove('hidden');
  $('audit-review').scrollIntoView({ behavior: 'smooth' });
  maybeLoadStockLevels();
}

async function maybeLoadStockLevels() {
  state.stockLevels = null;
  const wh = $('audit-warehouse').value.trim();
  if (!wh || !erp.isConfigured()) return;
  try {
    state.stockLevels = await erp.fetchStockLevels(wh);
    // refresh variance cells
    document.querySelectorAll('#review-body tr').forEach((tr) => updateVariance(tr));
  } catch (e) {
    console.warn('stock levels unavailable', e);
  }
}

function reviewRow(code = '', qty = 1) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="cell-item" list="item-list" value="${code}" placeholder="Item code"></td>
    <td class="cell-name">${code ? itemName(code) : ''}</td>
    <td><input class="cell-qty" type="number" min="0" step="1" value="${qty}"></td>
    <td class="cell-var">—</td>
    <td><button class="btn-icon cell-del" title="Remove">✕</button></td>`;
  tr.querySelector('.cell-del').addEventListener('click', () => tr.remove());
  tr.querySelector('.cell-item').addEventListener('change', (e) => {
    tr.querySelector('.cell-name').textContent = itemName(e.target.value.trim());
    updateVariance(tr);
  });
  tr.querySelector('.cell-qty').addEventListener('input', () => updateVariance(tr));
  updateVariance(tr);
  return tr;
}

function updateVariance(tr) {
  const cell = tr.querySelector('.cell-var');
  if (!state.stockLevels) { cell.textContent = '—'; return; }
  const code = tr.querySelector('.cell-item').value.trim();
  const qty = parseFloat(tr.querySelector('.cell-qty').value) || 0;
  const sys = state.stockLevels[code];
  if (sys === undefined) { cell.textContent = 'new'; return; }
  const diff = qty - sys;
  cell.textContent = `${diff > 0 ? '+' : ''}${diff} (sys ${sys})`;
  cell.className = `cell-var ${diff === 0 ? 'ok' : 'warn'}`;
}

function renderReview(counts, unknown) {
  const body = $('review-body');
  body.innerHTML = '';
  for (const [code, qty] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    body.appendChild(reviewRow(code, qty));
  }
  $('review-unknown').textContent = unknown
    ? `⚠ ${unknown} object(s) were detected but not recognised. Train them or add lines manually.`
    : '';
  $('push-result').innerHTML = '';
}

function collectLines() {
  const lines = [];
  document.querySelectorAll('#review-body tr').forEach((tr) => {
    const item_code = tr.querySelector('.cell-item').value.trim();
    const qty = parseFloat(tr.querySelector('.cell-qty').value);
    if (item_code && Number.isFinite(qty)) lines.push({ item_code, qty });
  });
  return lines;
}

async function pushToErpNext() {
  const lines = collectLines();
  const warehouse = $('audit-warehouse').value.trim();
  const cfg = erp.getSettings();
  if (!lines.length) return toast('Nothing to push — the count is empty.', 'warn');
  if (!warehouse) return toast('Pick the kiosk warehouse first (top of the Audit tab).', 'warn');
  if (!erp.isConfigured()) return toast('Configure ERPNext in the Settings tab first.', 'warn');
  if (!cfg.company) return toast('Set your Company in the Settings tab first.', 'warn');

  const localOnly = lines.filter((l) => state.itemsByCode[l.item_code]?.source !== 'erpnext');
  if (localOnly.length &&
      !confirm(`These item codes were not synced from ERPNext and may be rejected:\n${localOnly.map((l) => l.item_code).join(', ')}\n\nPush anyway?`)) {
    return;
  }

  const btn = $('btn-push-erpnext');
  btn.disabled = true;
  btn.textContent = 'Pushing…';
  try {
    const doc = await erp.createStockReconciliation({
      company: cfg.company,
      warehouse,
      lines,
      remarks: `ShelfVision AI count · ${new Date().toLocaleString()} · ${state.lastAuditMeta?.unknown || 0} unrecognised objects`,
    });
    const url = erp.docUrl('Stock Reconciliation', doc.name);
    $('push-result').innerHTML =
      `✅ Draft <a href="${url}" target="_blank" rel="noopener">${doc.name}</a> created in ERPNext — review & submit it there.`;
    toast(`Stock Reconciliation ${doc.name} created (draft)`, 'ok');
    await persistAudit(lines, doc.name);
  } catch (e) {
    toast(e.message, 'error');
    $('push-result').textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '⬆ Push to ERPNext';
  }
}

async function persistAudit(lines, pushedName = null) {
  await db.saveAudit({
    date: state.lastAuditMeta?.date || new Date().toISOString(),
    warehouse: $('audit-warehouse').value.trim(),
    unknown: state.lastAuditMeta?.unknown || 0,
    lines,
    erpnext_doc: pushedName,
  });
}

function exportCsv() {
  const lines = collectLines();
  if (!lines.length) return toast('Nothing to export.', 'warn');
  const rows = [['item_code', 'item_name', 'qty', 'warehouse']];
  const wh = $('audit-warehouse').value.trim();
  for (const l of lines) rows.push([l.item_code, itemName(l.item_code), l.qty, wh]);
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `shelfvision-count-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// -------------------------------------------------------------- train flow

async function toggleTrainCamera() {
  const video = $('train-video');
  if (state.trainCameraOn) {
    stopCamera(video);
    state.trainCameraOn = false;
    $('btn-train-camera').textContent = '📷 Start camera';
    $('btn-capture').disabled = true;
    return;
  }
  try {
    await ensureModels();
    await startCamera(video);
    state.trainCameraOn = true;
    $('btn-train-camera').textContent = '⏹ Stop camera';
    $('btn-capture').disabled = false;
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function currentTrainItem() {
  const code = $('train-item').value.trim();
  if (!code) {
    toast('Type or pick an item code first.', 'warn');
    return null;
  }
  if (!state.itemsByCode[code]) {
    await db.putItems([{ item_code: code, item_name: code, uom: 'Nos', image: '', source: 'local' }]);
    await loadCatalog();
    toast(`Added "${code}" as a local item (not yet in ERPNext).`, 'info');
  }
  return code;
}

// Capture from camera: auto-crop the most prominent detected object.
async function captureSample() {
  const code = await currentTrainItem();
  if (!code) return;
  const video = $('train-video');
  if (video.readyState < 2) return toast('Camera not ready yet.', 'warn');
  try {
    const objects = await ai.detectObjects(video, 5, 0.25);
    let source;
    if (objects.length) {
      objects.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
      source = ai.cropBox(video, objects[0].box);
    } else {
      source = ai.cropBox(video, centerSquare(video));
    }
    await saveSampleFrom(source, code);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function centerSquare(video) {
  const w = video.videoWidth, h = video.videoHeight;
  const side = Math.min(w, h) * 0.8;
  return [(w - side) / 2, (h - side) / 2, side, side];
}

async function saveSampleFrom(canvasOrImg, code) {
  const embedding = ai.embed(canvasOrImg);
  const thumb = ai.makeThumb(canvasOrImg);
  await db.addSample({ item_code: code, embedding, thumb, created_at: Date.now() });
  await rebuildClassifier();
  await renderGallery(code);
  renderTrainSummary();
  flashCaptureCount(code);
}

function flashCaptureCount(code) {
  const n = state.sampleCounts[code] || 0;
  const el = $('capture-flash');
  el.textContent = `${n} sample${n === 1 ? '' : 's'} for ${itemName(code)}`;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1200);
}

async function importTrainingImages(files) {
  const code = await currentTrainItem();
  if (!code) return;
  try {
    await ensureModels();
  } catch (e) {
    return toast(e.message, 'error');
  }
  for (const f of files) {
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await once(img, 'load');
    const c = document.createElement('canvas');
    c.width = 224; c.height = 224;
    const side = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 224, 224);
    await saveSampleFrom(c, code);
    URL.revokeObjectURL(img.src);
  }
  toast(`Imported ${files.length} image(s) for ${itemName(code)}`, 'ok');
}

async function renderGallery(code) {
  const gal = $('sample-gallery');
  gal.innerHTML = '';
  if (!code) return;
  const samples = await db.getSamplesByItem(code);
  for (const s of samples) {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img src="${s.thumb}" alt=""><button title="Delete sample">✕</button>`;
    div.querySelector('button').addEventListener('click', async () => {
      await db.deleteSample(s.id);
      await rebuildClassifier();
      renderGallery(code);
      renderTrainSummary();
    });
    gal.appendChild(div);
  }
}

async function renderTrainSummary() {
  await rebuildClassifier();
  const el = $('train-summary');
  el.innerHTML = '';
  const entries = Object.entries(state.sampleCounts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    el.innerHTML = '<li class="hint-li">No trained items yet. Aim the camera at a product and capture 8–15 samples from different angles.</li>';
    return;
  }
  for (const [code, n] of entries) {
    const li = document.createElement('li');
    const quality = n >= 8 ? '🟢' : n >= 4 ? '🟡' : '🔴';
    li.innerHTML = `<span>${quality} ${itemName(code)}</span><b>${n}</b>`;
    li.addEventListener('click', () => {
      $('train-item').value = code;
      renderGallery(code);
    });
    el.appendChild(li);
  }
}

// ----------------------------------------------------------------- history

async function renderHistory() {
  const audits = await db.getAudits();
  const el = $('audit-history');
  el.innerHTML = '';
  if (!audits.length) {
    el.innerHTML = '<li class="hint-li">No saved audits yet.</li>';
    return;
  }
  for (const a of audits.sort((x, y) => y.date.localeCompare(x.date))) {
    const total = a.lines.reduce((s, l) => s + l.qty, 0);
    const li = document.createElement('li');
    li.innerHTML = `
      <div><b>${new Date(a.date).toLocaleString()}</b> · ${a.warehouse || 'no warehouse'}</div>
      <div>${a.lines.length} items · ${total} units${a.unknown ? ` · ⚠ ${a.unknown} unknown` : ''}
      ${a.erpnext_doc ? ` · <a href="${erp.docUrl('Stock Reconciliation', a.erpnext_doc)}" target="_blank" rel="noopener">${a.erpnext_doc}</a>` : ' · not pushed'}</div>`;
    el.appendChild(li);
  }
}

// ---------------------------------------------------------------- settings

function loadSettingsForm() {
  const c = erp.getSettings();
  $('set-url').value = c.url || '';
  $('set-key').value = c.apiKey || '';
  $('set-secret').value = c.apiSecret || '';
  $('set-company').value = c.company || '';
  const th = c.threshold ?? 0.72;
  $('set-threshold').value = th;
  $('threshold-value').textContent = th;
  ai.setThreshold(parseFloat(th));
}

function saveSettingsForm() {
  const c = {
    url: $('set-url').value.trim(),
    apiKey: $('set-key').value.trim(),
    apiSecret: $('set-secret').value.trim(),
    company: $('set-company').value.trim(),
    threshold: parseFloat($('set-threshold').value),
  };
  erp.saveSettings(c);
  ai.setThreshold(c.threshold);
  toast('Settings saved', 'ok');
}

async function testConnection() {
  saveSettingsForm();
  const el = $('conn-status');
  el.textContent = 'Testing…';
  try {
    const user = await erp.testConnection();
    el.textContent = `✅ Connected as ${user}`;
    const companies = await erp.fetchCompanies();
    if (companies.length && !$('set-company').value.trim()) {
      $('set-company').value = companies[0];
      saveSettingsForm();
    }
    const cl = $('company-list');
    cl.innerHTML = '';
    companies.forEach((c) => {
      const o = document.createElement('option');
      o.value = c;
      cl.appendChild(o);
    });
  } catch (e) {
    el.textContent = `❌ ${e.message}`;
  }
}

async function syncFromErpNext() {
  saveSettingsForm();
  const el = $('sync-status');
  el.textContent = 'Syncing…';
  try {
    const [items, warehouses] = await Promise.all([erp.fetchItems(), erp.fetchWarehouses()]);
    await db.putItems(items);
    localStorage.setItem('sv_warehouses', JSON.stringify(warehouses));
    await loadCatalog();
    el.textContent = `✅ Synced ${items.length} items, ${warehouses.length} warehouses (${new Date().toLocaleTimeString()})`;
    toast('ERPNext catalog synced', 'ok');
  } catch (e) {
    el.textContent = `❌ ${e.message}`;
    toast(e.message, 'error');
  }
}

async function exportTraining() {
  const data = await db.exportAll();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `shelfvision-training-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importTraining(file) {
  try {
    const data = JSON.parse(await file.text());
    await db.importAll(data);
    await loadCatalog();
    await rebuildClassifier();
    renderTrainSummary();
    toast(`Imported ${data.samples?.length || 0} samples`, 'ok');
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'error');
  }
}

// -------------------------------------------------- one-tap staff setup

function encodeSetup(o) {
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeSetup(s) {
  return JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
}

// #setup=<base64url JSON> — applies connection settings on open (the hash
// fragment never leaves the browser, so credentials don't hit server logs).
function applySetupFromHash() {
  const m = location.hash.match(/^#setup=(.+)$/);
  if (!m) return false;
  try {
    const cfg = decodeSetup(m[1]);
    if (!cfg.url || !cfg.apiKey || !cfg.apiSecret) throw new Error('missing fields');
    const cur = erp.getSettings();
    erp.saveSettings({ threshold: cur.threshold ?? 0.72, ...cur, ...cfg });
    history.replaceState(null, '', location.pathname);
    toast('Connection settings applied ✔', 'ok');
    return true;
  } catch {
    history.replaceState(null, '', location.pathname);
    toast('Invalid setup link', 'error');
    return false;
  }
}

function setupLink() {
  const c = erp.getSettings();
  if (!c.url || !c.apiKey || !c.apiSecret) {
    toast('Save a working connection first (URL, key, secret).', 'warn');
    return null;
  }
  return location.origin + location.pathname + '#setup=' +
    encodeSetup({ url: c.url, apiKey: c.apiKey, apiSecret: c.apiSecret, company: c.company || '' });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load QR library (offline?)'));
    document.head.appendChild(s);
  });
}

async function showSetupQr() {
  const link = setupLink();
  if (!link) return;
  const box = $('setup-qr');
  if (!box.classList.contains('hidden')) {
    box.classList.add('hidden');
    return;
  }
  try {
    if (typeof QRCode === 'undefined') {
      await loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js');
    }
    box.innerHTML = '';
    new QRCode(box, {
      text: link,
      width: 220,
      height: 220,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
    box.classList.remove('hidden');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// -------------------------------------------------------------------- init

function bind() {
  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view)));

  $('btn-audit-camera').addEventListener('click', toggleAuditCamera);
  $('btn-audit-count').addEventListener('click', toggleCounting);
  $('audit-video-file').addEventListener('change', (e) => {
    if (e.target.files[0]) processVideoFile(e.target.files[0]);
    e.target.value = '';
  });
  $('btn-add-line').addEventListener('click', () => $('review-body').appendChild(reviewRow()));
  $('btn-push-erpnext').addEventListener('click', pushToErpNext);
  $('btn-export-csv').addEventListener('click', exportCsv);
  $('btn-save-audit').addEventListener('click', async () => {
    const lines = collectLines();
    if (!lines.length) return toast('Nothing to save.', 'warn');
    await persistAudit(lines);
    toast('Audit saved to history', 'ok');
  });
  $('audit-warehouse').addEventListener('change', maybeLoadStockLevels);

  $('btn-train-camera').addEventListener('click', toggleTrainCamera);
  $('btn-capture').addEventListener('click', captureSample);
  $('train-files').addEventListener('change', (e) => {
    if (e.target.files.length) importTrainingImages([...e.target.files]);
    e.target.value = '';
  });
  $('train-item').addEventListener('change', () => renderGallery($('train-item').value.trim()));

  $('btn-save-settings').addEventListener('click', saveSettingsForm);
  $('btn-test-conn').addEventListener('click', testConnection);
  $('btn-sync').addEventListener('click', syncFromErpNext);
  $('set-threshold').addEventListener('input', (e) => {
    $('threshold-value').textContent = e.target.value;
  });
  $('btn-copy-setup').addEventListener('click', () => {
    const link = setupLink();
    if (!link) return;
    navigator.clipboard.writeText(link)
      .then(() => toast('Setup link copied — share it privately with staff phones', 'ok'))
      .catch(() => { prompt('Copy the setup link:', link); });
  });
  $('btn-show-qr').addEventListener('click', showSetupQr);
  $('btn-export-training').addEventListener('click', exportTraining);
  $('import-training-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importTraining(e.target.files[0]);
    e.target.value = '';
  });
}

async function init() {
  bind();
  const fromSetupLink = applySetupFromHash();
  loadSettingsForm();
  await loadCatalog();
  await rebuildClassifier();
  renderTrainSummary();
  showView('audit');
  if (fromSetupLink) {
    // One-tap onboarding: connect and pull the catalog automatically.
    showView('settings');
    testConnection().then(() => syncFromErpNext()).catch(() => {});
  }
  // Preload AI in the background so the first scan starts instantly.
  ensureModels().catch(() => {});
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if (new URLSearchParams(location.search).has('selftest')) {
    import('./selftest.js').then((m) => m.run());
  }
}

init();
