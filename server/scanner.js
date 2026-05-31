const { google } = require('googleapis');
const db = require('./db');

const CARRIER_PATTERNS = [
  { name: 'UPS',   from: /ups\.com|mcinfo@ups/i,        subject: /ups/i },
  { name: 'FedEx', from: /fedex\.com/i,                  subject: /fedex/i },
  { name: 'USPS',  from: /usps\.com|informeddelivery/i,  subject: /usps|postal/i },
  { name: 'Amazon',from: /amazon\.com/i,                 subject: /amazon/i },
  { name: 'DHL',   from: /dhl\.com/i,                    subject: /\bdhl\b/i },
];

// Extended tracking number patterns
const TRACKING_PATTERNS = [
  // UPS
  /\b(1Z[A-Z0-9]{16})\b/,
  // FedEx 12/15/20 digit
  /\b(\d{20})\b/,
  /\b(\d{15})\b/,
  /\b(\d{12})\b/,
  // USPS 22 digit
  /\b(\d{22})\b/,
  // Explicit label
  /tracking\s*(?:number|#|num|no)?[:\s]+([A-Z0-9]{8,30})/i,
  /track[:\s]+([A-Z0-9]{8,30})/i,
  // FedEx door tag
  /\b(DT\d{12})\b/i,
  // Amazon TBA
  /\b(TBA\d{12,16})\b/i,
  // Generic alphanumeric 10-30 chars after common labels
  /(?:shipment|parcel|package)\s*(?:id|#|number)?[:\s]+([A-Z0-9]{8,30})/i,
];

// PO number patterns
const PO_PATTERNS = [
  /\bPO#\s+([A-Za-z0-9][A-Za-z0-9\s\-]{1,30}?)(?:\s+ORDER#|\s*$)/i,
  /\bPO\s+([0-9]+\s+[A-Za-z][A-Za-z0-9\s\-]{1,25}?)(?:\s+ORDER|\s*$)/i,
  /\bPO#?\s*[-:]?\s*([A-Z0-9][\w\-]{2,30})/i,
  /\bP\.O\.?\s*#?\s*([A-Z0-9][\w\-]{2,30})/i,
  /\bpurchase\s+order\s*#?\s*([A-Z0-9][\w\-]{2,30})/i,
];

const STATUS_PATTERNS = {
  delivered: /delivered|delivery complete|package delivered|has been delivered/i,
  transit:   /out for delivery|on the way|in transit|en route|arriving today|arriving tomorrow|scheduled for delivery/i,
  shipped:   /has shipped|order shipped|your order.*shipped|shipment notification|ship notification|has been shipped/i,
};

const ETA_PATTERN = /(?:estimated|expected|scheduled|arriving|delivery|by)\s+(?:delivery\s+)?(?:date[:\s]+)?([A-Za-z]+,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December|\d{1,2}\/\d{1,2})[^,\n.]{0,25})/i;

function detectCarrier(sender, subject, bodyText) {
  for (const p of CARRIER_PATTERNS) {
    if (p.from.test(sender) || p.subject.test(subject)) return p.name;
  }
  const m = subject.match(/from\s+([A-Z][A-Z\s&]+?)(?:\s+estimated|\s+scheduled|$)/i);
  if (bodyText) {
    if (/\b1Z[A-Z0-9]{16}\b/.test(bodyText)) return 'UPS';
    if (/\b\d{20}\b/.test(bodyText)) return 'FedEx';
    if (/\b9[24]\d{18}\b/.test(bodyText)) return 'USPS';
  }
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  return 'Other';
}

function detectStatus(subject, snippet) {
  const text = subject + ' ' + snippet;
  if (STATUS_PATTERNS.delivered.test(text)) return 'delivered';
  if (STATUS_PATTERNS.transit.test(text))   return 'transit';
  if (STATUS_PATTERNS.shipped.test(text))   return 'shipped';
  return 'pending';
}

function extractTracking(text) {
  for (const p of TRACKING_PATTERNS) {
    const m = text.match(p);
    if (m) {
      const val = m[1] || m[0];
      // Filter out short/noisy matches
      if (val && val.length >= 8) return val.trim();
    }
  }
  return null;
}

function extractPO(text) {
  for (const p of PO_PATTERNS) {
    const m = text.match(p);
    if (m && m[1]) {
      const val = m[1].trim();
      // Filter out obviously wrong matches
      if (val.length >= 2 && val.length <= 40) return val;
    }
  }
  return null;
}

function extractETA(text) {
  const m = text.match(ETA_PATTERN);
  return m ? m[1].trim() : null;
}

function extractDescription(subject) {
  let desc = subject
    .replace(/^(your\s+)?amazon\.com\s+order\s+of\s+/i, '')
    .replace(/^(your\s+)?amazon\s+package\s+/i, '')
    .replace(/\s+has\s+shipped!?$/i, '')
    .replace(/^ups\s+(ship\s+notification|update)[,:]?\s*/i, '')
    .replace(/^fedex\s+tracking\s*/i, '')
    .replace(/^order\s+(shipped|confirmed)\s*\|?\s*/i, '')
    .replace(/\s*tracking\s+number\s+\w+/i, '')
    .replace(/[#|]\s*order\s+number.*$/i, '')
    .trim();
  desc = desc.replace(/^["']|["']$/g, '').trim();
  
  return desc || subject;
}

function buildOAuthClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    if (newTokens.refresh_token || newTokens.access_token) {
      db.upsertAccount(tokens._email, {
        access_token: newTokens.access_token || tokens.access_token,
        refresh_token: newTokens.refresh_token || tokens.refresh_token,
        token_expiry: newTokens.expiry_date || tokens.expiry_date,
      });
    }
  });
  return client;
}

async function scanAccount(account) {
  console.log(`[scanner] Scanning ${account.email}...`);
  const auth = buildOAuthClient({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry,
    _email: account.email,
  });
  const gmail = google.gmail({ version: 'v1', auth });
  const query = 'subject:(shipped OR tracking OR "out for delivery" OR "order shipped" OR "delivery notification" OR "package scheduled" OR "PO#" OR "purchase order") newer_than:90d';
  let pageToken;
  let newCount = 0;

  do {
    const res = await gmail.users.threads.list({
      userId: 'me', q: query, maxResults: 50, pageToken,
    });
    const threads = res.data.threads || [];
    pageToken = res.data.nextPageToken;

    for (const thread of threads) {
      try {
        const detail = await gmail.users.threads.get({
          userId: 'me', id: thread.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        });
        const messages = detail.data.messages || [];
        if (!messages.length) continue;

        const allSnippets = messages.map(m => m.snippet || '').join(' ');
        const firstMsg = messages[0];
        const lastMsg  = messages[messages.length - 1];

        const getHeader = (msg, name) => {
          const h = (msg.payload?.headers || []).find(h => h.name === name);
          return h?.value || '';
        };

        const subject  = getHeader(firstMsg, 'Subject');
        const sender   = getHeader(firstMsg, 'From');
        const dateStr  = getHeader(lastMsg, 'Date');
        const emailDate = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0;

        const carrier     = detectCarrier(sender, subject, allSnippets);
        const status      = detectStatus(subject, allSnippets);
        const tracking    = extractTracking(subject + ' ' + allSnippets);
        const po_number   = extractPO(subject + ' ' + allSnippets);
        const eta         = extractETA(allSnippets);
        const description = subject;

        if (carrier === 'Other' && status === 'pending' && !po_number) continue;

        const result = db.upsertShipment({
          account_email: account.email,
          thread_id: thread.id,
          carrier,
          tracking_number: tracking,
          po_number,
          description,
          status,
          eta,
          sender: sender.replace(/<.*>/, '').trim() || sender,
          email_date: emailDate,
        });

        if (result) newCount++;
      } catch (err) {
        console.error(`[scanner] Error processing thread ${thread.id}:`, err.message);
      }
    }
  } while (pageToken);

  db.updateLastScanned(account.email);
  console.log(`[scanner] Done: ${account.email} â€” ${newCount} shipments upserted`);
  return newCount;
}

async function scanAllAccounts() {
  const accounts = db.getAccounts();
  let total = 0;
  for (const account of accounts) {
    try { total += await scanAccount(account); }
    catch (err) { console.error(`[scanner] Failed for ${account.email}:`, err.message); }
  }
  return total;
}

module.exports = { scanAllAccounts, scanAccount, buildOAuthClient };

