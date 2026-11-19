// نظام التحذيرات الرسمية للمشرفين والإيقاف التلقائي
//   التحذير الأول: إشعار + بريد
//   بلوغ الحد (افتراضيًا تحذيران ساريان): إيقاف صلاحيات المشرف وإشعار المشرف والإدارة
import { getSettings } from './settings.js';
import { logActivity } from './activity.js';
import { notifyUser, notifyAdmins } from './notify.js';
import { notFound, conflict } from '../utils/errors.js';

async function lockSupervisor(c, supervisorId) {
  const { rows } = await c.query(
    `select sp.id, sp.user_id, sp.status, u.full_name from supervisors sp join users u on u.id = sp.user_id
     where sp.id = $1 for update of sp`,
    [supervisorId]
  );
  if (!rows[0]) throw notFound('المشرف غير موجود');
  return rows[0];
}

export async function activeWarningCount(c, supervisorId) {
  const { rows } = await c.query(
    `select count(*)::int as n from supervisor_warnings where supervisor_id = $1 and status = 'active'`,
    [supervisorId]
  );
  return rows[0].n;
}

/**
 * يصدر تحذيرًا رسميًا (يجب أن يُستدعى داخل transaction).
 * actor: المستخدم المُصدِر، أو null للنظام (المتابعة الآلية)
 * يعيد { warning, active, dismissed }
 */
export async function issueWarning(c, actor, supervisorId, { reason, notes = null, source = 'manual', reviewId = null }) {
  const sup = await lockSupervisor(c, supervisorId);
  if (sup.status !== 'active') throw conflict('المشرف موقوف بالفعل');
  const settings = await getSettings();
  const threshold = Math.max(1, Number(settings.supervisor_dismissal_warnings) || 2);
  const issuerName = actor?.full_name || 'النظام (المتابعة الآلية)';

  const { rows } = await c.query(
    `insert into supervisor_warnings (supervisor_id, supervisor_name, reason, notes, source, issued_by, issued_by_name, review_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [sup.id, sup.full_name, reason, notes, source, actor?.id ?? null, issuerName, reviewId]
  );
  const warning = rows[0];
  const active = await activeWarningCount(c, sup.id);

  await logActivity(c, actor, 'supervisor.warning', 'supervisor', sup.id, sup.full_name, {
    reason,
    source,
    warning_id: warning.id,
    active_warnings: active,
  });

  await notifyUser(
    c,
    sup.user_id,
    {
      type: 'supervisor_warning',
      title: `تحذير إداري رسمي (${active} من ${threshold})`,
      body: reason,
      link: '/my-record',
      data: { warning_id: warning.id },
      dedupeKey: `warning:${warning.id}`,
    },
    {
      template: 'supervisor_warning',
      data: { reason, notes, date: warning.created_at, issuer: issuerName, number: active, active, threshold },
    }
  );

  let dismissed = false;
  if (active >= threshold) {
    await dismissByPolicy(c, actor, sup, { reason, threshold });
    dismissed = true;
  }
  return { warning, active, dismissed, threshold };
}

async function dismissByPolicy(c, actor, sup, { reason, threshold }) {
  await c.query(
    `update supervisors set status = 'suspended', suspended_at = now(), dismissed_by_policy = true,
            suspension_reason = $1 where id = $2`,
    [`إيقاف تلقائي بعد بلوغ ${threshold} تحذيرات رسمية سارية`, sup.id]
  );
  const { rowCount: cancelled } = await c.query(
    `update appointments set status = 'cancelled' where supervisor_id = $1 and status = 'scheduled' and start_at > now()`,
    [sup.id]
  );
  await logActivity(c, actor, 'supervisor.auto_dismiss', 'supervisor', sup.id, sup.full_name, {
    reason: `بلوغ ${threshold} تحذيرات سارية`,
    cancelled_appointments: cancelled,
  });
  const now = new Date().toISOString();
  await notifyUser(
    c,
    sup.user_id,
    {
      type: 'supervisor_dismissed',
      title: 'تم إيقاف صلاحياتك الإشرافية',
      body: `بسبب بلوغ ${threshold} تحذيرات رسمية سارية.`,
      dedupeKey: `dismissed:${sup.id}:${now.slice(0, 16)}`,
    },
    { template: 'supervisor_dismissal', data: { threshold, reason, date: now } }
  );
  await notifyAdmins(
    c,
    {
      type: 'supervisor_dismissed',
      title: `إيقاف المشرف ${sup.full_name} تلقائيًا`,
      body: `بلغ ${threshold} تحذيرات رسمية سارية. يمكن نقل طلابه إلى مشرف آخر.`,
      link: `/supervisors/${sup.id}`,
      dedupeKey: `dismissed:${sup.id}:${now.slice(0, 16)}`,
    },
    { template: 'admin_supervisor_dismissed', data: { supervisor: sup.full_name, threshold, reason, date: now, url: `/supervisors/${sup.id}` } }
  );
}

/** إلغاء تحذير صدر بالخطأ. لا يُعيد تفعيل المشرف تلقائيًا — القرار للمسؤول. */
export async function revokeWarning(c, actor, warningId, revokeReason) {
  const { rows } = await c.query(`select * from supervisor_warnings where id = $1 for update`, [warningId]);
  const w = rows[0];
  if (!w) throw notFound('التحذير غير موجود');
  if (w.status !== 'active') throw conflict('التحذير ملغى مسبقًا');
  await c.query(
    `update supervisor_warnings set status = 'revoked', revoked_by = $1, revoked_by_name = $2, revoked_at = now(),
            revoke_reason = $3 where id = $4`,
    [actor.id, actor.full_name, revokeReason, w.id]
  );
  await logActivity(c, actor, 'supervisor.warning_revoked', 'supervisor', w.supervisor_id, w.supervisor_name, {
    reason: revokeReason,
    warning_id: w.id,
  });
  if (w.supervisor_id) {
    const { rows: s } = await c.query('select user_id from supervisors where id = $1', [w.supervisor_id]);
    if (s[0]) {
      await notifyUser(c, s[0].user_id, {
        type: 'warning_revoked',
        title: 'تم إلغاء تحذير إداري',
        body: `أُلغي التحذير: «${w.reason}»${revokeReason ? ` — ${revokeReason}` : ''}`,
        link: '/my-record',
        dedupeKey: `warning_revoked:${w.id}`,
      });
    }
  }
  const active = w.supervisor_id ? await activeWarningCount(c, w.supervisor_id) : 0;
  return { active };
}
