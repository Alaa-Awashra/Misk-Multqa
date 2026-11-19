import { Router } from 'express';
import crypto from 'node:crypto';
import { query, tx } from '../db.js';
import { requireSupervisor, allowRoles } from '../middleware/auth.js';
import { notFound, conflict, badRequest, uuidParam, isUuid } from '../utils/errors.js';
import { parse, z, optText } from '../utils/validate.js';
import { logActivity } from '../services/activity.js';
import { getSettings } from '../services/settings.js';
import { localParts, hmToMinutes, fmtTimeAr, addDays } from '../utils/tz.js';
import { config } from '../config.js';

const router = Router();
router.param('id', uuidParam);
router.param('sid', uuidParam);
// مشرف التسجيل لا يصل إلى المواعيد
router.use(allowRoles('admin', 'supervisor'));

const isAdmin = (req) => req.user.role === 'admin';

const SELECT = `
  select a.*, s.full_name as student_name, s.gender as student_gender,
         sp.supervisor_type, u.full_name as supervisor_name
  from appointments a
  join students s on s.id = a.student_id
  left join supervisors sp on sp.id = a.supervisor_id
  left join users u on u.id = sp.user_id`;

async function getAppointment(id, db = { query }) {
  const { rows } = await db.query(`${SELECT} where a.id = $1`, [id]);
  return rows[0] || null;
}

/** يحمّل الموعد ويتأكد من الصلاحية: المشرف على مواعيده فقط، والمسؤول (إن سُمح) على الكل */
async function loadOwned(req, id, { adminAllowed = false } = {}) {
  const a = await getAppointment(id);
  if (!a) throw notFound('الموعد غير موجود');
  if (isAdmin(req) && adminAllowed) return a;
  if (a.supervisor_id !== req.user.supervisor_id || !req.user.supervisor_id) throw notFound('الموعد غير موجود');
  return a;
}

// ---------------------------------------------------------------- قائمة المواعيد
router.get('/', async (req, res) => {
  const params = [];
  const where = [];
  const add = (sql, val) => {
    params.push(val);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (!isAdmin(req)) add('a.supervisor_id = ?', req.user.supervisor_id);
  else if (isUuid(req.query.supervisor_id)) add('a.supervisor_id = ?', req.query.supervisor_id);
  if (isAdmin(req) && ['male', 'female', 'kids'].includes(req.query.group)) add('sp.supervisor_type = ?', req.query.group);

  if (isUuid(req.query.student_id)) add('a.student_id = ?', req.query.student_id);
  if (req.query.from && !Number.isNaN(Date.parse(req.query.from))) add('a.end_at > ?::timestamptz', req.query.from);
  if (req.query.to && !Number.isNaN(Date.parse(req.query.to))) add('a.start_at < ?::timestamptz', req.query.to);
  if (['recitation', 'exam'].includes(req.query.kind)) add('a.kind = ?', req.query.kind);
  if (['scheduled', 'completed', 'missed', 'cancelled'].includes(req.query.status)) add('a.status = ?', req.query.status);
  if (req.query.include_cancelled !== 'true' && !req.query.status) where.push(`a.status <> 'cancelled'`);

  const { rows } = await query(
    `${SELECT} ${where.length ? `where ${where.join(' and ')}` : ''} order by a.start_at, s.full_name limit 5000`,
    params
  );
  res.json({ appointments: rows });
});

router.get('/sessions/:sid', async (req, res) => {
  const { rows } = await query(`${SELECT} where a.session_id = $1 order by s.full_name`, [req.params.sid]);
  if (!rows.length || (!isAdmin(req) && rows[0].supervisor_id !== req.user.supervisor_id)) throw notFound('الجلسة غير موجودة');
  res.json({ appointments: rows });
});

router.get('/:id', async (req, res) => {
  const a = await loadOwned(req, req.params.id, { adminAllowed: true });
  res.json({ appointment: a });
});

// ---------------------------------------------------------------- التحقق من التوقيت
function assertWorkingHours(start, end, settings) {
  const s = localParts(start);
  const e = localParts(end);
  if (s.date !== e.date) throw badRequest('يجب أن ينتهي الموعد في نفس اليوم');
  const from = hmToMinutes(settings.work_start);
  const to = hmToMinutes(settings.work_end);
  if (s.minutes < from || e.minutes > to) {
    throw badRequest(`الموعد خارج ساعات الدوام (${settings.work_start} – ${settings.work_end})`);
  }
}

/**
 * يبحث عن تعارض حقيقي فقط:
 *   - نفس الطالب في موعد آخر متداخل (مع أي مشرف)
 *   - نفس المشرف في جلسة *أخرى* متداخلة (طلاب نفس الجلسة لا يتعارضون)
 * لا يوجد أي قيد بين مشرفين مختلفين.
 */
async function findConflict(db, { start, end, supervisorId, studentId, excludeIds = [], sessionKey = null }) {
  const { rows } = await db.query(
    `select a.id, a.start_at, a.end_at, a.supervisor_id, a.student_id, s.full_name as student_name
     from appointments a join students s on s.id = a.student_id
     where a.status = 'scheduled'
       and not (a.id = any($5::uuid[]))
       and tstzrange(a.start_at, a.end_at, '[)') && tstzrange($1::timestamptz, $2::timestamptz, '[)')
       and ((a.supervisor_id = $3::uuid and coalesce(a.session_id, a.id) is distinct from $6::uuid) or a.student_id = $4::uuid)
     order by a.start_at limit 1`,
    [start.toISOString(), end.toISOString(), supervisorId, studentId, excludeIds, sessionKey]
  );
  const row = rows[0];
  if (!row) return null;
  const when = `${localParts(new Date(row.start_at)).date} من ${fmtTimeAr(new Date(row.start_at))} إلى ${fmtTimeAr(new Date(row.end_at))}`;
  return row.student_id === studentId
    ? `لدى ${row.student_name} موعد آخر في نفس الوقت (${when})`
    : `لدى المشرف جلسة أخرى في نفس الوقت مع ${row.student_name} (${when})`;
}

const PAST_GRACE_MS = 2 * 60 * 1000;

/** تواريخ تكرار الجلسة بالتوقيت المحلي (يحافظ على نفس الساعة عبر التوقيت الصيفي) */
async function occurrenceStarts(db, start, recurrence) {
  const count = recurrence?.count || 1;
  if (count === 1) return [start];
  const step = { daily: 1, weekly: 7, biweekly: 14 }[recurrence.freq] || 7;
  const p = localParts(start);
  const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const dates = Array.from({ length: count }, (_, i) => addDays(p.date, i * step));
  const { rows } = await db.query(
    `select (d::date + $2::time) at time zone $3::text as ts from unnest($1::text[]) as d order by 1`,
    [dates, hm, config.timezone]
  );
  return rows.map((r) => new Date(r.ts));
}

// ---------------------------------------------------------------- إنشاء موعد / جلسة جماعية / سلسلة متكررة
const createSchema = z
  .object({
    student_id: z.string().uuid('اختر الطالب').optional(),
    student_ids: z.array(z.string().uuid('طالب غير صالح')).min(1, 'اختر طالبًا واحدًا على الأقل').max(40, 'الحد الأقصى 40 طالبًا في الجلسة').optional(),
    join_session_id: z.string().uuid().optional(),
    kind: z.enum(['recitation', 'exam'], { errorMap: () => ({ message: 'اختر نوع الموعد' }) }),
    recitation_type: z.enum(['new', 'review']).optional().nullable(),
    surah: optText('السورة', 100),
    portion: optText('المقطع', 200),
    start_at: z.string({ required_error: 'حدد وقت الموعد' }).refine((v) => !Number.isNaN(Date.parse(v)), 'وقت الموعد غير صالح'),
    duration_min: z.coerce.number().int('مدة غير صالحة').min(5, 'أقل مدة 5 دقائق').max(240, 'أطول مدة 4 ساعات').optional(),
    notes: optText('الملاحظات', 1000),
    // تسجيل تسميع/امتحان سابق مباشرة كمكتمل
    status: z.enum(['scheduled', 'completed']).default('scheduled'),
    pages: z.coerce.number().min(0, 'عدد الصفحات غير صالح').max(604, 'عدد الصفحات غير صالح').optional(),
    grade: z.coerce.number().min(0, 'العلامة بين 0 و 100').max(100, 'العلامة بين 0 و 100').optional(),
    recurrence: z
      .object({
        freq: z.enum(['daily', 'weekly', 'biweekly']),
        count: z.coerce.number().int().min(1, 'عدد التكرارات غير صالح').max(26, 'الحد الأقصى 26 تكرارًا'),
      })
      .optional()
      .nullable(),
  })
  .strict();

function validateKindFields(kind, b) {
  if (kind === 'exam' && !b.surah) throw badRequest('اختر السورة التي سيُمتحن فيها الطالب');
}

router.post('/', requireSupervisor, async (req, res) => {
  const b = parse(createSchema, req.body);
  validateKindFields(b.kind, b);
  const settings = await getSettings();
  const studentIds = [...new Set(b.student_ids || (b.student_id ? [b.student_id] : []))];
  if (!studentIds.length) throw badRequest('اختر الطالب');
  const recordPast = b.status === 'completed';
  if (recordPast && (studentIds.length > 1 || b.recurrence?.count > 1)) throw badRequest('تسجيل الموعد السابق يكون لطالب واحد ومرة واحدة');
  if (studentIds.length * (b.recurrence?.count || 1) > 300) throw badRequest('عدد المواعيد كبير جدًا في طلب واحد (الحد 300)');

  const { rows: students } = await query(
    `select id, full_name, status from students where id = any($1::uuid[]) and supervisor_id = $2`,
    [studentIds, req.user.supervisor_id]
  );
  if (students.length !== studentIds.length) throw notFound('بعض الطلاب غير موجودين ضمن طلابك');
  const inactive = students.find((s) => s.status !== 'active');
  if (inactive) throw conflict(`لا يمكن حجز موعد لطالب غير نشط (${inactive.full_name})`);

  let duration = b.duration_min ?? (b.kind === 'exam' ? settings.exam_minutes : settings.recitation_minutes);
  let firstStart = new Date(b.start_at);

  // الانضمام إلى جلسة قائمة: نفس الوقت والمدة
  let joinSession = null;
  if (b.join_session_id) {
    const { rows } = await query(
      `select start_at, end_at, series_id from appointments where session_id = $1 and supervisor_id = $2 and status = 'scheduled' limit 1`,
      [b.join_session_id, req.user.supervisor_id]
    );
    if (!rows[0]) throw notFound('الجلسة غير موجودة أو لم تعد محجوزة');
    joinSession = rows[0];
    firstStart = new Date(rows[0].start_at);
    duration = Math.round((new Date(rows[0].end_at) - firstStart) / 60_000);
  }

  if (recordPast) {
    if (firstStart.getTime() > Date.now()) throw badRequest('لا يمكن تسجيل نتيجة لموعد لم يحن وقته بعد');
    if (b.kind === 'exam' && b.grade === undefined) throw badRequest('أدخل علامة الامتحان');
    if (b.kind === 'recitation' && !(b.pages > 0)) throw badRequest('أدخل عدد الصفحات المسمّعة');
  } else if (firstStart.getTime() < Date.now() - PAST_GRACE_MS) {
    throw badRequest('لا يمكن حجز موعد في وقت مضى. لتسجيل تسميع سابق استخدم خيار "تسجيل تسميع سابق".');
  }

  const ids = await tx(async (c) => {
    const starts = joinSession ? [firstStart] : await occurrenceStarts(c, firstStart, b.recurrence);
    const seriesId = joinSession ? joinSession.series_id : starts.length > 1 ? crypto.randomUUID() : null;
    const grouped = studentIds.length > 1 || !!joinSession;
    const created = [];

    for (const start of starts) {
      const end = new Date(start.getTime() + duration * 60_000);
      if (!recordPast) assertWorkingHours(start, end, settings);
      const sessionId = joinSession ? b.join_session_id : grouped ? crypto.randomUUID() : null;
      for (const st of students) {
        if (!recordPast) {
          const msg = await findConflict(c, { start, end, supervisorId: req.user.supervisor_id, studentId: st.id, sessionKey: sessionId });
          if (msg) throw conflict(starts.length > 1 ? `${msg} — لم يُحجز أي موعد من السلسلة` : msg, 'TIME_CONFLICT');
        }
        const r = await c.query(
          `insert into appointments (student_id, supervisor_id, kind, recitation_type, surah, portion, start_at, end_at,
                                     status, pages, grade, notes, completed_at, created_by, session_id, series_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
          [
            st.id,
            req.user.supervisor_id,
            b.kind,
            b.kind === 'recitation' ? b.recitation_type || 'new' : null,
            b.surah ?? null,
            b.portion ?? null,
            start.toISOString(),
            end.toISOString(),
            b.status,
            b.kind === 'recitation' && recordPast ? b.pages : null,
            recordPast ? b.grade ?? null : null,
            b.notes ?? null,
            recordPast ? new Date().toISOString() : null,
            req.user.id,
            sessionId,
            seriesId,
          ]
        );
        created.push(r.rows[0].id);
        await logActivity(c, req.user, recordPast ? 'appointment.record' : 'appointment.create', 'appointment', r.rows[0].id, st.full_name, {
          kind: b.kind,
          start_at: start.toISOString(),
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(seriesId ? { series_id: seriesId } : {}),
        });
      }
    }
    return created;
  });
  res.status(201).json({ appointment: await getAppointment(ids[0]), created: ids.length });
});

// ---------------------------------------------------------------- تعديل / إعادة جدولة
const updateSchema = z
  .object({
    kind: z.enum(['recitation', 'exam']).optional(),
    recitation_type: z.enum(['new', 'review']).optional().nullable(),
    surah: optText('السورة', 100),
    portion: optText('المقطع', 200),
    start_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'وقت الموعد غير صالح').optional(),
    duration_min: z.coerce.number().int('مدة غير صالحة').min(5, 'أقل مدة 5 دقائق').max(240, 'أطول مدة 4 ساعات').optional(),
    notes: optText('الملاحظات', 1000),
  })
  .strict();

router.put('/:id', async (req, res) => {
  const b = parse(updateSchema, req.body);
  const a = await loadOwned(req, req.params.id, { adminAllowed: true });
  if (a.status !== 'scheduled') throw conflict('يمكن تعديل المواعيد المحجوزة فقط');

  const settings = await getSettings();
  const kind = b.kind ?? a.kind;
  const surah = b.surah !== undefined ? b.surah : a.surah;
  validateKindFields(kind, { surah });

  const start = b.start_at ? new Date(b.start_at) : new Date(a.start_at);
  const oldDuration = Math.round((new Date(a.end_at) - new Date(a.start_at)) / 60_000);
  const duration = b.duration_min ?? oldDuration;
  const end = new Date(start.getTime() + duration * 60_000);
  const timeChanged = start.getTime() !== new Date(a.start_at).getTime() || duration !== oldDuration;

  if (timeChanged) {
    if (start.getTime() < Date.now() - PAST_GRACE_MS) throw badRequest('لا يمكن نقل الموعد إلى وقت مضى');
    assertWorkingHours(start, end, settings);
  }

  await tx(async (c) => {
    if (timeChanged) {
      // نقل طالب واحد خارج جلسته يفصله عنها
      const msg = await findConflict(c, { start, end, supervisorId: a.supervisor_id, studentId: a.student_id, excludeIds: [a.id] });
      if (msg) throw conflict(msg, 'TIME_CONFLICT');
    }
    await c.query(
      `update appointments set kind = $1, recitation_type = $2, surah = $3, portion = $4, start_at = $5, end_at = $6,
              notes = $7, reschedule_count = reschedule_count + $8,
              session_id = case when $8 = 1 then null else session_id end where id = $9`,
      [
        kind,
        kind === 'recitation' ? (b.recitation_type !== undefined ? b.recitation_type : a.recitation_type) || 'new' : null,
        surah ?? null,
        (b.portion !== undefined ? b.portion : a.portion) ?? null,
        start.toISOString(),
        end.toISOString(),
        (b.notes !== undefined ? b.notes : a.notes) ?? null,
        timeChanged ? 1 : 0,
        a.id,
      ]
    );
    await logActivity(c, req.user, timeChanged ? 'appointment.reschedule' : 'appointment.update', 'appointment', a.id, a.student_name, {
      from: a.start_at,
      to: start.toISOString(),
    });
  });
  res.json({ appointment: await getAppointment(a.id) });
});

// ---------------------------------------------------------------- الجلسات الجماعية: نقل / إلغاء
async function loadSession(req, sid, db = { query }) {
  const { rows } = await db.query(`${SELECT} where a.session_id = $1 and a.status = 'scheduled' order by s.full_name`, [sid]);
  if (!rows.length) throw notFound('الجلسة غير موجودة أو لا تحتوي مواعيد محجوزة');
  if (!isAdmin(req) && rows[0].supervisor_id !== req.user.supervisor_id) throw notFound('الجلسة غير موجودة');
  return rows;
}

router.put('/sessions/:sid', async (req, res) => {
  const b = parse(
    z.object({
      start_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'وقت الموعد غير صالح'),
      duration_min: z.coerce.number().int().min(5).max(240).optional(),
    }),
    req.body
  );
  const settings = await getSettings();
  const n = await tx(async (c) => {
    const appts = await loadSession(req, req.params.sid, c);
    const first = appts[0];
    const start = new Date(b.start_at);
    const duration = b.duration_min ?? Math.round((new Date(first.end_at) - new Date(first.start_at)) / 60_000);
    const end = new Date(start.getTime() + duration * 60_000);
    if (start.getTime() < Date.now() - PAST_GRACE_MS) throw badRequest('لا يمكن نقل الجلسة إلى وقت مضى');
    assertWorkingHours(start, end, settings);
    const ids = appts.map((a) => a.id);
    for (const a of appts) {
      const msg = await findConflict(c, { start, end, supervisorId: a.supervisor_id, studentId: a.student_id, excludeIds: ids, sessionKey: req.params.sid });
      if (msg) throw conflict(msg, 'TIME_CONFLICT');
    }
    await c.query(
      `update appointments set start_at = $2, end_at = $3, reschedule_count = reschedule_count + 1
       where session_id = $1 and status = 'scheduled'`,
      [req.params.sid, start.toISOString(), end.toISOString()]
    );
    await logActivity(c, req.user, 'appointment.session_reschedule', 'appointment', first.id, `جلسة (${appts.length} طلاب)`, {
      session_id: req.params.sid,
      from: first.start_at,
      to: start.toISOString(),
    });
    return appts.length;
  });
  res.json({ ok: true, moved: n });
});

router.post('/sessions/:sid/cancel', async (req, res) => {
  const n = await tx(async (c) => {
    const appts = await loadSession(req, req.params.sid, c);
    const r = await c.query(`update appointments set status = 'cancelled' where session_id = $1 and status = 'scheduled'`, [req.params.sid]);
    await logActivity(c, req.user, 'appointment.session_cancel', 'appointment', appts[0].id, `جلسة (${appts.length} طلاب)`, {
      session_id: req.params.sid,
      start_at: appts[0].start_at,
    });
    return r.rowCount;
  });
  res.json({ ok: true, cancelled: n });
});

/** إلغاء المواعيد القادمة في سلسلة متكررة */
router.post('/series/:sid/cancel', async (req, res) => {
  const n = await tx(async (c) => {
    const { rows } = await c.query(
      `select a.id, a.supervisor_id from appointments a where a.series_id = $1 and a.status = 'scheduled' and a.start_at > now()`,
      [req.params.sid]
    );
    if (!rows.length) throw notFound('لا توجد مواعيد قادمة في هذه السلسلة');
    if (!isAdmin(req) && rows[0].supervisor_id !== req.user.supervisor_id) throw notFound('السلسلة غير موجودة');
    const r = await c.query(
      `update appointments set status = 'cancelled' where series_id = $1 and status = 'scheduled' and start_at > now()`,
      [req.params.sid]
    );
    await logActivity(c, req.user, 'appointment.series_cancel', 'appointment', rows[0].id, 'سلسلة متكررة', {
      series_id: req.params.sid,
      cancelled: r.rowCount,
    });
    return r.rowCount;
  });
  res.json({ ok: true, cancelled: n });
});

// ---------------------------------------------------------------- النتيجة: تم / لم يلتزم / إلغاء
const resultSchema = z.object({
  pages: z.coerce.number({ invalid_type_error: 'عدد الصفحات غير صالح' }).min(0, 'عدد الصفحات غير صالح').max(604, 'عدد الصفحات غير صالح').optional(),
  grade: z.coerce.number({ invalid_type_error: 'العلامة غير صالحة' }).min(0, 'العلامة بين 0 و 100').max(100, 'العلامة بين 0 و 100').optional(),
  notes: optText('الملاحظات', 1000),
});

function assertStarted(a) {
  if (new Date(a.start_at).getTime() > Date.now()) {
    throw conflict('لم يحن وقت الموعد بعد، لا يمكن تسجيل نتيجته الآن');
  }
}

router.post('/:id/complete', requireSupervisor, async (req, res) => {
  const body = { ...req.body };
  // الحقول الفارغة القادمة من النموذج
  for (const k of ['pages', 'grade']) if (body[k] === '' || body[k] === null) delete body[k];
  const b = parse(resultSchema, body);
  const a = await loadOwned(req, req.params.id);
  if (a.status === 'cancelled') throw conflict('الموعد ملغي');
  assertStarted(a);

  if (a.kind === 'exam' && b.grade === undefined) throw badRequest('أدخل علامة الامتحان');
  if (a.kind === 'recitation' && !(b.pages > 0)) throw badRequest('أدخل عدد الصفحات المسمّعة');

  await tx(async (c) => {
    await c.query(
      `update appointments set status = 'completed', pages = $1, grade = $2, notes = coalesce($3, notes),
              completed_at = coalesce(completed_at, now()) where id = $4`,
      [a.kind === 'recitation' ? b.pages : null, b.grade ?? null, b.notes ?? null, a.id]
    );
    await logActivity(c, req.user, 'appointment.complete', 'appointment', a.id, a.student_name, {
      kind: a.kind,
      pages: b.pages,
      grade: b.grade,
    });
  });
  res.json({ appointment: await getAppointment(a.id) });
});

router.post('/:id/missed', requireSupervisor, async (req, res) => {
  const b = parse(z.object({ notes: optText('الملاحظات', 1000) }), req.body);
  const a = await loadOwned(req, req.params.id);
  if (a.status === 'cancelled') throw conflict('الموعد ملغي');
  assertStarted(a);
  await tx(async (c) => {
    await c.query(
      `update appointments set status = 'missed', pages = null, grade = null, completed_at = null,
              notes = coalesce($1, notes) where id = $2`,
      [b.notes ?? null, a.id]
    );
    await logActivity(c, req.user, 'appointment.missed', 'appointment', a.id, a.student_name, { kind: a.kind });
  });
  res.json({ appointment: await getAppointment(a.id) });
});

router.post('/:id/cancel', async (req, res) => {
  const a = await loadOwned(req, req.params.id, { adminAllowed: true });
  if (a.status !== 'scheduled') throw conflict('يمكن إلغاء المواعيد المحجوزة فقط');
  await tx(async (c) => {
    await c.query(`update appointments set status = 'cancelled' where id = $1`, [a.id]);
    await logActivity(c, req.user, 'appointment.cancel', 'appointment', a.id, a.student_name, { kind: a.kind });
  });
  res.json({ appointment: await getAppointment(a.id) });
});

router.delete('/:id', requireSupervisor, async (req, res) => {
  const a = await loadOwned(req, req.params.id);
  await tx(async (c) => {
    await logActivity(c, req.user, 'appointment.delete', 'appointment', a.id, a.student_name, {
      kind: a.kind,
      status: a.status,
      start_at: a.start_at,
    });
    await c.query('delete from appointments where id = $1', [a.id]);
  });
  res.json({ ok: true });
});

export default router;
