require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const { google } = require('googleapis');
const cron       = require('node-cron');
const path       = require('path');

const db = require('./db');
const { scanAllAccounts, scanAccount, buildOAuthClient } = require('./scanner');
const { processNotifications } = require('./notifications');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  store: new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'sessions',
    createTableIfMissing: true,
  }),
  secret:            process.env.SESSION_SECRET || 'dev-secret',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );
}

app.get('/auth/connect', (req, res) => {
  const url = getOAuthClient().generateAuthUrl({
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
    const { tokens }   = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2       = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data }     = await oauth2.userinfo.get();
    const email        = data.email;
    await db.upsertAccount(email, {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry:  tokens.expiry_date,
    });
    console.log(`[auth] Connected: ${email}`);
    const account = await db.getAccount(email);
    scanAccount(account).then(() => processNotifications()).catch(console.error);
    res.redirect('/?connected=' + encodeURIComponent(email));
  } catch (err) {
    console.error('[auth] Callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/auth/disconnect', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  await db.deleteAccount(email);
  res.json({ ok: true });
});

app.get('/api/accounts', async (req, res) => {
  const accounts = await db.getAccounts();
  res.json(accounts.map(a => ({ email: a.email, last_scanned: a.last_scanned })));
});

app.get('/api/shipments', async (req, res) => {
  const SKIP = /^cannot be verified$|tommy bahama|print.*marketing|p13n-asin|xfinity/i;
  const { status, account } = req.query;
  const all = await db.getShipments({ status, account });
  res.json(all.filter(s => !SKIP.test(s.description || '')));
});

app.get('/api/stats', async (req, res) => {
  res.json(await db.getStats());
});

app.post('/api/shipments/:id/receive', async (req, res) => {
  const id = parseInt(req.params.id);
  const result = await db.editShipment(id, { received: true });
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

app.delete('/api/shipments/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  await db.deleteShipment(id);
  res.json({ ok: true });
});

app.patch('/api/shipments/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { tracking_number, po_number, order_number, description, ship_to, status, received } = req.body;
  const updates = { tracking_number, po_number, order_number, description, ship_to };
  if (status   !== undefined) updates.status   = status;
  if (received !== undefined) updates.received = received;
  const result = await db.editShipment(id, updates);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'Invalid subscription' });
  await db.addSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  await db.deleteSubscription(endpoint);
  res.json({ ok: true });
});

app.post('/api/scan', async (req, res) => {
  res.json({ ok: true, message: 'Scan started' });
  try {
    await scanAllAccounts();
    await processNotifications();
  } catch (err) { console.error('[scan] Error:', err.message); }
});

app.get('/api/projects', async (req, res) => {
  const projects  = await db.getProjects();
  const shipments = await db.getShipments();
  const result = projects.map(p => {
    const ps = shipments.filter(s =>
      s.project_id === p.id ||
      (s.po_number && s.po_number.toLowerCase() === p.name.toLowerCase())
    );
    return { ...p, total:ps.length, delivered:ps.filter(s=>s.status==='delivered').length,
      in_transit:ps.filter(s=>s.status==='transit').length, shipped:ps.filter(s=>s.status==='shipped').length,
      pending:ps.filter(s=>s.status==='pending').length };
  });
  res.json(result);
});

app.post('/api/projects', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  res.json(await db.addProject(name));
});

app.patch('/api/projects/:id', async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = await db.renameProject(id, name);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

app.delete('/api/projects/:id', async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  await db.deleteProject(id);
  res.json({ ok: true });
});

app.post('/api/shipments/:id/assign', async (req, res) => {
  const id = parseInt(req.params.id);
  const { project_id } = req.body;
  const result = await db.assignShipmentToProject(id, project_id);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

app.post('/api/projects/auto-create', async (req, res) => {
  const shipments     = await db.getShipments();
  const existing      = await db.getProjects();
  const deleted       = await db.getDeletedProjects();
  const ignored       = await db.getIgnoredPOs();
  const existingNames = existing.map(p => p.name.toLowerCase().trim());
  const poNames       = [...new Set(shipments.map(s => s.po_number).filter(Boolean))];
  const pending       = [];
  poNames.forEach(po => {
    if (!po || po.length < 2) return;
    if (/^(old|new|number|none|na|n\/a|licies)$/i.test(po.trim())) return;
    const poLower = po.toLowerCase().trim();
    if (deleted.includes(poLower) || ignored.includes(poLower) || existingNames.includes(poLower)) return;
    pending.push(po);
  });
  res.json({ pending, projects: await db.getProjects() });
});

app.post('/api/projects/ignore-po', async (req, res) => {
  const { po } = req.body;
  if (!po) return res.status(400).json({ error: 'PO required' });
  await db.ignorePO(po);
  res.json({ ok: true });
});

app.get('/api/fix-descriptions', async (req, res) => {
  const r = await db.query("UPDATE shipments SET description=NULL WHERE description LIKE '%...'");
  res.json({ updated: r.rowCount });
});

const cronSchedule = process.env.SCAN_CRON || '0 */3 * * *';
cron.schedule(cronSchedule, async () => {
  console.log('[cron] Running scheduled scan...');
  try { await scanAllAccounts(); await processNotifications(); }
  catch (err) { console.error('[cron] Error:', err.message); }
});

cron.schedule('0 0 * * *', async () => {
  const count = await db.purgeOldDelivered(30);
  if (count > 0) console.log(`[cron] Purged ${count} old delivered shipments`);
});

db.init().then(async () => {
  const accounts = await db.getAccounts();
  app.listen(PORT, () => {
    console.log(`\nðŸš€ Shipment Tracker running at http://localhost:${PORT}`);
    console.log(`ðŸ“§ Scanning on schedule: ${cronSchedule}`);
    console.log(`ðŸ“Š Accounts connected: ${accounts.length}\n`);
  });
}).catch(err => {
  console.error('[startup] Failed to initialize database:', err.message);
  process.exit(1);
});



