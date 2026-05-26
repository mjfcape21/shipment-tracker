# Shipment Tracker

A personal web app that scans multiple Gmail accounts for shipping emails and shows everything in one dashboard — with email and push notifications when packages ship or arrive.

## Features

- ✅ Connect **multiple Gmail accounts** simultaneously
- 🔄 **Auto-scans** every 3 hours (configurable)
- 📦 Detects UPS, FedEx, USPS, Amazon, DHL, and more
- 🔔 **Push notifications** on mobile (add to home screen)
- 📧 **Email alerts** when something ships or is delivered
- 📱 Works as a **PWA** — add to your phone's home screen

---

## Setup (takes ~15 minutes)

### Step 1 — Create a Google OAuth App

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (call it "Shipment Tracker")
3. Go to **APIs & Services → Enable APIs** → search for and enable **Gmail API**
4. Go to **APIs & Services → OAuth consent screen**
   - Choose **External**, fill in app name and your email
   - Add scope: `https://www.googleapis.com/auth/gmail.readonly`
   - Add your own email as a test user
5. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: add `https://YOUR-APP-URL/auth/callback`
     (and `http://localhost:3000/auth/callback` for local dev)
6. Copy the **Client ID** and **Client Secret**

### Step 2 — Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from Step 1
- `APP_URL` — your Railway URL (get this after deploying, then update)
- `SESSION_SECRET` — any long random string
- `SMTP_*` and `NOTIFY_EMAIL` — for email notifications (use a Gmail App Password)

### Step 3 — Generate VAPID keys (for push notifications)

```bash
npm install
node server/generate-vapid.js
```

Paste the output into your `.env` file.

### Step 4 — Deploy to Railway

1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. In the project folder:
   ```bash
   railway init
   railway up
   ```
4. Set environment variables in Railway dashboard → Variables (paste from your `.env`)
5. Go to Railway dashboard → Settings → Domains → Generate a domain
6. Update `APP_URL` in Railway variables to your new domain
7. Update the Google OAuth redirect URI to include your Railway domain

### Step 5 — Connect your Gmail accounts

1. Open your app URL
2. Click **Connect Gmail** and sign in with your first account
3. Click **Connect Gmail** again and sign in with your second account
4. Both accounts appear in the sidebar — the first scan starts automatically!

---

## Local development

```bash
npm install
cp .env.example .env
# fill in .env
npm run dev
# open http://localhost:3000
```

---

## How it works

- Every 3 hours (or when you click "Scan now"), the app searches each connected Gmail for shipping-related emails from the last 90 days
- It parses carrier, tracking number, status, and ETA from email subjects and snippets
- New or updated shipments trigger push notifications and emails
- All data is stored locally in a SQLite database (`data/tracker.db`)

---

## Customizing the scan interval

Edit `SCAN_CRON` in `.env` using cron syntax:
- `0 */3 * * *` — every 3 hours (default)
- `0 */1 * * *` — every hour
- `0 8,12,18 * * *` — at 8am, noon, and 6pm

---

## Troubleshooting

**"Access blocked" on Google login** — Make sure you added your email as a test user in the OAuth consent screen.

**No shipments showing up** — Click "Scan now" and wait a few seconds. Check the Railway logs for any errors.

**Push notifications not working** — Make sure VAPID keys are set in your environment variables, and that you're accessing the app over HTTPS (required for push).
