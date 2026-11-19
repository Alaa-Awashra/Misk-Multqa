// الإشعارات الداخلية (تظهر في لوحة المستخدم دائمًا) + البريد (اختياري وإن كان مُعدًّا)
import { enqueueEmail } from './email/outbox.js';

/**
 * يرسل إشعارًا لمستخدم واحد.
 *   n: { type, title, body, link, data, dedupeKey }
 *   email: { template, data } — يُرسل فقط إلى بريد موثّق (تم تأكيد ملكيته)
 * يعيد true إن أُنشئ إشعار جديد (false عند التكرار بنفس dedupeKey).
 */
export async function notifyUser(db, userId, n, email = null) {
  const r = await db.query(
    `insert into notifications (user_id, type, title, body, link, data, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [userId, n.type, n.title, n.body ?? null, n.link ?? null, JSON.stringify(n.data || {}), n.dedupeKey ?? null]
  );
  const created = r.rowCount > 0;
  if (email && created) {
    const { rows } = await db.query(
      'select email, email_verified_at, full_name from users where id = $1',
      [userId]
    );
    const u = rows[0];
    if (u?.email && u.email_verified_at) {
      await enqueueEmail(db, {
        to: u.email,
        userId,
        template: email.template,
        data: { name: u.full_name, ...email.data },
        dedupeKey: `${email.template}:${n.dedupeKey || `n${r.rows[0].id}`}:${userId}`,
      });
    }
  }
  return created;
}

/** معرّفات حسابات الإدارة (المسؤول) */
export async function adminUserIds(db) {
  const { rows } = await db.query(`select id from users where role = 'admin' and is_active`);
  return rows.map((r) => r.id);
}

export async function notifyAdmins(db, n, email = null) {
  for (const id of await adminUserIds(db)) await notifyUser(db, id, n, email);
}
