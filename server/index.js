require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { google } = require('googleapis');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const { scanAllAccounts, scanAccount, buildOAuthClient } = require('./scanner');
const { processNotifications } = require('./notifications');

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  store: new FileStore({ path: dataDir, ttl: 30 * 24 * 60 * 60, retries: 1 }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/auth/connect', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));
  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    const email = data.email;
    db.upsertAccount(email, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry: tokens.expiry_date,
    });
    console.log(`[auth] Connected: ${email}`);
    scanAccount(db.getAccount(email)).then(() => processNotifications()).catch(console.error);
    res.redirect('/?connected=' + encodeURIComponent(email));
  } catch (err) {
    console.error('[auth] Callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/auth/disconnect', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  db.deleteAccount(email);
  res.json({ ok: true });
});

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/accounts', (req, res) => {
  res.json(db.getAccounts().map(a => ({ email: a.email, last_scanned: a.last_scanned })));
});

app.get('/api/shipments', (req, res) => {
  const SKIP = /^cannot be verified$|tommy bahama|print.*marketing|p13n-asin|xfinity/i;
  const { status, account } = req.query;
  const all = db.getShipments({ status, account });
  res.json(all.filter(s => !SKIP.test(s.description || '')));
});

app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

// Manual edit — tracking number, PO, description
app.post('/api/shipments/:id/receive', (req, res) => {
  const id = parseInt(req.params.id);
  const result = db.editShipment(id, { received: true });
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

app.delete('/api/shipments/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const result = db.deleteShipment(id);
  res.json({ ok: true, deleted: result });
});

app.patch('/api/shipments/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { tracking_number, po_number, description } = req.body;
  const result = db.editShipment(id, { tracking_number, po_number, description });
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

// Web Push
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'Invalid subscription' });
  db.addSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  db.deleteSubscription(endpoint);
  res.json({ ok: true });
});

app.post('/api/scan', async (req, res) => {
  res.json({ ok: true, message: 'Scan started' });
  try {
    await scanAllAccounts();
    await processNotifications();
  } catch (err) {
    console.error('[scan] Error:', err.message);
  }
});

// ── Scheduled tasks ───────────────────────────────────────────────────────────

const cronSchedule = process.env.SCAN_CRON || '0 */3 * * *';
cron.schedule(cronSchedule, async () => {
  console.log('[cron] Running scheduled scan...');
  try {
    await scanAllAccounts();
    await processNotifications();
  } catch (err) { console.error('[cron] Error:', err.message); }
});

// Purge delivered shipments older than 30 days — runs daily at midnight
cron.schedule('0 0 * * *', () => {
  console.log('[cron] Purging old delivered shipments...');
  const count = db.purgeOldDelivered(30);
  console.log(`[cron] Purged ${count} shipments`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Shipment Tracker running at http://localhost:${PORT}`);
  console.log(`📧 Scanning on schedule: ${cronSchedule}`);
  console.log(`📊 Accounts connected: ${db.getAccounts().length}\n`);
});

// ── Project routes ────────────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  const projects = db.getProjects();
  const shipments = db.getShipments();
  // Attach stats to each project
  const result = projects.map(p => {
    const pShipments = shipments.filter(s => s.project_id === p.id || (s.po_number && s.po_number.toLowerCase() === p.name.toLowerCase()));
    return {
      ...p,
      total: pShipments.length,
      delivered: pShipments.filter(s => s.status === 'delivered').length,
      in_transit: pShipments.filter(s => s.status === 'transit').length,
      shipped: pShipments.filter(s => s.status === 'shipped').length,
      pending: pShipments.filter(s => s.status === 'pending').length,
    };
  });
  res.json(result);
});

app.post('/api/projects', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const project = db.addProject(name);
  res.json(project);
});

app.patch('/api/projects/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = db.renameProject(id, name);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

app.delete('/api/projects/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  console.log('[project] Deleting:', id);
  db.deleteProject(id);
  res.json({ ok: true });
});

app.post('/api/shipments/:id/assign', (req, res) => {
  const id = parseInt(req.params.id);
  const { project_id } = req.body;
  const result = db.assignShipmentToProject(id, project_id);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

// Auto-create projects from PO names in shipments
app.post('/api/projects/auto-create', (req, res) => {
  const shipments = db.getShipments();
  const poNames = [...new Set(shipments.map(s => s.po_number).filter(Boolean))];
  const existing = db.getProjects();
  const deleted = db.getDeletedProjects();
  const ignored = db.getIgnoredPOs();
  const existingNames = existing.map(p => p.name.toLowerCase().trim());
  
  const pending = [];
  const autoCreated = [];
  
  poNames.forEach(po => {
    if (!po || po.length < 2) return;
    if (/^(old|new|number|none|na|n\/a|licies)$/i.test(po.trim())) return;
    const poLower = po.toLowerCase().trim();
    if (deleted.includes(poLower)) return;
    if (ignored.includes(poLower)) return;
    if (existingNames.includes(poLower)) return;
    // New PO found - add to pending for user review
    pending.push(po);
  });
  
  res.json({ pending, projects: db.getProjects() });
});

app.post('/api/projects/ignore-po', (req, res) => {
  const { po } = req.body;
  if (!po) return res.status(400).json({ error: 'PO required' });
  db.ignorePO(po);
  res.json({ ok: true });
});
