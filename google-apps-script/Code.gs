/**
 * =====================================================================
 *  ملتقى المسك القرآني — خدمة إرسال البريد عبر Google Apps Script
 *  Misk Quran Forum — Email relay (MailApp) — Code.gs
 * =====================================================================
 *
 * يُنشر هذا الملف كـ Web App من حساب الملتقى الرسمي misk.quran26@gmail.com
 * (Execute as: Me) فتُرسل الرسائل من هذا الحساب نفسه عبر MailApp.sendEmail().
 *
 * الأمان (الرابط عام لأن خادم Render لا يستطيع تسجيل الدخول بحساب Google):
 *   - كل طلب يجب أن يحمل توقيع HMAC-SHA256 بالسر المشترك GAS_SHARED_SECRET
 *     المحفوظ في Script Properties هنا وفي متغيرات Render هناك — ولا يُرسل السر نفسه أبدًا.
 *   - الطلب صالح 5 دقائق فقط (ts)، وكل nonce يُقبل مرة واحدة (منع إعادة الإرسال Replay).
 *   - مفتاح منع التكرار id: نفس الرسالة لا تُرسل مرتين خلال 6 ساعات حتى لو أعاد الخادم المحاولة.
 *   - مستلم واحد في كل طلب، وفحص الحصة اليومية MailApp.getRemainingDailyQuota() قبل كل إرسال.
 *   - لا يُسجَّل محتوى الرسائل؛ فقط معرّف الرسالة ونتيجتها.
 *
 * صيغة الطلب (POST، النص JSON):
 *   { "payload": "<base64 لنص JSON بترميز UTF-8>", "sig": "<hex HMAC-SHA256(payload, secret)>" }
 * محتوى payload بعد فك الترميز:
 *   { "v":1, "action":"send"|"status", "ts":<ثوانٍ Unix>, "nonce":"...",
 *     "id":"...", "to":"...", "subject":"...", "html":"...", "text":"...", "name":"...", "replyTo":"..." }
 * الرد دائمًا JSON: { "ok":true, ... } أو { "ok":false, "code":"AUTH|EXPIRED|REPLAY|INVALID|QUOTA|CONFIG|INTERNAL", "error":"..." }
 *
 * لا تعدّل هذا الملف إلا عند الحاجة؛ يجب أن يبقى متوافقًا مع
 * server/src/services/email/appsScript.js في المشروع.
 */

var VERSION = 1;
var MAX_SKEW_SECONDS = 300;          // صلاحية الطلب: 5 دقائق
var NONCE_TTL_SECONDS = 900;         // تذكّر nonce لمدة 15 دقيقة
var DEDUPE_TTL_SECONDS = 21600;      // تذكّر الرسائل المرسلة 6 ساعات (أقصى مدة لـ CacheService)
var MIN_SECRET_LENGTH = 32;
var MAX_SUBJECT = 250;
var MAX_BODY = 190000;               // حد حجم الرسالة (MailApp يرفض ما يقارب 200KB)
var EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** طلب GET (فتح الرابط في المتصفح): لا يكشف أي معلومة */
function doGet() {
  return json_({ ok: true, service: 'misk-mail', v: VERSION });
}

/** نقطة الدخول للخادم */
function doPost(e) {
  try {
    var secret = PropertiesService.getScriptProperties().getProperty('GAS_SHARED_SECRET');
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      return fail_('CONFIG', 'GAS_SHARED_SECRET is not configured in Script Properties (min 32 chars)');
    }

    var body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '');
    } catch (err) {
      return fail_('INVALID', 'Body must be JSON');
    }
    if (!body || typeof body.payload !== 'string' || typeof body.sig !== 'string' || body.payload.length > 400000) {
      return fail_('INVALID', 'Missing payload or signature');
    }

    // 1) التحقق من التوقيع قبل أي شيء آخر
    var expected = hex_(Utilities.computeHmacSha256Signature(body.payload, secret));
    if (!safeEqual_(expected, body.sig.toLowerCase())) {
      return fail_('AUTH', 'Invalid signature');
    }

    var p;
    try {
      p = JSON.parse(Utilities.newBlob(Utilities.base64Decode(body.payload)).getDataAsString('UTF-8'));
    } catch (err2) {
      return fail_('INVALID', 'Payload is not valid base64 JSON');
    }

    // 2) الصلاحية الزمنية ومنع إعادة الإرسال
    var now = Math.floor(Date.now() / 1000);
    if (typeof p.ts !== 'number' || Math.abs(now - p.ts) > MAX_SKEW_SECONDS) {
      return fail_('EXPIRED', 'Request timestamp expired or clock skew too large');
    }
    if (typeof p.nonce !== 'string' || p.nonce.length < 16 || p.nonce.length > 100) {
      return fail_('INVALID', 'Invalid nonce');
    }
    var cache = CacheService.getScriptCache();
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      if (cache.get('n:' + p.nonce)) return fail_('REPLAY', 'Nonce already used');
      cache.put('n:' + p.nonce, '1', NONCE_TTL_SECONDS);

      if (p.action === 'status') return statusResponse_();
      if (p.action === 'send') return send_(p, cache);
      return fail_('INVALID', 'Unknown action');
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error('misk-mail internal error: ' + (err && err.message));
    return fail_('INTERNAL', String((err && err.message) || err).slice(0, 300));
  }
}

function statusResponse_() {
  return json_({
    ok: true,
    v: VERSION,
    account: Session.getEffectiveUser().getEmail(),
    remaining: MailApp.getRemainingDailyQuota(),
  });
}

function send_(p, cache) {
  // التحقق من الحقول
  if (typeof p.id !== 'string' || !p.id || p.id.length > 200) return fail_('INVALID', 'Invalid id');
  if (typeof p.to !== 'string' || !EMAIL_RE.test(p.to) || p.to.length > 254) return fail_('INVALID', 'Invalid recipient');
  if (typeof p.subject !== 'string' || !p.subject || p.subject.length > MAX_SUBJECT) return fail_('INVALID', 'Invalid subject');
  if (typeof p.text !== 'string' || !p.text) return fail_('INVALID', 'Missing text body');
  if ((p.html || '').length + p.text.length > MAX_BODY) return fail_('INVALID', 'Message too large');
  if (p.replyTo && (typeof p.replyTo !== 'string' || !EMAIL_RE.test(p.replyTo))) return fail_('INVALID', 'Invalid replyTo');

  // منع التكرار: نفس المعرّف أُرسل مسبقًا → نجاح بدون إرسال جديد
  var dedupeKey = 'id:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p.id));
  var prior = cache.get(dedupeKey);
  if (prior) return json_({ ok: true, duplicate: true, id: prior, remaining: MailApp.getRemainingDailyQuota() });

  // الحصة اليومية (100 مستلم يوميًا لحساب Gmail الشخصي)
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining < 1) return fail_('QUOTA', 'Daily MailApp quota exhausted', { remaining: remaining });

  var options = {
    to: p.to,
    subject: p.subject,
    body: p.text,
    name: typeof p.name === 'string' && p.name ? p.name.slice(0, 100) : 'Misk Quran Forum',
  };
  if (p.html) options.htmlBody = p.html;
  if (p.replyTo) options.replyTo = p.replyTo;

  MailApp.sendEmail(options);

  var messageId = 'gas-' + Utilities.getUuid();
  cache.put(dedupeKey, messageId, DEDUPE_TTL_SECONDS);
  console.log('misk-mail sent ' + messageId); // بدون عنوان المستلم أو المحتوى
  return json_({ ok: true, id: messageId, remaining: MailApp.getRemainingDailyQuota() });
}

// ------------------------------------------------------------------ أدوات

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message, extra) {
  var o = { ok: false, code: code, error: message };
  if (extra) for (var k in extra) o[k] = extra[k];
  return json_(o);
}

/** مصفوفة بايتات Apps Script (قيم موقّعة -128..127) → hex */
function hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

/** مقارنة بزمن ثابت */
function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * للتجربة من محرر Apps Script فقط (Run ← testQuota):
 * يمنح صلاحية MailApp عند أول تشغيل ويعرض الحصة المتبقية. لا يرسل أي رسالة.
 */
function testQuota() {
  console.log('Account: ' + Session.getEffectiveUser().getEmail());
  console.log('Remaining daily quota: ' + MailApp.getRemainingDailyQuota());
  var s = PropertiesService.getScriptProperties().getProperty('GAS_SHARED_SECRET');
  console.log('GAS_SHARED_SECRET configured: ' + (!!s && s.length >= MIN_SECRET_LENGTH));
}
