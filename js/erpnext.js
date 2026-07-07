// ShelfVision — ERPNext 15 REST integration.
// Talks to the Stock module: pulls Item/Warehouse catalogs and pushes counts
// as a draft Stock Reconciliation (ERPNext's inventory count & reconciliation
// doctype, which also covers POS warehouses). Auth: API key/secret token.

const SETTINGS_KEY = 'sv_settings';

export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function isConfigured() {
  const c = getSettings();
  return !!(c.url && c.apiKey && c.apiSecret);
}

function baseUrl() {
  return (getSettings().url || '').replace(/\/+$/, '');
}

async function api(path, opts = {}) {
  const c = getSettings();
  if (!c.url) throw new Error('ERPNext URL is not configured (Settings tab).');
  let res;
  try {
    res = await fetch(baseUrl() + path, {
      ...opts,
      headers: {
        Authorization: `token ${c.apiKey}:${c.apiSecret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
    throw new Error(
      `Cannot reach ${baseUrl()} — check the URL, your network, and that CORS is allowed on the ERPNext site (allow_cors in site_config.json). (${e.message})`
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = body.exception || body.message || res.statusText;
    if (body._server_messages) {
      try {
        msg = JSON.parse(body._server_messages).map((m) => JSON.parse(m).message).join('; ');
      } catch { /* keep msg */ }
    }
    throw new Error(`ERPNext ${res.status}: ${msg}`);
  }
  return body;
}

export async function testConnection() {
  const r = await api('/api/method/frappe.auth.get_logged_user');
  return r.message; // the API user's email
}

export async function fetchItems(limit = 2000) {
  const fields = encodeURIComponent(JSON.stringify(['item_code', 'item_name', 'stock_uom', 'image', 'item_group']));
  const filters = encodeURIComponent(JSON.stringify([['disabled', '=', 0], ['is_stock_item', '=', 1]]));
  const r = await api(`/api/resource/Item?fields=${fields}&filters=${filters}&limit_page_length=${limit}`);
  return r.data.map((it) => ({
    item_code: it.item_code,
    item_name: it.item_name || it.item_code,
    uom: it.stock_uom || 'Nos',
    item_group: it.item_group || '',
    image: it.image ? baseUrl() + it.image : '',
    source: 'erpnext',
  }));
}

export async function fetchWarehouses() {
  const fields = encodeURIComponent(JSON.stringify(['name', 'warehouse_name', 'company']));
  const filters = encodeURIComponent(JSON.stringify([['is_group', '=', 0], ['disabled', '=', 0]]));
  const r = await api(`/api/resource/Warehouse?fields=${fields}&filters=${filters}&limit_page_length=500`);
  return r.data;
}

export async function fetchCompanies() {
  const r = await api('/api/resource/Company?limit_page_length=100');
  return r.data.map((c) => c.name);
}

// Current stock per item in a warehouse (for the variance column in review).
export async function fetchStockLevels(warehouse) {
  const fields = encodeURIComponent(JSON.stringify(['item_code', 'actual_qty']));
  const filters = encodeURIComponent(JSON.stringify([['warehouse', '=', warehouse]]));
  const r = await api(`/api/resource/Bin?fields=${fields}&filters=${filters}&limit_page_length=5000`);
  const map = {};
  for (const b of r.data) map[b.item_code] = b.actual_qty;
  return map;
}

// Create a DRAFT Stock Reconciliation so the counts can be reviewed and
// submitted inside ERPNext (draft = docstatus 0, no ledger impact yet).
export async function createStockReconciliation({ company, warehouse, lines, remarks }) {
  const now = new Date();
  const doc = {
    doctype: 'Stock Reconciliation',
    purpose: 'Stock Reconciliation',
    company,
    set_posting_time: 1,
    posting_date: now.toISOString().slice(0, 10),
    posting_time: now.toTimeString().slice(0, 8),
    items: lines.map((l) => ({ item_code: l.item_code, warehouse, qty: l.qty })),
  };
  if (remarks) doc.remarks = remarks;
  const r = await api('/api/resource/Stock Reconciliation', {
    method: 'POST',
    body: JSON.stringify(doc),
  });
  return r.data; // includes .name (e.g. MAT-RECO-2026-00001)
}

export function docUrl(doctype, name) {
  return `${baseUrl()}/app/${doctype.toLowerCase().replace(/ /g, '-')}/${encodeURIComponent(name)}`;
}
