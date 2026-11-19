// تأكيد ملكية البريد الإلكتروني عبر رابط برمز عشوائي (يُخزَّن هاشه فقط)
import crypto from 'node:crypto';
import { query, tx } from '../db.js';
import { enqueueEmail } from './email/outbox.js';
import { logActivity } from './activity.js';
import { badRequest, conflict } from '../utils/errors.js';

const TTL_HOURS = 48;
const RESEND_COOLDOWN_SEC = 60;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export const normalizeEmail = (e) => (e ? String(e).trim().toLowerCase() : null);

/** يتأكد أن البريد غير مستخدم في حساب آخر */
export async function assertEmailAvailable(db, email, exceptUserId = null) {
  if (!email) return;
  const { rowCount } = await db.query(
    `select 1 from users where lower(email) = lower($1) and id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')`,
    [email, exceptUserId]
  );
  if (rowCount) throw conflict('هذا البريد الإلكتروني مستخدم في حساب آخر', 'EMAIL_TAKEN');
}

/** يولّد رمزًا جديدًا ويضع رسالة التحقق في صندوق البريد. يعيد { queued } */
export async function startEmailVerification(db, userId) {
  const { rows } = await db.query(
    'select id, full_name, email, email_verified_at, email_verify_sent_at from users where id = $1',
    [userId]
  );
  const u = rows[0];
  if (!u?.email) throw badRequest('لا يوجد بريد إلكتروني لتأكيده');
  if (u.email_verified_at) return { already: true, queued: false };
  if (u.email_verify_sent_at && Date.now() - new Date(u.email_verify_sent_at).getTime() < RESEND_COOLDOWN_SEC * 1000) {
    throw conflict('أُرسل رابط التأكيد قبل قليل. انتظر دقيقة ثم أعد المحاولة.', 'COOLDOWN');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `update users set email_verify_token_hash = $1, email_verify_expires_at = now() + ($2 || ' hours')::interval,
            email_verify_sent_at = now() where id = $3`,
    [sha(token), String(TTL_HOURS), userId]
  );
  const queued = await enqueueEmail(db, {
    to: u.email,
    userId,
    template: 'verify_email',
    data: { name: u.full_name, url: `/verify-email?token=${token}` },
    dedupeKey: `verify:${userId}:${sha(token).slice(0, 16)}`,
  });
  return { queued, token };
}

/** يؤكد الرمز القادم من رابط البريد */
export async function confirmEmailToken(token) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `select id, full_name, role, email, email_verify_expires_at from users where email_verify_token_hash = $1 for update`,
      [sha(token)]
    );
    const u = rows[0];
    if (!u) throw badRequest('رابط التأكيد غير صالح أو مستخدم مسبقًا', 'BAD_TOKEN');
    if (new Date(u.email_verify_expires_at) < new Date()) throw badRequest('انتهت صلاحية رابط التأكيد. اطلب رابطًا جديدًا.', 'TOKEN_EXPIRED');
    await c.query(
      `update users set email_verified_at = now(), email_verify_token_hash = null, email_verify_expires_at = null where id = $1`,
      [u.id]
    );
    await logActivity(c, { id: u.id, full_name: u.full_name }, 'user.email_verified', u.role, u.id, u.full_name, { email: u.email });
    return { ok: true, email: u.email };
  });
}

/** يغيّر البريد ويُعيد حالة التحقق (يُستدعى داخل transaction) */
export async function setUserEmail(db, userId, email) {
  const e = normalizeEmail(email);
  const { rows } = await db.query('select email from users where id = $1', [userId]);
  if (normalizeEmail(rows[0]?.email) === e) return { changed: false };
  await assertEmailAvailable(db, e, userId);
  await db.query(
    `update users set email = $1, email_verified_at = null, email_verify_token_hash = null,
            email_verify_expires_at = null, email_verify_sent_at = null where id = $2`,
    [e, userId]
  );
  return { changed: true };
}

export async function getVerificationState(userId) {
  const { rows } = await query('select email, email_verified_at, email_verify_sent_at from users where id = $1', [userId]);
  return rows[0];
}
