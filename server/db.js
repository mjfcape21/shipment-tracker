const path = require('path');
const fs   = require('fs');

const DB_DIR  = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_PATH = path.join(DB_DIR, 'tracker.json');

console.log('[db] Data directory:', DB_DIR);
console.log('[db] Data file:', DB_PATH);

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  console.log('[db] Created data directory');
} else {
  console.log('[db] Data directory already exists');
}

let store = { accounts: [], shipments: [], subscriptions: [], projects: [], deletedProjects: [], ignoredPOs: [] };

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      store.accounts        = raw.accounts        || [];
      store.shipments       = raw.shipments       || [];
      store.subscriptions   = raw.subscriptions   || [];
      store.projects        = raw.projects        || [];
      store.deletedProjects = raw.deletedProjects || [];
      store.ignoredPOs      = raw.ignoredPOs      || [];
      console.log('[db] Loaded:', store.accounts.length, 'accounts,', store.shipments.length, 'shipments,', store.projects.length, 'projects');
    } else {
      console.log('[db] No existing data file, starting fresh');
    }
  } catch (e) { console.error('[db] Load error:', e.message); }
}

function save() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2)); }
  catch (e) { console.error('[db] Save error:', e.message); }
}

load();

// ── Accounts ──────────────────────────────────────────────────────────────────
function getAccounts() { return store.accounts; }
function getAccount(email) { return store.accounts.find(a => a.email === email) || null; }

function upsertAccount(email, tokens) {
  const idx = store.accounts.findIndex(a => a.email === email);
  const now = Math.floor(Date.now() / 1000);
  if (idx >= 0) {
    store.accounts[idx] = {
      ...store.accounts[idx],
      access_token:  tokens.access_token  || store.accounts[idx].access_token,
      refresh_token: tokens.refresh_token || store.accounts[idx].refresh_token,
      token_expiry:  tokens.token_expiry  || store.accounts[idx].token_expiry,
    };
  } else {
    store.accounts.push({ email, ...tokens, last_scanned: null, created_at: now });
  }
  save();
}

function updateLastScanned(email) {
  const acc = store.accounts.find(a => a.email === email);
  if (acc) { acc.last_scanned = Math.floor(Date.now() / 1000); save(); }
}

function deleteAccount(email) {
  store.accounts = store.accounts.filter(a => a.email !== email);
  save();
}

// ── Shipments ─────────────────────────────────────────────────────────────────
function getShipments(filter = {}) {
  let list = [...store.shipments];
  if (filter.status)  list = list.filter(s => s.status === filter.status);
  if (filter.account) list = list.filter(s => s.account_email === filter.account);
  return list.sort((a, b) => (b.email_date || 0) - (a.email_date || 0));
}

function upsertShipment(data) {
  const idx = store.shipments.findIndex(
    s => s.account_email === data.account_email && s.thread_id === data.thread_id
  );
  const now = Math.floor(Date.now() / 1000);
  const priority = { delivered: 4, transit: 3, shipped: 2, pending: 1 };

  if (idx >= 0) {
    const existing = store.shipments[idx];
    const newStatus = (priority[data.status] || 0) > (priority[existing.status] || 0)
      ? data.status : existing.status;
    store.shipments[idx] = {
      ...existing,
      status:          newStatus,
      tracking_number: data.tracking_number || existing.tracking_number,
      po_number:       data.po_number       || existing.po_number,
      eta:             data.eta             || existing.eta,
      updated_at:      now,
    };
    save();
    return store.shipments[idx];
  } else {
    const newItem = {
      id: Date.now(),
      ...data,
      notified_shipped:   0,
      notified_delivered: 0,
      created_at: now,
      updated_at: now,
    };
    store.shipments.push(newItem);
    save();
    return newItem;
  }
}

function editShipment(id, updates) {
  const s = store.shipments.find(s => s.id === id);
  if (!s) return null;
  if (updates.tracking_number !== undefined) s.tracking_number = updates.tracking_number;
  if (updates.po_number       !== undefined) s.po_number       = updates.po_number;
  if (updates.order_number    !== undefined) s.order_number    = updates.order_number;
  if (updates.description     !== undefined) s.description     = updates.description;
  if (updates.ship_to         !== undefined) s.ship_to         = updates.ship_to;
  if (updates.status          !== undefined) s.status          = updates.status;
  if (updates.received        !== undefined) s.received        = updates.received;
  s.updated_at = Math.floor(Date.now() / 1000);
  save();
  return s;
}

function deleteShipment(id) {
  const idx = store.shipments.findIndex(s => s.id === id);
  if (idx < 0) return null;
  const removed = store.shipments.splice(idx, 1)[0];
  save();
  return removed;
}

function purgeOldDelivered(days = 30) {
  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  const before = store.shipments.length;
  store.shipments = store.shipments.filter(s => {
    if (s.status !== 'delivered') return true;
    const age = s.updated_at || s.created_at || 0;
    return age > cutoff;
  });
  const removed = before - store.shipments.length;
  if (removed > 0) save();
  return removed;
}

function getUnnotified() {
  return store.shipments.filter(s =>
    (s.status === 'shipped'   && !s.notified_shipped) ||
    (s.status === 'delivered' && !s.notified_delivered)
  );
}

function markNotified(id, type) {
  const s = store.shipments.find(s => s.id === id);
  if (s) { s[`notified_${type}`] = 1; save(); }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function getStats() {
  const s = store.shipments;
  return {
    total:      s.length,
    delivered:  s.filter(x => x.status === 'delivered').length,
    in_transit: s.filter(x => x.status === 'transit').length,
    shipped:    s.filter(x => x.status === 'shipped').length,
    pending:    s.filter(x => x.status === 'pending').length,
    received:   s.filter(x => x.received).length,
  };
}

// ── Push subscriptions ────────────────────────────────────────────────────────
function addSubscription(sub) {
  const exists = store.subscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) { store.subscriptions.push(sub); save(); }
}
function getSubscriptions() { return store.subscriptions; }
function deleteSubscription(endpoint) {
  store.subscriptions = store.subscriptions.filter(s => s.endpoint !== endpoint);
  save();
}

// ── Projects ──────────────────────────────────────────────────────────────────
function getProjects() { return store.projects; }

function upsertProject(name) {
  const existing = store.projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const project = {
    id: 'proj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    name,
    created_at: Math.floor(Date.now() / 1000),
  };
  store.projects.push(project);
  save();
  return project;
}

function addProject(name) {
  if (!name || !name.trim()) return null;
  return upsertProject(name.trim());
}

function deleteProject(id) {
  const proj = store.projects.find(p => p.id === id);
  if (proj) {
    const nameLower = proj.name.toLowerCase().trim();
    if (!store.deletedProjects.includes(nameLower)) {
      store.deletedProjects.push(nameLower);
    }
  }
  store.projects = store.projects.filter(p => p.id !== id);
  store.shipments.forEach(s => { if (s.project_id === id) s.project_id = null; });
  save();
}

function renameProject(id, newName) {
  const proj = store.projects.find(p => p.id === id);
  if (!proj) return null;
  proj.name = newName.trim();
  save();
  return proj;
}

function getDeletedProjects() { return store.deletedProjects; }

function assignShipmentToProject(shipmentId, projectId) {
  const s = store.shipments.find(s => s.id === shipmentId);
  if (!s) return null;
  s.project_id = projectId || null;
  save();
  return s;
}

// ── Ignored POs ───────────────────────────────────────────────────────────────
function getIgnoredPOs() { return store.ignoredPOs; }

function ignorePO(po) {
  const poLower = po.toLowerCase().trim();
  if (!store.ignoredPOs.includes(poLower)) {
    store.ignoredPOs.push(poLower);
    save();
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  getAccounts, getAccount, upsertAccount, updateLastScanned, deleteAccount,
  getShipments, upsertShipment, editShipment, deleteShipment, purgeOldDelivered,
  getUnnotified, markNotified,
  addSubscription, getSubscriptions, deleteSubscription,
  getStats,
  getProjects, upsertProject, addProject, deleteProject, renameProject,
  getDeletedProjects, assignShipmentToProject,
  getIgnoredPOs, ignorePO,
};
