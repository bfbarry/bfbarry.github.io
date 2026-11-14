/**
 * Support form backend: Google Apps Script web app.
 *
 * Deploy: Deploy > New deployment > type "Web app"
 *   Execute as:      Me
 *   Who has access:  Anyone
 * Copy the /exec URL into ENDPOINT in support.html.
 *
 * To update later without changing the URL:
 *   Deploy > Manage deployments > (pencil) > Version: New version > Deploy
 */

const CONFIG = {
  APP_NAME: 'AUTOMADRAWN_SUPPORT',

  // Leave empty to deliver to the Google account that owns this script,
  // so your address never appears anywhere in code.
  TO_ADDRESS: '',

  // Optional: ID of a Google Sheet to log submissions (the long ID in its URL).
  SHEET_ID: '',

  MIN_FILL_MS: 3000,          // submissions faster than this are treated as bots
  PER_EMAIL_COOLDOWN_S: 120,  // one message per sender every 2 minutes
  GLOBAL_HOURLY_CAP: 30,      // hard ceiling, protects your daily mail quota

  // Must match the <option> values in support.html exactly.
  CATEGORIES: ['Bug report', 'Feature request', 'Purchase / billing', 'Other'],

  MAX: { name: 100, email: 254, appVersion: 32, osVersion: 32, subject: 150, message: 5000 },
};

function doGet() {
  return ContentService.createTextOutput('Support endpoint is running.');
}

function doPost(e) {
  try {
    const p = (e && e.parameter) || {};

    // --- Bot filters: fake success so bots learn nothing ---
    if (p.website) return json_({ ok: true });                       // honeypot filled
    const elapsed = Number(p.elapsedMs);
    if (!elapsed || elapsed < CONFIG.MIN_FILL_MS) return json_({ ok: true }); // too fast / direct POST

    // --- Normalize + validate ---
    const f = {
      name:       clean_(p.name, CONFIG.MAX.name),
      email:      clean_(p.email, CONFIG.MAX.email).toLowerCase(),
      category:   CONFIG.CATEGORIES.indexOf(p.category) >= 0 ? p.category : 'Other',
      appVersion: clean_(p.appVersion, CONFIG.MAX.appVersion),
      osVersion:  clean_(p.osVersion, CONFIG.MAX.osVersion),
      subject:    clean_(p.subject, CONFIG.MAX.subject),
      message:    clean_(p.message, CONFIG.MAX.message, true),
    };

    if (!isEmail_(f.email)) {
      return json_({ ok: false, error: 'Please enter a valid email address so we can reply.' });
    }
    if (f.message.length < 10) {
      return json_({ ok: false, error: 'Please add a bit more detail to your message.' });
    }

    // --- Rate limits ---
    const cache = CacheService.getScriptCache();
    const senderKey = 'e:' + hash_(f.email);
    if (cache.get(senderKey)) {
      return json_({ ok: false, error: 'You just sent a message. Please wait a couple of minutes before sending another.' });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      const hourKey = 'h:' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
      const count = Number(cache.get(hourKey) || 0);
      if (count >= CONFIG.GLOBAL_HOURLY_CAP) {
        return json_({ ok: false, error: 'Support is receiving a lot of messages right now. Please try again in a little while.' });
      }
      cache.put(hourKey, String(count + 1), 3600);
    } finally {
      lock.releaseLock();
    }

    if (MailApp.getRemainingDailyQuota() < 1) {
      return json_({ ok: false, error: 'Support is temporarily unavailable. Please try again tomorrow.' });
    }

    // --- Send ---
    const to = CONFIG.TO_ADDRESS || Session.getEffectiveUser().getEmail();
    const summary = f.subject || f.message.replace(/\s+/g, ' ').slice(0, 60);

    const body = [
      'From:     ' + (f.name || '(no name)') + ' <' + f.email + '>',
      'Category: ' + f.category,
      'App:      ' + (f.appVersion || '-'),
      'macOS:    ' + (f.osVersion || '-'),
      'Subject:  ' + (f.subject || '-'),
      '',
      f.message,
      '',
      '---',
      'Sent via the ' + CONFIG.APP_NAME + ' support form. Reply to answer the sender directly.',
    ].join('\n');

    MailApp.sendEmail({
      to: to,
      replyTo: f.email,
      name: CONFIG.APP_NAME + ' Support Form',
      subject: '[' + CONFIG.APP_NAME + ' Support] ' + f.category + ': ' + summary,
      body: body,
    });

    cache.put(senderKey, '1', CONFIG.PER_EMAIL_COOLDOWN_S);

    // Logging is best-effort; never fail the request after the email went out.
    if (CONFIG.SHEET_ID) {
      try { logToSheet_(f); } catch (err) { console.error('Sheet log failed', err); }
    }

    return json_({ ok: true });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Something went wrong on our end. Please try again later.' });
  }
}

// ---------- helpers ----------

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function clean_(v, max, multiline) {
  let s = String(v == null ? '' : v);
  s = multiline
    ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    : s.replace(/[\u0000-\u001F\u007F]+/g, ' ');
  return s.trim().slice(0, max);
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s);
  return Utilities.base64EncodeWebSafe(bytes);
}

function logToSheet_(f) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Timestamp', 'Name', 'Email', 'Category', 'App version', 'macOS', 'Subject', 'Message']);
  }
  // Prefix values that would be interpreted as formulas.
  const safe = function (v) { return /^[=+\-@]/.test(v) ? "'" + v : v; };
  sheet.appendRow([new Date(), f.name, f.email, f.category, f.appVersion, f.osVersion, f.subject, f.message].map(
    function (v) { return typeof v === 'string' ? safe(v) : v; }
  ));
}

/** Run once from the editor to trigger the authorization prompt and send yourself a test. */
function testSend() {
  const res = doPost({ parameter: {
    name: 'Test User', email: 'test@example.com', category: 'Bug report',
    appVersion: '1.0 (1)', osVersion: '15.1', subject: 'Test submission',
    message: 'This is a test message from testSend().', elapsedMs: '5000',
  }});
  console.log(res.getContent());
}
