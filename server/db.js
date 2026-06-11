const { Pool, types } = require('pg');
types.setTypeParser(20, v => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function init() {
  await query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at BIGINT)');
  await query(`CREATE TABLE IF NOT EXISTS accounts (
    email         TEXT PRIMARY KEY,
    access_token  TEXT,
    refresh_token TEXT,
    token_expiry  BIGINT,
    last_scanned  BIGINT,
    created_at    BIGINT
  )`);
  await query(`CREATE TABLE IF NOT EXISTS shipments (
    id                  BIGINT PRIMARY KEY,
    account_email       TEXT,
    thread_id           TEXT,
    carrier             TEXT,
    tracking_number     TEXT,
    po_number           TEXT,
    order_number        TEXT,
    description         TEXT,
    status              TEXT,
    eta                 TEXT,
    sender              TEXT,
    ship_to             TEXT,
    email_date          BIGINT,
    received            BOOLEAN DEFAULT FALSE,
    project_id          TEXT,
    notified_shipped    INT DEFAULT 0,
    notified_delivered  INT DEFAULT 0,
    created_at          BIGINT,
    updated_at          BIGINT,
    UNIQUE(account_email, thread_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT UNIQUE,
    created_at BIGINT
  )`);
  await query(`CREATE TABLE IF NOT EXISTS deleted_projects (name_lower TEXT PRIMARY KEY)`);
  await query(`CREATE TABLE IF NOT EXISTS ignored_pos (po_lower TEXT PRIMARY KEY)`);
  await query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh   TEXT,
    auth     TEXT
  )`);
  await query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS vendor TEXT');
  await query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS priority BOOLEAN DEFAULT FALSE');
  console.log('[db] PostgreSQL tables ready');
}

async function getAccounts() {
  const r = await query('SELECT * FROM accounts ORDER BY created_at');
  return r.rows;
}
async function getAccount(email) {
  const r = await query('SELECT * FROM accounts WHERE email=$1', [email]);
  return r.rows[0] || null;
}
async function upsertAccount(email, tokens) {
  const now = Math.floor(Date.now() / 1000);
  await query(`INSERT INTO accounts(email,access_token,refresh_token,token_expiry,last_scanned,created_at)
    VALUES($1,$2,$3,$4,NULL,$5)
    ON CONFLICT(email) DO UPDATE SET
      access_token=COALESCE($2,accounts.access_token),
      refresh_token=COALESCE($3,accounts.refresh_token),
      token_expiry=COALESCE($4,accounts.token_expiry)`,
    [email, tokens.access_token, tokens.refresh_token, tokens.token_expiry, now]);
}
async function updateLastScanned(email) {
  await query('UPDATE accounts SET last_scanned=$1 WHERE email=$2', [Math.floor(Date.now()/1000), email]);
}
async function deleteAccount(email) {
  await query('DELETE FROM accounts WHERE email=$1', [email]);
}

async function getShipments(filter = {}) {
  let sql = 'SELECT * FROM shipments';
  const params = []; const conds = [];
  if (filter.status)  { params.push(filter.status);  conds.push('status=$' + params.length); }
  if (filter.account) { params.push(filter.account); conds.push('account_email=$' + params.length); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY email_date DESC NULLS LAST';
  const r = await query(sql, params);
  return r.rows;
}

async function upsertShipment(data) {
  const now = Math.floor(Date.now() / 1000);
  const priority = { delivered: 4, transit: 3, shipped: 2, pending: 1 };
  const ex = await query('SELECT * FROM shipments WHERE account_email=$1 AND thread_id=$2',
    [data.account_email, data.thread_id]);
  if (ex.rows.length > 0) {
    const existing = ex.rows[0];
    const newStatus = (priority[data.status]||0) > (priority[existing.status]||0) ? data.status : existing.status;
    const r = await query(`UPDATE shipments SET status=$1,tracking_number=COALESCE($2,tracking_number),
      po_number=COALESCE($3,po_number),eta=COALESCE($4,eta),description=COALESCE($8,description),updated_at=$5
      WHERE account_email=$6 AND thread_id=$7 RETURNING *`,
      [newStatus, data.tracking_number, data.po_number, data.eta, now, data.account_email, data.thread_id, data.description||null]);
    return r.rows[0];
  } else {
    const id = Date.now();
    const r = await query(`INSERT INTO shipments(id,account_email,thread_id,carrier,tracking_number,
      po_number,order_number,description,status,eta,sender,ship_to,email_date,
      received,project_id,notified_shipped,notified_delivered,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,NULL,0,0,$14,$14) RETURNING *`,
      [id,data.account_email,data.thread_id,data.carrier,data.tracking_number,
       data.po_number,data.order_number,data.description,data.status,data.eta,
       data.sender,data.ship_to,data.email_date,now]);
    return r.rows[0];
  }
}

async function editShipment(id, updates) {
  const fields = []; const params = [];
  const allowed = ['tracking_number','po_number','order_number','description','ship_to','status','received','carrier','vendor','priority'];
  for (const key of allowed) {
    if (updates[key] !== undefined) { params.push(updates[key]); fields.push(key + '=$' + params.length); }
  }
  if (!fields.length) return null;
  params.push(Math.floor(Date.now()/1000)); fields.push('updated_at=$' + params.length);
  params.push(id);
  const r = await query('UPDATE shipments SET ' + fields.join(',') + ' WHERE id=$' + params.length + ' RETURNING *', params);
  return r.rows[0] || null;
}

async function deleteShipment(id) {
  const r = await query('DELETE FROM shipments WHERE id=$1 RETURNING *', [id]);
  return r.rows[0] || null;
}
async function purgeOldDelivered(days=30) {
  const cutoff = Math.floor(Date.now()/1000) - (days*24*60*60);
  const r = await query("DELETE FROM shipments WHERE status='delivered' AND updated_at<$1", [cutoff]);
  return r.rowCount;
}
async function getUnnotified() {
  const r = await query("SELECT * FROM shipments WHERE (status='shipped' AND notified_shipped=0) OR (status='delivered' AND notified_delivered=0)");
  return r.rows;
}
async function markNotified(id, type) {
  const col = type === 'shipped' ? 'notified_shipped' : 'notified_delivered';
  await query('UPDATE shipments SET ' + col + '=1 WHERE id=$1', [id]);
}

async function getStats() {
  const r = await query(`SELECT COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status='delivered') AS delivered,
    COUNT(*) FILTER (WHERE status='transit') AS in_transit,
    COUNT(*) FILTER (WHERE status='shipped') AS shipped,
    COUNT(*) FILTER (WHERE status='pending') AS pending,
    COUNT(*) FILTER (WHERE received=TRUE) AS received
    FROM shipments`);
  const row = r.rows[0];
  return { total:parseInt(row.total), delivered:parseInt(row.delivered), in_transit:parseInt(row.in_transit),
    shipped:parseInt(row.shipped), pending:parseInt(row.pending), received:parseInt(row.received) };
}

async function addSubscription(sub) {
  await query('INSERT INTO push_subscriptions(endpoint,p256dh,auth) VALUES($1,$2,$3) ON CONFLICT(endpoint) DO NOTHING',
    [sub.endpoint, sub.p256dh, sub.auth]);
}
async function getSubscriptions() { const r = await query('SELECT * FROM push_subscriptions'); return r.rows; }
async function deleteSubscription(endpoint) { await query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]); }

async function getProjects() { const r = await query('SELECT * FROM projects ORDER BY name'); return r.rows; }
async function upsertProject(name) {
  const id = 'proj_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
  const now = Math.floor(Date.now()/1000);
  const r = await query('INSERT INTO projects(id,name,created_at) VALUES($1,$2,$3) ON CONFLICT(name) DO UPDATE SET name=projects.name RETURNING *', [id,name,now]);
  return r.rows[0];
}
async function addProject(name) { if (!name||!name.trim()) return null; return upsertProject(name.trim()); }
async function deleteProject(id) {
  const proj = await query('SELECT * FROM projects WHERE id=$1', [id]);
  if (proj.rows.length) await query('INSERT INTO deleted_projects(name_lower) VALUES($1) ON CONFLICT DO NOTHING', [proj.rows[0].name.toLowerCase().trim()]);
  await query('DELETE FROM projects WHERE id=$1', [id]);
  await query('UPDATE shipments SET project_id=NULL WHERE project_id=$1', [id]);
}
async function renameProject(id, newName) {
  const r = await query('UPDATE projects SET name=$1 WHERE id=$2 RETURNING *', [newName.trim(), id]);
  return r.rows[0] || null;
}
async function getDeletedProjects() { const r = await query('SELECT name_lower FROM deleted_projects'); return r.rows.map(r=>r.name_lower); }
async function assignShipmentToProject(shipmentId, projectId) {
  const r = await query('UPDATE shipments SET project_id=$1 WHERE id=$2 RETURNING *', [projectId||null, shipmentId]);
  return r.rows[0] || null;
}
async function getIgnoredPOs() { const r = await query('SELECT po_lower FROM ignored_pos'); return r.rows.map(r=>r.po_lower); }
async function ignorePO(po) { await query('INSERT INTO ignored_pos(po_lower) VALUES($1) ON CONFLICT DO NOTHING', [po.toLowerCase().trim()]); }

module.exports = { init, query,
  getAccounts, getAccount, upsertAccount, updateLastScanned, deleteAccount,
  getShipments, upsertShipment, editShipment, deleteShipment, purgeOldDelivered,
  getUnnotified, markNotified, addSubscription, getSubscriptions, deleteSubscription,
  getStats, getProjects, upsertProject, addProject, deleteProject, renameProject,
  getDeletedProjects, assignShipmentToProject, getIgnoredPOs, ignorePO, getSettings, saveSettings };

async function getSettings() {
  const r = await query("SELECT key, value FROM settings");
  const out = {};
  for (const row of r.rows) {
    try { out[row.key] = JSON.parse(row.value); }
    catch (e) { out[row.key] = row.value; }
  }
  return out;
}

async function saveSettings(obj) {
  if (!obj || typeof obj !== "object") return;
  const now = Math.floor(Date.now() / 1000);
  for (const key of Object.keys(obj)) {
    const value = JSON.stringify(obj[key]);
    await query(
      "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3",
      [key, value, now]
    );
  }
}
