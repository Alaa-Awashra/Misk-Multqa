import { Router } from 'express';
import { query, tx } from '../db.js';
import { requireAdmin, requireSupervisor, allowRoles } from '../middleware/auth.js';
import { notFound, conflict, badRequest, forbidden, uuidParam, isUuid } from '../utils/errors.js';
import { parse, z, reqText, optText, optDate, optPhone } from '../utils/validate.js';
import { logActivity } from '../services/activity.js';
import { listStudents, getStudent, genderAllowed, createStudent, removeStudent, suspendStudent } from '../services/students.js';
import { notifyAdmins } from '../services/notify.js';

const router = Router();
router.param('id', uuidParam);
// مشرف التسجيل لا يصل إلى سجلات الطلاب
router.use(allowRoles('admin', 'supervisor'));

const isAdmin = (req) => req.user.role === 'admin';

/** يحمّل الطالب ويتأكد أن المشرف يملك صلاحية عليه */
async function loadStudentFor(req, id) {
  const st = await getStudent(id);
  if (!st) throw notFound('الطالب غير موجود');
  if (!isAdmin(req) && (st.supervisor_id !== req.user.supervisor_id || st.status === 'removed')) throw notFound('الطالب غير موجود');
  return st;
}

const studentShape = {
  full_name: reqText('اسم الطالب', 150),
  gender: z.enum(['male', 'female'], { errorMap: () => ({ message: 'اختر الجنس' }) }).optional(),
  birth_date: optDate,
  phone: optPhone,
  guardian_name: optText('اسم ولي الأمر', 150),
  guardian_phone: optPhone,
  address: optText('العنوان', 300),
  join_date: optDate,
  initial_parts: z.coerce
    .number({ invalid_type_error: 'المحفوظ عند الانضمام غير صالح' })
    .min(0, 'المحفوظ لا يمكن أن يكون سالبًا')
    .max(30, 'الحد الأقصى 30 جزءًا')
    .default(0),
  notes: optText('الملاحظات', 1000),
};

router.get('/', async (req, res) => {
  let supervisorId = null;
  if (isAdmin(req)) {
    if (req.query.supervisor_id === 'none') supervisorId = 'none';
    else if (isUuid(req.query.supervisor_id)) supervisorId = req.query.supervisor_id;
  } else {
    supervisorId = req.user.supervisor_id;
  }
  const includeRemoved = isAdmin(req) && req.query.include_removed === 'true';
  const students = await listStudents({ supervisorId, includeRemoved });
  if (isAdmin(req)) return res.json({ students });
  // الطلبات المعلقة لطلاب المشرف (لعرض حالة "بانتظار موافقة الإدارة")
  const { rows: pending } = await query(
    `select student_id, kind from student_requests where supervisor_id = $1 and status = 'pending'`,
    [req.user.supervisor_id]
  );
  const byStudent = new Map(pending.map((p) => [p.student_id, p.kind]));
  res.json({ students: students.map((st) => ({ ...st, pending_request: byStudent.get(st.id) || null })) });
});

router.post('/', async (req, res) => {
  const b = parse(z.object({ ...studentShape, supervisor_id: z.string().uuid().optional() }), req.body);
  const supervisorId = isAdmin(req) ? b.supervisor_id : req.user.supervisor_id;
  const id = await tx((c) => createStudent(c, req.user, b, { supervisorId }));
  res.status(201).json({ student: await getStudent(id) });
});

router.get('/:id', async (req, res) => {
  const student = await loadStudentFor(req, req.params.id);

  const { rows: appointments } = await query(
    `select a.id, a.kind, a.recitation_type, a.surah, a.portion, a.start_at, a.end_at, a.status,
            a.pages, a.grade, a.notes, a.completed_at
     from appointments a where a.student_id = $1 order by a.start_at desc limit 300`,
    [student.id]
  );
  const { rows: warnings } = await query(
    `select w.id, w.reason, w.active, w.created_at, w.resolved_at, u.full_name as created_by_name
     from student_warnings w left join users u on u.id = w.created_by
     where w.student_id = $1 order by w.created_at desc`,
    [student.id]
  );
  const { rows: history } = await query(
    `select id, actor_name, action, details, created_at from activity_log
     where entity_type = 'student' and entity_id = $1 order by id desc limit 30`,
    [student.id]
  );

  const { rows: requests } = await query(
    `select id, kind, reason, comments, status, requested_by_name, decided_by_name, decided_at, decision_note, created_at
     from student_requests where student_id = $1 order by created_at desc`,
    [student.id]
  );

  res.json({
    student,
    requests,
    appointments,
    exams: appointments.filter((a) => a.kind === 'exam' && ['completed', 'missed'].includes(a.status)),
    warnings,
    history,
  });
});

router.put('/:id', async (req, res) => {
  const b = parse(z.object(studentShape), req.body);
  const st = await loadStudentFor(req, req.params.id);

  let gender = b.gender || st.gender;
  if (st.supervisor_type && !genderAllowed(st.supervisor_type, gender)) {
    throw badRequest('جنس الطالب لا يتوافق مع نوع المشرف');
  }

  await tx(async (c) => {
    await c.query(
      `update students set full_name = $1, gender = $2, birth_date = $3, phone = $4, guardian_name = $5,
              guardian_phone = $6, address = $7, join_date = coalesce($8::date, join_date),
              initial_parts = $9, notes = $10 where id = $11`,
      [
        b.full_name,
        gender,
        b.birth_date ?? null,
        b.phone ?? null,
        b.guardian_name ?? null,
        b.guardian_phone ?? null,
        b.address ?? null,
        b.join_date ?? null,
        b.initial_parts,
        b.notes ?? null,
        st.id,
      ]
    );
    await logActivity(c, req.user, 'student.update', 'student', st.id, b.full_name);
  });
  res.json({ student: await getStudent(st.id) });
});

// الفصل المباشر للمسؤول فقط — المشرف يرسل طلب فصل (POST /:id/requests)
router.post('/:id/suspend', requireAdmin, async (req, res) => {
  const { reason } = parse(z.object({ reason: optText('السبب', 500) }), req.body);
  const st = await loadStudentFor(req, req.params.id);
  if (st.status !== 'active') throw conflict('الطالب غير نشط');
  await tx((c) => suspendStudent(c, req.user, st, reason));
  res.json({ student: await getStudent(st.id) });
});

router.post('/:id/reinstate', requireAdmin, async (req, res) => {
  const st = await loadStudentFor(req, req.params.id);
  if (st.status !== 'suspended') throw conflict('الطالب غير مفصول');
  if (!st.supervisor_id) throw conflict('انقل الطالب إلى مشرف أولًا ثم أعد تفعيله');
  if (st.supervisor_status !== 'active') throw conflict('مشرف الطالب مفصول حاليًا');
  await tx(async (c) => {
    await c.query(
      `update students set status = 'active', suspended_at = null, suspension_reason = null where id = $1`,
      [st.id]
    );
    await logActivity(c, req.user, 'student.reinstate', 'student', st.id, st.full_name);
  });
  res.json({ student: await getStudent(st.id) });
});

/**
 * حذف ناعم (للمسؤول فقط): يُخفى الطالب من القوائم وتُلغى مواعيده القادمة، وتبقى كل سجلاته محفوظة.
 * المشرف لا يحذف — يرسل "طلب حذف" للإدارة.
 */
router.delete('/:id', requireAdmin, async (req, res) => {
  const { reason } = parse(z.object({ reason: optText('السبب', 500) }), req.body);
  const st = await loadStudentFor(req, req.params.id);
  if (st.status === 'removed') throw conflict('الطالب محذوف مسبقًا');
  await tx((c) => removeStudent(c, req.user, st, reason));
  res.json({ ok: true });
});

/** استعادة طالب محذوف (للمسؤول) — يعود موقوفًا ليُعاد تفعيله أو نقله */
router.post('/:id/restore', requireAdmin, async (req, res) => {
  const st = await loadStudentFor(req, req.params.id);
  if (st.status !== 'removed') throw conflict('الطالب غير محذوف');
  await tx(async (c) => {
    await c.query(
      `update students set status = 'suspended', removed_at = null, suspended_at = now(),
              suspension_reason = 'مستعاد بعد الحذف — بانتظار إعادة التفعيل' where id = $1`,
      [st.id]
    );
    await logActivity(c, req.user, 'student.restore', 'student', st.id, st.full_name);
  });
  res.json({ student: await getStudent(st.id) });
});

// ---------------- طلبات الحذف / الفصل (من المشرف إلى الإدارة) ----------------
const requestSchema = z.object({
  kind: z.enum(['removal', 'dismissal'], { errorMap: () => ({ message: 'اختر نوع الطلب' }) }),
  reason: reqText('السبب', 1000),
  comments: optText('الملاحظات', 2000),
});

router.post('/:id/requests', requireSupervisor, async (req, res) => {
  const b = parse(requestSchema, req.body);
  const st = await loadStudentFor(req, req.params.id);
  if (b.kind === 'dismissal' && st.status !== 'active') throw conflict('الطالب غير نشط حاليًا');
  const request = await tx(async (c) => {
    let rows;
    try {
      ({ rows } = await c.query(
        `insert into student_requests (student_id, supervisor_id, requested_by, requested_by_name, kind, reason, comments)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [st.id, req.user.supervisor_id, req.user.id, req.user.full_name, b.kind, b.reason, b.comments ?? null]
      ));
    } catch (e) {
      if (e.code === '23505') throw conflict('يوجد طلب معلّق لهذا الطالب بالفعل', 'DUPLICATE_REQUEST');
      throw e;
    }
    const label = b.kind === 'removal' ? 'حذف' : 'فصل';
    await logActivity(c, req.user, `student.request_${b.kind}`, 'student', st.id, st.full_name, { reason: b.reason });
    await notifyAdmins(c, {
      type: 'student_request',
      title: `طلب ${label} طالب بانتظار الموافقة`,
      body: `${req.user.full_name} يطلب ${label} ${st.full_name}: ${b.reason}`,
      link: '/requests',
      dedupeKey: `student_request:${rows[0].id}`,
    });
    return rows[0];
  });
  res.status(201).json({ request });
});

/** نقل طالب لمشرف آخر (للمسؤول) — تُلغى مواعيده القادمة مع المشرف السابق */
router.post('/:id/transfer', requireAdmin, async (req, res) => {
  const { supervisor_id: target } = parse(z.object({ supervisor_id: z.string().uuid('اختر المشرف') }), req.body);
  const st = await getStudent(req.params.id);
  if (!st) throw notFound('الطالب غير موجود');
  const { rows } = await query(
    `select sp.id, sp.supervisor_type, sp.status, u.full_name from supervisors sp
     join users u on u.id = sp.user_id where sp.id = $1`,
    [target]
  );
  const sup = rows[0];
  if (!sup) throw notFound('المشرف غير موجود');
  if (sup.status !== 'active') throw conflict('المشرف الهدف مفصول');
  if (!genderAllowed(sup.supervisor_type, st.gender)) throw conflict('جنس الطالب لا يتوافق مع نوع المشرف الهدف');
  if (st.supervisor_id === target) throw badRequest('الطالب عند هذا المشرف بالفعل');

  const cancelled = await tx(async (c) => {
    const r = await c.query(
      `update appointments set status = 'cancelled' where student_id = $1 and status = 'scheduled'`,
      [st.id]
    );
    await c.query('update students set supervisor_id = $1 where id = $2', [target, st.id]);
    await logActivity(c, req.user, 'student.transfer', 'student', st.id, st.full_name, {
      from: st.supervisor_name,
      to: sup.full_name,
      cancelled_appointments: r.rowCount,
    });
    return r.rowCount;
  });
  res.json({ student: await getStudent(st.id), cancelled_appointments: cancelled });
});

// ---------------- التحذيرات اليدوية ----------------
router.post('/:id/warnings', async (req, res) => {
  const { reason } = parse(z.object({ reason: reqText('سبب التحذير', 500) }), req.body);
  const st = await loadStudentFor(req, req.params.id);
  await tx(async (c) => {
    await c.query('insert into student_warnings (student_id, reason, created_by) values ($1, $2, $3)', [
      st.id,
      reason,
      req.user.id,
    ]);
    await logActivity(c, req.user, 'student.warning', 'student', st.id, st.full_name, { reason });
  });
  res.status(201).json({ student: await getStudent(st.id) });
});

router.post('/:id/warnings/:wid/resolve', async (req, res) => {
  if (!isUuid(req.params.wid)) throw notFound();
  const st = await loadStudentFor(req, req.params.id);
  const r = await query(
    `update student_warnings set active = false, resolved_at = now()
     where id = $1 and student_id = $2 and active`,
    [req.params.wid, st.id]
  );
  if (!r.rowCount) throw notFound('التحذير غير موجود أو مغلق');
  await logActivity({ query }, req.user, 'student.warning_resolved', 'student', st.id, st.full_name);
  res.json({ student: await getStudent(st.id) });
});

export default router;
