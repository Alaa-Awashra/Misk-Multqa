// القبول والتسجيل — لمشرف التسجيل والقبول والمسؤول فقط
import { Router } from 'express';
import { query, tx } from '../db.js';
import { allowRoles } from '../middleware/auth.js';
import { notFound, uuidParam, isUuid } from '../utils/errors.js';
import { parse, z, reqText, optText } from '../utils/validate.js';
import { logActivity } from '../services/activity.js';
import { createAdmissionForm, googleConnection } from '../services/google.js';
import { syncForm, markUnderReview, addNote, acceptApplication, rejectApplication } from '../services/admissions.js';

const router = Router();
router.use(allowRoles('registrar', 'admin'));
router.param('id', uuidParam);

router.get('/status', async (req, res) => {
  res.json({ google: await googleConnection() });
});

// ---------------------------------------------------------------- النماذج
router.get('/forms', async (req, res) => {
  const { rows } = await query(
    `select f.*, u.full_name as created_by_name,
            (select count(*) from applications a where a.form_id = f.id) as applications
     from registration_forms f left join users u on u.id = f.created_by order by f.created_at desc`
  );
  res.json({ forms: rows });
});

router.post('/forms', async (req, res) => {
  const b = parse(z.object({ title: reqText('عنوان النموذج', 150), description: optText('الوصف', 1000) }), req.body);
  const g = await createAdmissionForm({ title: b.title, description: b.description ?? null });
  const form = await tx(async (c) => {
    const { rows } = await c.query(
      `insert into registration_forms (title, description, google_form_id, responder_url, edit_url, sheet_id, sheet_url,
                                       question_map, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [b.title, b.description ?? null, g.google_form_id, g.responder_url, g.edit_url, g.sheet_id, g.sheet_url, JSON.stringify(g.question_map), req.user.id]
    );
    await logActivity(c, req.user, 'admission.form_created', 'admission', rows[0].id, b.title);
    return rows[0];
  });
  res.status(201).json({ form, publish_warning: g.publish_warning });
});

router.post('/forms/:id/sync', async (req, res) => {
  res.json(await syncForm(req.params.id));
});

router.post('/forms/:id/status', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['active', 'closed']) }), req.body);
  const r = await query(`update registration_forms set status = $2 where id = $1 returning title`, [req.params.id, status]);
  if (!r.rowCount) throw notFound();
  await logActivity({ query }, req.user, status === 'closed' ? 'admission.form_closed' : 'admission.form_opened', 'admission', req.params.id, r.rows[0].title);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- الطلبات
router.get('/applications', async (req, res) => {
  const params = [];
  const where = [];
  if (['new', 'under_review', 'accepted', 'rejected'].includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`a.status = $${params.length}`);
  }
  if (isUuid(req.query.form_id)) {
    params.push(req.query.form_id);
    where.push(`a.form_id = $${params.length}`);
  }
  if (req.query.duplicates === 'true') where.push(`a.duplicate_reason is not null`);
  const { rows } = await query(
    `select a.id, a.form_id, a.submitted_at, a.full_name, a.gender, a.birth_date, a.phone, a.email, a.prior_parts,
            a.status, a.duplicate_reason, a.decided_at, f.title as form_title, u.full_name as supervisor_name
     from applications a
     left join registration_forms f on f.id = a.form_id
     left join supervisors sp on sp.id = a.assigned_supervisor_id
     left join users u on u.id = sp.user_id
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by a.submitted_at desc limit 2000`,
    params
  );
  const { rows: counts } = await query(`select status, count(*)::int as n from applications group by status`);
  res.json({ applications: rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
});

router.get('/applications/:id', async (req, res) => {
  const { rows } = await query(
    `select a.*, f.title as form_title, u.full_name as supervisor_name, d.full_name as decided_by_name,
            dup.full_name as duplicate_application_name
     from applications a
     left join registration_forms f on f.id = a.form_id
     left join supervisors sp on sp.id = a.assigned_supervisor_id
     left join users u on u.id = sp.user_id
     left join users d on d.id = a.decided_by
     left join applications dup on dup.id = a.duplicate_of_application
     where a.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) throw notFound('الطلب غير موجود');
  const { rows: events } = await query(`select * from application_events where application_id = $1 order by id`, [req.params.id]);
  res.json({ application: rows[0], events });
});

router.post('/applications/:id/review', async (req, res) => {
  await markUnderReview(req.user, req.params.id);
  res.json({ ok: true });
});

router.post('/applications/:id/notes', async (req, res) => {
  const { note } = parse(z.object({ note: reqText('الملاحظة', 1000) }), req.body);
  await addNote(req.user, req.params.id, note);
  res.json({ ok: true });
});

router.post('/applications/:id/accept', async (req, res) => {
  const b = parse(
    z.object({
      supervisor_id: z.string({ required_error: 'اختر المشرف' }).uuid('اختر المشرف'),
      gender: z.enum(['male', 'female']).optional(),
      initial_parts: z.coerce.number().min(0).max(30).optional(),
      note: optText('الملاحظة', 1000),
    }),
    req.body
  );
  const studentId = await acceptApplication(req.user, req.params.id, {
    supervisorId: b.supervisor_id,
    note: b.note,
    gender: b.gender,
    initialParts: b.initial_parts,
  });
  await logActivity({ query }, req.user, 'admission.accepted', 'admission', req.params.id, null, { student_id: studentId });
  res.json({ ok: true, student_id: studentId });
});

router.post('/applications/:id/reject', async (req, res) => {
  const { note } = parse(z.object({ note: optText('سبب الرفض', 1000) }), req.body);
  await rejectApplication(req.user, req.params.id, note);
  await logActivity({ query }, req.user, 'admission.rejected', 'admission', req.params.id, null, { reason: note });
  res.json({ ok: true });
});

/** قائمة مختصرة بالمشرفين النشطين (للتعيين فقط — بلا بيانات طلابهم) */
router.get('/supervisors', async (req, res) => {
  const { rows } = await query(
    `select sp.id, u.full_name, sp.supervisor_type,
            (select count(*) from students s where s.supervisor_id = sp.id and s.status = 'active')::int as students
     from supervisors sp join users u on u.id = sp.user_id where sp.status = 'active' order by u.full_name`
  );
  res.json({ supervisors: rows });
});

export default router;
