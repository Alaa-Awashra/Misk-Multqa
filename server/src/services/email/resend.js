// عميل Resend عبر HTTPS (بدون SMTP وبدون كلمة مرور Gmail)
import { config } from '../../config.js';

const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|aol|proton(mail)?)\./i;

/** حالة إعداد البريد — تُعرض للمسؤول بوضوح بدل ادعاء أن الإرسال يعمل */
export function emailConfigStatus() {
  const e = config.email;
  const problems = [];
  if (!e.enabled) problems.push('EMAIL_NOTIFICATIONS_ENABLED غير مفعّل (ضعه true بعد إكمال الإعداد)');
  if (!e.resendApiKey) problems.push('RESEND_API_KEY غير مضبوط');
  if (!e.from) problems.push('EMAIL_FROM غير مضبوط (مثال: noreply@your-domain.com)');
  else if (FREE_MAIL.test(e.from))
    problems.push('EMAIL_FROM يجب أن يكون على نطاق موثّق في Resend — لا يمكن الإرسال من عنوان Gmail أو بريد مجاني');
  return {
    operational: problems.length === 0,
    enabled: e.enabled,
    has_api_key: !!e.resendApiKey,
    from: e.from || null,
    reply_to: e.replyTo,
    problems,
  };
}

export class EmailSendError extends Error {
  constructor(message, { retryable = false, retryAfterMs = null, status = null } = {}) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** يرسل رسالة واحدة. idempotencyKey يمنع التكرار عند إعادة المحاولة (يحفظه Resend 24 ساعة) */
export async function sendViaResend({ to, subject, html, text, idempotencyKey }) {
  const e = config.email;
  const fromHeader = `${e.fromName} <${e.from}>`;
  let res;
  try {
    res = await fetch(`${e.apiBase}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${e.resendApiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
      },
      body: JSON.stringify({ from: fromHeader, to: [to], subject, html, text, reply_to: e.replyTo }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new EmailSendError(`تعذر الاتصال بخدمة البريد: ${err.message}`, { retryable: true });
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { id: body.id || null };

  const msg = body?.message || body?.error || `HTTP ${res.status}`;
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new EmailSendError(`تجاوز حد الإرسال: ${msg}`, {
      retryable: true,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000,
      status: 429,
    });
  }
  // 409 = نفس مفتاح عدم التكرار قيد المعالجة/مُرسل → نعتبره مؤقتًا
  if (res.status >= 500 || res.status === 409) throw new EmailSendError(msg, { retryable: true, status: res.status });
  throw new EmailSendError(msg, { retryable: false, status: res.status });
}
