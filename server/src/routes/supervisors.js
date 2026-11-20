import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, tx } from '../db.js';
import { requireAdmin, revokeSessions } from '../middleware/auth.js';
import { HttpError, notFound, conflict, badRequest, uuidParam, isUuid } from '../utils/errors.js';
import { parse, z, reqText, optText, optDate, optEmail, optPhone } from '../utils/validate.js';
import { generatePassword, generateUsername } from '../utils/crypto.js';
import { logActivity } from '../services/activity.js';
import { listStudents, genderAllowed } from '../services/students.js';
import { localDateStr, monthStart, rangeSql } from '../utils/tz.js';
import { config } from '../config.js';
import { issueWarning, revokeWarning } from '../services/discipline.js';
import { setUserEmail, startEmailVerification, assertEmailAvailable, normalizeEmail } from '../services/emailVerification.js';
import { supervisorComplianceSummary } from '../services/compliance.js';

const router = Router();
router.use(requireAdmin);
router.param('id', uuidParam);

const SELECT = `
  select sp.id, sp.user_id, sp.supervisor_type, sp.status, sp.birth_date, sp.address, sp.national_id,
         sp.qualification, sp.join_date, sp.notes, sp.suspended_at, sp.suspension_reason, sp.created_at,
         sp.dismissed_by_policy, u.username, u.full_name, u.phone, u.email, u.email_verified_at,
         (select count(*) from students s where s.supervisor_id = sp.id and s.status = 'active') as students_active,
         (select count(*) from students s where s.supervisor_id = sp.id and s.status <> 'removed') as students_total,
         (select count(*) from supervisor_warnings w where w.supervisor_id = sp.id and w.status = 'active') as active_warnings
  from supervisors sp join users u on u.id = sp.user_id`;

async function getSupervisor(id, db = { query }) {
  const { rows } = await db.query(`${SELECT} where sp.id = $1`, [id]);
  if (!rows[0]) throw notFound('المشرف غير موجود');
  return rows[0];
}

const TYPES = ['male', 'female', 'kids'];

const infoShape = {
  full_name: reqText('الاسم', 120),
  supervisor_type: z.enum(TYPES, { errorMap: () => ({ message: 'اختر نوع المشرف' }) }),
  phone: optPhone,
  email: optEmail,
  birth_date: optDate,
  address: optText('العنوان', 300),
  national_id: optText('رقم الهوية', 30),
  qualification: optText('المؤهل', 200),
  join_date: optDate,
  notes: optText('الملاحظات', 1000),
};

router.get('/', async (req, res) => {
  const params = [];
  const where = [];
  if (['active', 'suspended'].includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`sp.status = $${params.length}`);
  }
  if (TYPES.includes(req.query.type)) {
    params.push(req.query.type);
    where.push(`sp.supervisor_type = $${params.length}`);
  }
  const { rows } = await query(
    `${SELECT} ${where.length ? `where ${where.join(' and ')}` : ''} order by u.full_name`,
    params
  );
  res.json({ supervisors: rows });
});

const reqEmail = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z
    .string({ required_error: 'البريد الإلكتروني مطلوب', invalid_type_error: 'البريد الإلكتروني مطلوب' })
    .min(1, 'البريد الإلكتروني مطلوب')
    .email('البريد الإلكتروني غير صالح')
    .max(150)
);

router.post('/', async (req, res) => {
  const b = parse(z.object({ ...infoShape, email: reqEmail }), req.body);
  b.email = normalizeEmail(b.email);
  let verification = null;
  const out = await tx(async (c) => {
    await assertEmailAvailable(c, b.email);
    const username = await generateUsername(c, b.supervisor_type);
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 10);
    const u = await c.query(
      // كلمة المرور تُخزَّن كـ bcrypt فقط وتُعرض للمسؤول مرة واحدة في هذه الاستجابة
      `insert into users (username, password_hash, role, full_name, phone, email)
       values ($1, $2, 'supervisor', $3, $4, $5) returning id`,
      [username, hash, b.full_name, b.phone ?? null, b.email ?? null]
    );
    const s = await c.query(
      `insert into supervisors (user_id, supervisor_type, birth_date, address, national_id, qualification, join_date, notes)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::date, current_date), $8) returning id`,
      [
        u.rows[0].id,
        b.supervisor_type,
        b.birth_date ?? null,
        b.address ?? null,
        b.national_id ?? null,
        b.qualification ?? null,
        b.join_date ?? null,
        b.notes ?? null,
      ]
    );
    await logActivity(c, req.user, 'supervisor.create', 'supervisor', s.rows[0].id, b.full_name, {
      type: b.supervisor_type,
    });
    verification = await startEmailVerification(c, u.rows[0].id);
    return { id: s.rows[0].id, username, password };
  });
  res.status(201).json({ ...out, verification_email_queued: !!verification?.queued });
});

router.get('/:id', async (req, res) => {
  const sup = await getSupervisor(req.params.id);

  const students = await listStudents({ supervisorId: sup.id });

  const tz = config.timezone;
  const from = monthStart();
  const to = localDateStr();
  const { rows: perf } = await query(
    `select
       count(*) filter (where kind = 'recitation' and status = 'completed') as rec_completed,
       count(*) filter (where status = 'missed') as missed,
       count(*) filter (where kind = 'exam' and status = 'completed') as exams,
       count(*) filter (where status = 'scheduled' and start_at >= now()) as upcoming,
       count(*) filter (where status = 'scheduled' and end_at < now()) as pending,
       coalesce(sum(pages) filter (where kind = 'recitation' and status = 'completed'), 0) as pages
     from appointments a
     where a.supervisor_id = $1 and ${rangeSql('a.start_at', 2, 3, 4)}`,
    [sup.id, from, to, tz]
  );

  const { rows: history } = await query(
    `select id, actor_name, action, details, created_at from activity_log
     where entity_type = 'supervisor' and entity_id = $1 order by id desc limit 50`,
    [sup.id]
  );

  const { rows: warnings } = await query(
    `select * from supervisor_warnings where supervisor_id = $1 order by created_at desc`,
    [sup.id]
  );

  res.json({
    supervisor: sup,
    warnings,
    // كلمات المرور لا تُسترجع: تظهر للمسؤول مرة واحدة عند الإنشاء أو إعادة التعيين فقط
    credentials: { username: sup.username, password: null, password_known: false },
    students,
    month: { from, to, ...perf[0] },
    history,
  });
});

router.put('/:id', async (req, res) => {
  const b = parse(z.object(infoShape), req.body);
  const sup = await getSupervisor(req.params.id);

  if (b.supervisor_type !== sup.supervisor_type) {
    const students = await listStudents({ supervisorId: sup.id });
    if (students.some((s) => !genderAllowed(b.supervisor_type, s.gender))) {
      throw conflict('لا يمكن تغيير النوع لأن لدى المشرف طلابًا لا يتوافقون مع النوع الجديد. انقلهم أولًا.');
    }
  }

  if (!b.email && sup.email) throw badRequest('البريد الإلكتروني مطلوب للمشرف');
  await tx(async (c) => {
    await c.query('update users set full_name = $1, phone = $2 where id = $3', [b.full_name, b.phone ?? null, sup.user_id]);
    if (b.email) {
      const { changed } = await setUserEmail(c, sup.user_id, b.email);
      if (changed) await startEmailVerification(c, sup.user_id);
    }
    await c.query(
      `update supervisors set supervisor_type = $1, birth_date = $2, address = $3, national_id = $4,
              qualification = $5, join_date = coalesce($6::date, join_date), notes = $7 where id = $8`,
      [
        b.supervisor_type,
        b.birth_date ?? null,
        b.address ?? null,
        b.national_id ?? null,
        b.qualification ?? null,
        b.join_date ?? null,
        b.notes ?? null,
        sup.id,
      ]
    );
    await logActivity(c, req.user, 'supervisor.update', 'supervisor', sup.id, b.full_name);
  });
  res.json({ supervisor: await getSupervisor(sup.id) });
});

router.post('/:id/reset-password', async (req, res) => {
  const sup = await getSupervisor(req.params.id);
  const password = generatePassword();
  const hash = await bcrypt.hash(password, 10);
  await tx(async (c) => {
    await c.query('update users set password_hash = $1, password_enc = null where id = $2', [hash, sup.user_id]);
    await revokeSessions(c, sup.user_id); // تسجيل خروج المشرف من كل الأجهزة
    await logActivity(c, req.user, 'supervisor.reset_password', 'supervisor', sup.id, sup.full_name);
  });
  res.json({ username: sup.username, password });
});

router.post('/:id/suspend', async (req, res) => {
  const { reason } = parse(z.object({ reason: optText('السبب', 500) }), req.body);
  const sup = await getSupervisor(req.params.id);
  if (sup.status === 'suspended') throw conflict('المشرف مفصول بالفعل');
  await tx(async (c) => {
    await c.query(
      `update supervisors set status = 'suspended', suspended_at = now(), suspension_reason = $1 where id = $2`,
      [reason ?? null, sup.id]
    );
    await logActivity(c, req.user, 'supervisor.suspend', 'supervisor', sup.id, sup.full_name, { reason });
  });
  res.json({ supervisor: await getSupervisor(sup.id) });
});

router.post('/:id/reinstate', async (req, res) => {
  const sup = await getSupervisor(req.params.id);
  if (sup.status !== 'suspended') throw conflict('المشرف غير مفصول');
  await tx(async (c) => {
    await c.query(
      `update supervisors set status = 'active', suspended_at = null, suspension_reason = null, dismissed_by_policy = false where id = $1`,
      [sup.id]
    );
    await logActivity(c, req.user, 'supervisor.reinstate', 'supervisor', sup.id, sup.full_name);
  });
  res.json({ supervisor: await getSupervisor(sup.id) });
});

/**
 * حذف نهائي. اختياريًا: transfer_to لنقل الطلاب إلى مشرف آخر.
 * بدون نقل: يصبح الطلاب "بدون مشرف" وتُحذف مواعيدهم القادمة مع المشرف.
 */
router.delete('/:id', async (req, res) => {
  const { transfer_to: transferTo } = parse(
    z.object({ transfer_to: z.preprocess((v) => (v === '' ? null : v), z.string().nullable().optional()) }),
    req.body
  );
  const sup = await getSupervisor(req.params.id);

  const result = await tx(async (c) => {
    let moved = 0;
    if (transferTo) {
      if (!isUuid(transferTo)) throw badRequest('المشرف الهدف غير صالح');
      if (transferTo === sup.id) throw badRequest('لا يمكن نقل الطلاب إلى نفس المشرف');
      const target = await getSupervisor(transferTo, c);
      if (target.status !== 'active') throw conflict('المشرف الهدف غير نشط');
      const { rows: studs } = await c.query('select gender from students where supervisor_id = $1', [sup.id]);
      if (studs.some((s) => !genderAllowed(target.supervisor_type, s.gender))) {
        throw conflict('المشرف الهدف لا يتوافق مع جنس بعض الطلاب');
      }
      const r = await c.query('update students set supervisor_id = $1 where supervisor_id = $2', [target.id, sup.id]);
      moved = r.rowCount;
    }
    const { rowCount: removedAppts } = await c.query(
      `delete from appointments where supervisor_id = $1 and status = 'scheduled'`,
      [sup.id]
    );
    const { rows: orphan } = await c.query('select count(*)::int as n from students where supervisor_id = $1', [sup.id]);
    await logActivity(c, req.user, 'supervisor.delete', 'supervisor', sup.id, sup.full_name, {
      transferred_students: moved,
      orphaned_students: orphan[0].n,
      removed_appointments: removedAppts,
    });
    await c.query('delete from users where id = $1', [sup.user_id]); // cascade -> supervisors
    return { transferred: moved, orphaned: orphan[0].n, removed_appointments: removedAppts };
  });
  res.json(result);
});

// ---------------------------------------------------------------- التحذيرات الرسمية
router.post('/:id/warnings', async (req, res) => {
  const b = parse(z.object({ reason: reqText('سبب التحذير', 1000), notes: optText('الملاحظات', 2000) }), req.body);
  const sup = await getSupervisor(req.params.id);
  if (sup.status !== 'active') throw conflict('المشرف موقوف بالفعل');
  const result = await tx((c) => issueWarning(c, req.user, sup.id, { reason: b.reason, notes: b.notes ?? null }));
  res.status(201).json({
    warning: result.warning,
    active_warnings: result.active,
    threshold: result.threshold,
    dismissed: result.dismissed,
    supervisor: await getSupervisor(sup.id),
  });
});

router.post('/:id/warnings/:wid/revoke', async (req, res) => {
  if (!isUuid(req.params.wid)) throw notFound('التحذير غير موجود');
  const { reason } = parse(z.object({ reason: reqText('سبب الإلغاء', 1000) }), req.body);
  const sup = await getSupervisor(req.params.id);
  const { rows } = await query('select supervisor_id from supervisor_warnings where id = $1', [req.params.wid]);
  if (rows[0]?.supervisor_id !== sup.id) throw notFound('التحذير غير موجود');
  const r = await tx((c) => revokeWarning(c, req.user, req.params.wid, reason));
  res.json({ active_warnings: r.active, supervisor: await getSupervisor(sup.id) });
});

// ---------------------------------------------------------------- البريد: إعادة إرسال التأكيد / تأكيد يدوي
router.post('/:id/resend-verification', async (req, res) => {
  const sup = await getSupervisor(req.params.id);
  const r = await tx((c) => startEmailVerification(c, sup.user_id));
  res.json({ queued: !!r.queued, already: !!r.already });
});

/** تأكيد يدوي من المسؤول (عند تأكد الإدارة من البريد بطريقة أخرى) — يُسجَّل في سجل النشاط */
router.post('/:id/verify-email', async (req, res) => {
  const { note } = parse(z.object({ note: reqText('طريقة التحقق', 300) }), req.body);
  const sup = await getSupervisor(req.params.id);
  if (!sup.email) throw badRequest('لا يوجد بريد للمشرف');
  await tx(async (c) => {
    await c.query(
      `update users set email_verified_at = now(), email_verify_token_hash = null, email_verify_expires_at = null where id = $1`,
      [sup.user_id]
    );
    await logActivity(c, req.user, 'supervisor.email_verified_manual', 'supervisor', sup.id, sup.full_name, {
      email: sup.email,
      reason: note,
    });
  });
  res.json({ supervisor: await getSupervisor(sup.id) });
});

// ---------------------------------------------------------------- متابعة اكتمال السجلات
router.get('/:id/compliance', async (req, res) => {
  const sup = await getSupervisor(req.params.id);
  res.json(await supervisorComplianceSummary(sup.id));
});

export default router;
