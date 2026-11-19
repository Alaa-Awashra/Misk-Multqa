// إرسال البريد عبر Google Apps Script Web App (MailApp) من حساب الملتقى الرسمي
//   - بلا SMTP وبلا App Passwords وبلا خدمة مدفوعة وبلا نطاق خاص
//   - مصادقة خادم-لخادم: توقيع HMAC-SHA256 بسر مشترك (GAS_SHARED_SECRET) + طابع زمني + nonce
//   - السر لا يُرسل أبدًا؛ يُرسل التوقيع فقط داخل نص الطلب (وليس في الرابط)
// الكود المقابل في: google-apps-script/Code.gs
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { EmailSendError } from './errors.js';

export { EmailSendError };

const PROVIDER = 'google_apps_script';
const GAS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const REQUEST_TIMEOUT_MS = 30_000;

/** حالة إعداد البريد — تُعرض للمسؤول بوضوح بدل ادعاء أن الإرسال يعمل */
export function emailConfigStatus() {
  const e = config.email;
  const problems = [];
  if (!e.enabled) problems.push('EMAIL_NOTIFICATIONS_ENABLED غير مفعّل (ضعه true بعد إكمال الإعداد)');
  if (e.provider !== PROVIDER) problems.push(`EMAIL_PROVIDER يجب أن يكون ${PROVIDER} (القيمة الحالية: ${e.provider || 'فارغ'})`);
  if (!e.gasUrl) problems.push('GAS_WEB_APP_URL غير مضبوط (رابط نشر Apps Script الذي ينتهي بـ /exec)');
  else if (!config.isTest && !GAS_URL_RE.test(e.gasUrl))
    problems.push('GAS_WEB_APP_URL غير صحيح — يجب أن يكون بالشكل https://script.google.com/macros/s/…/exec');
  if (!e.gasSecret) problems.push('GAS_SHARED_SECRET غير مضبوط');
  else if (e.gasSecret.length < 32) problems.push('GAS_SHARED_SECRET قصير — 32 حرفًا على الأقل');
  return {
    operational: problems.length === 0,
    provider: PROVIDER,
    enabled: e.enabled,
    has_url: !!e.gasUrl,
    has_secret: !!e.gasSecret,
    sender: e.senderAddress,
    sender_name: e.fromName,
    reply_to: e.replyTo,
    daily_limit: e.dailyLimit,
    send_interval_ms: e.sendIntervalMs,
    problems,
  };
}

/** يبني جسم الطلب الموقّع. ts بالثواني، nonce عشوائي فريد */
export function signRequest(fields, secret = config.email.gasSecret, now = Date.now()) {
  const payloadObj = { v: 1, ts: Math.floor(now / 1000), nonce: crypto.randomBytes(18).toString('hex'), ...fields };
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { payload, sig };
}

let fetchImpl = (...a) => fetch(...a);
export const __setAppsScriptFetch = (fn) => {
  fetchImpl = fn || ((...a) => fetch(...a));
};

/** يستدعي الـ Web App ويعيد JSON الرد (أو يرمي EmailSendError) */
async function call(fields) {
  const e = config.email;
  let res;
  try {
    res = await fetchImpl(e.gasUrl, {
      method: 'POST',
      // text/plain يتجنب أي preflight ويقرؤه Apps Script من e.postData.contents
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(signRequest(fields)),
      redirect: 'follow', // Apps Script يرد بتحويلة 302 إلى script.googleusercontent.com تحمل النتيجة
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // مهلة/شبكة: قد تكون الرسالة أُرسلت — إعادة المحاولة آمنة لأن Apps Script يمنع تكرار نفس المعرّف 6 ساعات
    throw new EmailSendError(`تعذر الاتصال بخدمة Apps Script: ${err.message}`, { retryable: true, code: 'NETWORK' });
  }
  const raw = await res.text().catch(() => '');
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* ليس JSON */
  }
  if (!body || typeof body !== 'object') {
    const hint =
      res.status === 401 || res.status === 403 || /accounts\.google\.com|ServiceLogin/i.test(raw)
        ? 'يبدو أن الوصول للـ Web App ليس «Anyone» — أعد النشر مع Who has access: Anyone'
        : res.status === 404
          ? 'الرابط غير موجود — تأكد من GAS_WEB_APP_URL ومن أن النشر ما زال فعّالًا'
          : 'رد غير متوقع من Apps Script — تأكد من نسخ Code.gs كاملًا ومن نشر إصدار جديد';
    throw new EmailSendError(`${hint} (HTTP ${res.status})`, { retryable: res.status >= 500 || res.status === 429, status: res.status, code: 'BAD_RESPONSE' });
  }
  return body;
}

/** يرسل رسالة واحدة لمستلم واحد. idempotencyKey يمنع التكرار عند إعادة المحاولة */
export async function sendViaAppsScript({ to, subject, html, text, idempotencyKey }) {
  const e = config.email;
  const body = await call({
    action: 'send',
    id: String(idempotencyKey || crypto.randomUUID()).slice(0, 200),
    to,
    subject,
    html,
    text,
    name: e.fromName,
    replyTo: e.replyTo,
  });
  if (body.ok) return { id: body.id || null, duplicate: !!body.duplicate, remaining: body.remaining ?? null };
  throw errorFromBody(body);
}

/** فحص الاتصال: يعيد الحساب المُرسِل والحصة اليومية المتبقية (بدون إرسال أي رسالة) */
export async function checkAppsScript() {
  const body = await call({ action: 'status' });
  if (!body.ok) throw errorFromBody(body);
  return { account: body.account || null, remaining: body.remaining ?? null, version: body.v ?? null };
}

function errorFromBody(body) {
  const code = String(body.code || 'UNKNOWN');
  const msg = String(body.error || 'خطأ غير معروف').slice(0, 300);
  switch (code) {
    case 'QUOTA':
      // نفدت حصة اليوم: نعيد المحاولة بعد ساعة (الحصة تتجدد تدريجيًا خلال 24 ساعة)
      return new EmailSendError('نفدت حصة الإرسال اليومية لحساب Gmail (MailApp) — ستُرسل الرسالة تلقائيًا لاحقًا', {
        retryable: true, retryAfterMs: 3600_000, status: 429, code,
      });
    case 'EXPIRED':
    case 'REPLAY':
      // غالبًا فرق توقيت لحظي أو إعادة إرسال شبكة — طلب جديد بتوقيع جديد يكفي
      return new EmailSendError(`رفض Apps Script الطلب (${code}): ${msg}`, { retryable: true, retryAfterMs: 60_000, code });
    case 'INTERNAL':
      return new EmailSendError(`خطأ داخلي في Apps Script: ${msg}`, { retryable: true, code });
    case 'AUTH':
      return new EmailSendError('رفض Apps Script التوقيع — GAS_SHARED_SECRET في Render لا يطابق Script Properties', { retryable: false, code });
    case 'CONFIG':
      return new EmailSendError('GAS_SHARED_SECRET غير مضبوط في Script Properties داخل مشروع Apps Script', { retryable: false, code });
    default:
      return new EmailSendError(`رفض Apps Script الرسالة (${code}): ${msg}`, { retryable: false, code });
  }
}
