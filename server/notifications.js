const nodemailer = require('nodemailer');
const webpush    = require('web-push');
const db         = require('./db');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@shiptracker.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendPushNotification(title, body, url = '/') {
  const subscriptions = await db.getSubscriptions();
  const payload = JSON.stringify({ title, body, url });
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.deleteSubscription(sub.endpoint);
      } else {
        console.error('[push] Error:', err.message);
      }
    }
  }
}

async function sendEmailNotification(subject, htmlBody) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) { console.error("[email] Missing RESEND_API_KEY or NOTIFY_EMAIL"); return; }
  const from = process.env.RESEND_FROM || "Shipment Tracker <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: from, to: to, subject: subject, html: htmlBody })
    });
    if (!res.ok) { const t = await res.text(); console.error("[email] Resend " + res.status + ": " + t); }
  } catch (err) { console.error("[email] Error:", err.message); }
}
function shipmentEmailHtml(shipment, type) {
  const icon    = type === 'delivered' ? '📦✅' : '🚚';
  const heading = type === 'delivered' ? 'Your package was delivered!' : 'Your package has shipped!';
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2>${icon} ${heading}</h2>
    <p style="color:#555">From your ${shipment.account_email} inbox</p>
    <div style="background:#f5f5f5;border-radius:8px;padding:16px">
      <p><strong>${shipment.description}</strong></p>
      <p style="color:#666;font-size:14px">Carrier: ${shipment.carrier}</p>
      ${shipment.tracking_number ? `<p style="color:#666;font-size:14px">Tracking: ${shipment.tracking_number}</p>` : ''}
      ${shipment.eta ? `<p style="color:#666;font-size:14px">ETA: ${shipment.eta}</p>` : ''}
    </div>
    <a href="${process.env.APP_URL}" style="display:inline-block;background:#1a1a1a;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;margin-top:16px">View Tracker</a>
  </div>`;
}

async function processNotifications() {
  const unnotified = await db.getUnnotified();
  for (const shipment of unnotified) {
    if (shipment.status === 'shipped' && !shipment.notified_shipped) {
      await sendPushNotification(`📦 Shipped: ${shipment.description}`, `${shipment.carrier}${shipment.eta ? ' · Est. ' + shipment.eta : ''}`);
      await sendEmailNotification(`Shipped: ${shipment.description}`, shipmentEmailHtml(shipment, 'shipped'));
      await db.markNotified(shipment.id, 'shipped');
    }
    if (shipment.status === 'delivered' && !shipment.notified_delivered) {
      await sendPushNotification(`✅ Delivered: ${shipment.description}`, `${shipment.carrier} · Check your door!`);
      await sendEmailNotification(`Delivered: ${shipment.description}`, shipmentEmailHtml(shipment, 'delivered'));
      await db.markNotified(shipment.id, 'delivered');
    }
  }
}

module.exports = { sendPushNotification, sendEmailNotification, processNotifications, sendDailySummary };

async function sendDailySummary() {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) { console.error("[summary] Missing RESEND_API_KEY or NOTIFY_EMAIL"); return; }
  const shipments = await db.getShipments();
  const fmtET = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
  const today = fmtET(new Date());
  const recent = {};
  for (let i = 0; i < 3; i++) recent[fmtET(new Date(Date.now() - i * 86400000))] = true;
  const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const gmailLink = (s) => {
    if (!s.thread_id) return process.env.APP_URL || "#";
    const idx = (s.account_email || "").includes("mjfllc") ? "1" : "0";
    return "https://mail.google.com/mail/u/" + idx + "/#all/" + s.thread_id;
  };
  const etaDate = (s) => {
    if (!s.eta) return null;
    const m = String(s.eta).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? m[3] + "-" + ("0" + m[1]).slice(-2) + "-" + ("0" + m[2]).slice(-2) : null;
  };
  const delivDate = (s) => (s.email_date ? fmtET(new Date(s.email_date * 1000)) : null);
  const arriving = shipments.filter((s) => s.status !== "delivered" && !s.received && etaDate(s) === today);
  const arrived = shipments.filter((s) => s.status === "delivered" && recent[delivDate(s)]);
  const row = (s) => {
    const bits = [];
    if (s.carrier && s.carrier !== "Other") bits.push(esc(s.carrier));
    if (s.tracking_number) bits.push(esc(s.tracking_number));
    if (s.po_number) bits.push("PO " + esc(s.po_number));
    const meta = bits.length ? '<div style="color:#777;font-size:13px;margin-top:2px">' + bits.join(" &middot; ") + "</div>" : "";
    return '<tr><td style="padding:10px 0;border-bottom:1px solid #eee"><a href="' + gmailLink(s) + '" style="color:#1a73e8;text-decoration:none;font-weight:600;font-size:14px">' + esc(s.description || "(no subject)") + "</a>" + meta + "</td></tr>";
  };
  const section = (title, list) =>
    !list.length
      ? '<h3 style="margin:24px 0 4px;font-size:15px">' + title + '</h3><p style="color:#999;font-size:13px;margin:0">None.</p>'
      : '<h3 style="margin:24px 0 4px;font-size:15px">' + title + " (" + list.length + ')</h3><table style="width:100%;border-collapse:collapse">' + list.map(row).join("") + "</table>";
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" }).format(new Date());
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:8px 16px;color:#222">' +
    '<h2 style="margin:0 0 2px">Shipment summary</h2>' +
    '<p style="color:#888;margin:0 0 8px;font-size:13px">' + dateLabel + "</p>" +
    section("Arriving today", arriving) +
    section("Delivered recently", arrived) +
    (process.env.APP_URL ? '<p style="margin-top:24px"><a href="' + process.env.APP_URL + '" style="display:inline-block;background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open tracker</a></p>' : "") +
    "</div>";
  const subject = "Daily Shipment Status for MJF LLC";
  await sendEmailNotification(subject, html);
  console.log("[summary] Sent: " + arriving.length + " arriving, " + arrived.length + " delivered");
}
