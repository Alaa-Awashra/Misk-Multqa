// صندوق البريد الصادر: الرسائل تُحفظ أولًا في قاعدة البيانات (داخل نفس transaction الإجراء الإداري)
// ثم تُرسل في الخلفية. فشل الإرسال لا يُلغي الإجراء الإداري أبدًا.
import { pool } from '../../db.js';
import { renderEmail } from './templates.js';
import { emailConfigStatus, sendViaResend } from './resend.js';

const MAX_ATTEMPTS = 6;
const SEND_SPACING_MS = 600; // احترام حد Resend (طلبان في الثانية على الخطة المجانية)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// قابل للاستبدال في الاختبارات
let transport = sendViaResend;
let statusFn = emailConfigStatus;
export const __setEmailTransport = (fn, status) => {
  transport = fn || sendViaResend;
  statusFn = status || emailConfigStatus;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * يضيف رسالة إلى الصندوق. dedupeKey فريد: نفس المفتاح = لا رسالة ثانية.
 * db: client داخل transaction أو pool
 * يعيد true إن أضيفت رسالة جديدة.
 */
export async function enqueueEmail(db, { to, userId = null, template, data, dedupeKey }) {
  if (!to || !EMAIL_RE.test(to)) return false;
  const { subject, html, text } = renderEmail(template, data);
  const st = statusFn();
  const r = await db.query(
    `insert into email_outbox (dedupe_key, to_email, to_user_id, template, subject, html, text_body, status, last_error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (dedupe_key) do nothing`,
    [
      dedupeKey,
      to.trim().toLowerCase(),
      userId,
      template,
      subject,
      html,
      text,
      st.operational ? 'pending' : 'disabled',
      st.operational ? null : `البريد غير مُعدّ: ${st.problems.join(' • ')}`,
    ]
  );
  if (r.rowCount && st.operational) kickOutbox();
  return r.rowCount > 0;
}

let running = null;
let rerun = false;

/** يبدأ المعالجة في الخلفية (بعد انتهاء الطلب الحالي) دون انتظار */
export function kickOutbox() {
  if (running) {
    rerun = true;
    return;
  }
  setTimeout(() => {
    processOutbox().catch((e) => console.error('خطأ في معالجة البريد:', e.message));
  }, 250).unref?.();
}

const backoff = (attempts) => Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));

/** يرسل الرسائل المستحقة. آمن للتشغيل المتزامن (FOR UPDATE SKIP LOCKED). */
export async function processOutbox({ limit = 50 } = {}) {
  if (running) return running;
  running = (async () => {
    const stats = { sent: 0, failed: 0, retried: 0 };
    if (!statusFn().operational) return { ...stats, skipped: 'not_configured' };

    // رسائل علِقت في حالة "sending" (توقف الخادم أثناء الإرسال) تعود للانتظار
    await pool.query(
      `update email_outbox set status = 'pending', updated_at = now()
       where status = 'sending' and updated_at < now() - interval '10 minutes'`
    );

    const { rows } = await pool.query(
      `update email_outbox set status = 'sending', attempts = attempts + 1, updated_at = now()
       where id in (select id from email_outbox where status = 'pending' and next_attempt_at <= now()
                    order by id limit $1 for update skip locked)
       returning id, dedupe_key, to_email, subject, html, text_body, attempts, template`,
      [limit]
    );

    let i = 0;
    for (; i < rows.length; i++) {
      const m = rows[i];
      try {
        const r = await transport({
          to: m.to_email,
          subject: m.subject,
          html: m.html,
          text: m.text_body,
          idempotencyKey: `mq-${m.dedupe_key}`,
        });
        // رسائل التحقق تحتوي رمزًا سريًا — لا نُبقي نصها بعد الإرسال
        const redact = m.template === 'verify_email';
        await pool.query(
          `update email_outbox set status = 'sent', sent_at = now(), provider_message_id = $2, last_error = null,
                  html = case when $3 then null else html end, text_body = case when $3 then null else text_body end,
                  updated_at = now() where id = $1`,
          [m.id, r?.id || null, redact]
        );
        stats.sent++;
      } catch (err) {
        const final = !err.retryable || m.attempts >= MAX_ATTEMPTS;
        const delay = err.retryAfterMs || backoff(m.attempts);
        await pool.query(
          `update email_outbox set status = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval,
                  updated_at = now() where id = $1`,
          [m.id, final ? 'failed' : 'pending', String(err.message).slice(0, 500), String(delay)]
        );
        if (final) stats.failed++;
        else stats.retried++;
        if (err.status === 429) {
          i++;
          break; // أوقف الدفعة واحترم المهلة
        }
      }
      await sleep(SEND_SPACING_MS);
    }
    // رسائل حُجزت ولم تُرسل بسبب إيقاف الدفعة تعود للانتظار دون احتساب محاولة
    const untouched = rows.slice(i).map((m) => m.id);
    if (untouched.length) {
      await pool.query(
        `update email_outbox set status = 'pending', attempts = greatest(attempts - 1, 0), next_attempt_at = now() + interval '1 minute',
                updated_at = now() where id = any($1::bigint[]) and status = 'sending'`,
        [untouched]
      );
    }
    return stats;
  })();
  try {
    return await running;
  } finally {
    running = null;
    if (rerun) {
      rerun = false;
      kickOutbox();
    }
  }
}

/** ينتظر انتهاء أي معالجة جارية (للاختبارات والإيقاف) */
export const outboxIdle = async () => {
  while (running) await running.catch(() => {});
};
