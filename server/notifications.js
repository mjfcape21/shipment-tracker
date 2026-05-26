const nodemailer = require('nodemailer');
const webpush = require('web-push');
const db = require('./db');

// Configure web push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@shiptracker.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Configure email
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
  const subscriptions = db.getSubscriptions();
  const payload = JSON.stringify({ title, body, url });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.deleteSubscription(sub.endpoint);
      } else {
        console.error('[push] Error:', err.message);
      }
    }
  }
}

async function sendEmailNotification(subject, htmlBody) {
  if (!transporter || !process.env.NOTIFY_EMAIL) return;
  try {
    await transporter.sendMail({
      from: `"Shipment Tracker" <${process.env.SMTP_USER}>`,
      to: process.env.NOTIFY_EMAIL,
      subject,
      html: htmlBody,
    });
  } catch (err) {
    console.error('[email] Error:', err.message);
  }
}

function shipmentEmailHtml(shipment, type) {
  const icon = type === 'delivered' ? '📦✅' : '🚚';
  const heading = type === 'delivered'
    ? `Your package was delivered!`
    : `Your package has shipped!`;

  return `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 8px">${icon} ${heading}</h2>
      <p style="color:#555;margin:0 0 16px">From your ${shipment.account_email} inbox</p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0 0 6px"><strong>${shipment.description}</strong></p>
        <p style="margin:0 0 4px;color:#666;font-size:14px">Carrier: ${shipment.carrier}</p>
        ${shipment.tracking_number ? `<p style="margin:0 0 4px;color:#666;font-size:14px">Tracking: ${shipment.tracking_number}</p>` : ''}
        ${shipment.eta ? `<p style="margin:0;color:#666;font-size:14px">ETA: ${shipment.eta}</p>` : ''}
      </div>
      <a href="${process.env.APP_URL}" style="display:inline-block;background:#1a1a1a;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px">View Tracker</a>
    </div>
  `;
}

async function processNotifications() {
  const unnotified = db.getUnnotified();

  for (const shipment of unnotified) {
    if (shipment.status === 'shipped' && !shipment.notified_shipped) {
      const title = `📦 Shipped: ${shipment.description}`;
      const body = `${shipment.carrier}${shipment.eta ? ' · Est. ' + shipment.eta : ''}`;
      await sendPushNotification(title, body);
      await sendEmailNotification(`Shipped: ${shipment.description}`, shipmentEmailHtml(shipment, 'shipped'));
      db.markNotified(shipment.id, 'shipped');
    }

    if (shipment.status === 'delivered' && !shipment.notified_delivered) {
      const title = `✅ Delivered: ${shipment.description}`;
      const body = `${shipment.carrier} · Check your door!`;
      await sendPushNotification(title, body);
      await sendEmailNotification(`Delivered: ${shipment.description}`, shipmentEmailHtml(shipment, 'delivered'));
      db.markNotified(shipment.id, 'delivered');
    }
  }
}

module.exports = { sendPushNotification, sendEmailNotification, processNotifications };
