// طلبات حذف/فصل الطلاب: المشرف يطلب ← المسؤول يوافق أو يرفض ← المشرف يُشعَر بالقرار
import { Router } from 'express';
import { query, tx } from '../db.js';
import { allowRoles, requireAdmin, requireSupervisor } from '../middleware/auth.js';
import { notFound, conflict, uuidParam } from '../utils/errors.js';
import { parse, z, optText } from '../utils/validate.js';
import { logActivity } from '../services/activity.js';
import { notifyUser } from '../services/notify.js';
import { getStudent, removeStudent, suspendStudent } from '../services/students.js';

const router = Router();
router.param('id', uuidParam);
router.use(allowRoles('admin', 'supervisor'));

const SELECT = `
  select r.*, s.full_name as student_name, s.status as student_status, s.gender as student_gender,
         u.full_name as supervisor_name
  from student_requests r
  join students s on s.id = r.student_id
  left join supervisors sp on sp.id = r.supervisor_id
  left join users u on u.id = sp.user_id`;

router.get('/', async (req, res) => {
  const params = [];
  const where = [];
  if (req.user.role === 'supervisor') {
    params.push(req.user.supervisor_id);
    where.push(`r.supervisor_id = $${params.length}`);
  }
  if (['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`r.status = $${params.length}`);
  }
  const { rows } = await query(
    `${SELECT} ${where.length ? `where ${where.join(' and ')}` : ''}
     order by (r.status = 'pending') desc, r.created_at desc limit 500`,
    params
  );
  const counts = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  res.json({ requests: rows, counts });
});

async function lockPending(c, id) {
  const { rows } = await c.query(`${SELECT} where r.id = $1 for update of r`, [id]);
  const r = rows[0];
  if (!r) throw notFound('الطلب غير موجود');
  if (r.status !== 'pending') throw conflict('تم البت في هذا الطلب مسبقًا');
  return r;
}

const KIND = { removal: 'حذف', dismissal: 'فصل' };

router.post('/:id/approve', requireAdmin, async (req, res) => {
  const { note } = parse(z.object({ note: optText('الملاحظة', 1000) }), req.body);
  await tx(async (c) => {
    const r = await lockPending(c, req.params.id);
    const st = await getStudent(r.student_id);
    const reason = `${r.reason}${note ? ` — ${note}` : ''} (بطلب من ${r.requested_by_name || 'المشرف'})`;
    if (r.kind === 'removal') {
      if (st.status !== 'removed') await removeStudent(c, req.user, st, reason);
    } else if (st.status === 'active') {
      await suspendStudent(c, req.user, st, reason);
    }
    await c.query(
      `update student_requests set status = 'approved', decided_by = $1, decided_by_name = $2, decided_at = now(),
              decision_note = $3 where id = $4`,
      [req.user.id, req.user.full_name, note ?? null, r.id]
    );
    await logActivity(c, req.user, 'student.request_approved', 'student', r.student_id, r.student_name, { kind: r.kind, note });
    if (r.requested_by) {
      await notifyUser(c, r.requested_by, {
        type: 'student_request_decision',
        title: `تمت الموافقة على طلب ${KIND[r.kind]} ${r.student_name}`,
        body: note || null,
        link: '/requests',
        dedupeKey: `student_request_decision:${r.id}`,
      });
    }
  });
  res.json({ ok: true });
});

router.post('/:id/reject', requireAdmin, async (req, res) => {
  const { note } = parse(z.object({ note: optText('سبب الرفض', 1000) }), req.body);
  await tx(async (c) => {
    const r = await lockPending(c, req.params.id);
    await c.query(
      `update student_requests set status = 'rejected', decided_by = $1, decided_by_name = $2, decided_at = now(),
              decision_note = $3 where id = $4`,
      [req.user.id, req.user.full_name, note ?? null, r.id]
    );
    await logActivity(c, req.user, 'student.request_rejected', 'student', r.student_id, r.student_name, { kind: r.kind, note });
    if (r.requested_by) {
      await notifyUser(c, r.requested_by, {
        type: 'student_request_decision',
        title: `رُفض طلب ${KIND[r.kind]} ${r.student_name}`,
        body: note || null,
        link: '/requests',
        dedupeKey: `student_request_decision:${r.id}`,
      });
    }
  });
  res.json({ ok: true });
});

router.post('/:id/cancel', requireSupervisor, async (req, res) => {
  await tx(async (c) => {
    const r = await lockPending(c, req.params.id);
    if (r.supervisor_id !== req.user.supervisor_id) throw notFound('الطلب غير موجود');
    await c.query(`update student_requests set status = 'cancelled', decided_at = now() where id = $1`, [r.id]);
    await logActivity(c, req.user, 'student.request_cancelled', 'student', r.student_id, r.student_name, { kind: r.kind });
  });
  res.json({ ok: true });
});

export default router;
