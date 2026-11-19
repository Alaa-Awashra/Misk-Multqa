import { query } from '../db.js';
import { getSettings } from './settings.js';
import { logActivity } from './activity.js';
import { notFound, conflict, badRequest } from '../utils/errors.js';

const round = (n, d = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

/** يتوافق جنس الطالب مع نوع المشرف؟ (الكيدز: الجنسان) */
export const genderAllowed = (type, gender) =>
  type === 'kids' || (type === 'male' && gender === 'male') || (type === 'female' && gender === 'female');

const STATS_SQL = `
  select s.*,
         u.full_name as supervisor_name, sp.supervisor_type, sp.status as supervisor_status,
         coalesce(st.rec_completed, 0) as rec_completed,
         coalesce(st.rec_missed, 0)    as rec_missed,
         coalesce(st.rec_upcoming, 0)  as rec_upcoming,
         coalesce(st.rec_pending, 0)   as rec_pending,
         coalesce(st.pages_total, 0)   as pages_total,
         coalesce(st.pages_new, 0)     as pages_new,
         st.last_recitation_at, st.avg_grade,
         coalesce(st.exams_completed, 0) as exams_completed,
         coalesce(st.exams_missed, 0)    as exams_missed,
         st.avg_exam_grade,
         coalesce(st.missed_30d, 0)      as missed_30d,
         coalesce(w.c, 0)                as manual_warnings
  from students s
  left join supervisors sp on sp.id = s.supervisor_id
  left join users u on u.id = sp.user_id
  left join lateral (
    select
      count(*) filter (where a.kind = 'recitation' and a.status = 'completed') as rec_completed,
      count(*) filter (where a.kind = 'recitation' and a.status = 'missed') as rec_missed,
      count(*) filter (where a.kind = 'recitation' and a.status = 'scheduled' and a.end_at >= now()) as rec_upcoming,
      count(*) filter (where a.kind = 'recitation' and a.status = 'scheduled' and a.end_at < now()) as rec_pending,
      coalesce(sum(a.pages) filter (where a.kind = 'recitation' and a.status = 'completed'), 0) as pages_total,
      coalesce(sum(a.pages) filter (where a.kind = 'recitation' and a.status = 'completed' and a.recitation_type = 'new'), 0) as pages_new,
      max(a.start_at) filter (where a.kind = 'recitation' and a.status = 'completed') as last_recitation_at,
      avg(a.grade) filter (where a.kind = 'recitation' and a.status = 'completed' and a.grade is not null) as avg_grade,
      count(*) filter (where a.kind = 'exam' and a.status = 'completed') as exams_completed,
      count(*) filter (where a.kind = 'exam' and a.status = 'missed') as exams_missed,
      avg(a.grade) filter (where a.kind = 'exam' and a.status = 'completed') as avg_exam_grade,
      count(*) filter (where a.status = 'missed' and a.start_at >= now() - interval '30 days') as missed_30d
    from appointments a
    where a.student_id = s.id
  ) st on true
  left join lateral (
    select count(*) as c from student_warnings sw where sw.student_id = s.id and sw.active
  ) w on true`;

/** يحسب القيم المشتقة: الأجزاء، نسبة الالتزام، وحالة التحذير وأسبابه */
export function enrichStudent(r, settings) {
  const juz = settings.juz_pages || 20;
  const done = r.rec_completed + r.rec_missed;
  const reasons = [];

  if (r.status === 'active') {
    if (r.manual_warnings > 0) reasons.push('تحذير إداري');
    if (r.missed_30d >= settings.warning_missed_threshold) {
      reasons.push(`عدم التزام ${r.missed_30d} مرات خلال 30 يومًا`);
    }
    const ref = r.last_recitation_at ? new Date(r.last_recitation_at) : new Date(`${r.join_date}T00:00:00`);
    const days = Math.floor((Date.now() - ref.getTime()) / 86_400_000);
    if (r.supervisor_id && days >= settings.warning_inactive_days) {
      reasons.push(r.last_recitation_at ? `لم يسمّع منذ ${days} يومًا` : `لم يسمّع منذ انضمامه (${days} يومًا)`);
    }
  }

  return {
    ...r,
    avg_grade: round(r.avg_grade, 1),
    avg_exam_grade: round(r.avg_exam_grade, 1),
    total_parts: round(Number(r.initial_parts) + r.pages_new / juz, 2),
    rec_assigned: r.rec_completed + r.rec_missed + r.rec_upcoming + r.rec_pending,
    attendance_rate: done ? Math.round((100 * r.rec_completed) / done) : null,
    warning: reasons.length > 0,
    warning_reasons: reasons,
  };
}

/**
 * قائمة الطلاب مع الإحصائيات.
 * supervisorId: uuid | 'none' (بدون مشرف) | null (الكل)
 */
export async function listStudents({ supervisorId = null, studentId = null, includeRemoved = false } = {}) {
  const settings = await getSettings();
  const params = [];
  const where = [];
  // الطلاب المحذوفون (حذف ناعم) لا يظهرون في القوائم والإحصائيات، لكن سجلاتهم محفوظة
  if (!includeRemoved && !studentId) where.push(`s.status <> 'removed'`);
  if (supervisorId === 'none') where.push('s.supervisor_id is null');
  else if (supervisorId) {
    params.push(supervisorId);
    where.push(`s.supervisor_id = $${params.length}`);
  }
  if (studentId) {
    params.push(studentId);
    where.push(`s.id = $${params.length}`);
  }
  const { rows } = await query(
    `${STATS_SQL} ${where.length ? `where ${where.join(' and ')}` : ''} order by s.full_name`,
    params
  );
  return rows.map((r) => enrichStudent(r, settings));
}

export async function getStudent(id) {
  const rows = await listStudents({ studentId: id });
  return rows[0] || null;
}

/**
 * إنشاء طالب — المسار الوحيد لإضافة الطلاب (من المشرف/المسؤول أو من قبول طلب التحاق).
 * c: client داخل transaction. يعيد معرّف الطالب.
 */
export async function createStudent(c, actor, b, { supervisorId, applicationId = null } = {}) {
  if (!supervisorId) throw badRequest('اختر المشرف المسؤول عن الطالب');
  const { rows } = await c.query(`select sp.id, sp.supervisor_type, sp.status from supervisors sp where sp.id = $1`, [supervisorId]);
  const sup = rows[0];
  if (!sup) throw notFound('المشرف غير موجود');
  if (sup.status !== 'active') throw conflict('لا يمكن إضافة طلاب لمشرف موقوف');

  let gender = b.gender;
  if (sup.supervisor_type === 'male' && !gender) gender = 'male';
  if (sup.supervisor_type === 'female' && !gender) gender = 'female';
  if (!gender) throw badRequest('اختر جنس الطالب');
  if (!genderAllowed(sup.supervisor_type, gender)) throw badRequest('جنس الطالب لا يتوافق مع نوع المشرف');

  const r = await c.query(
    `insert into students (supervisor_id, full_name, gender, birth_date, phone, guardian_name, guardian_phone,
                           address, join_date, initial_parts, notes, application_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::date, current_date), $10, $11, $12) returning id`,
    [
      supervisorId,
      b.full_name,
      gender,
      b.birth_date ?? null,
      b.phone ?? null,
      b.guardian_name ?? null,
      b.guardian_phone ?? null,
      b.address ?? null,
      b.join_date ?? null,
      b.initial_parts ?? 0,
      b.notes ?? null,
      applicationId,
    ]
  );
  await logActivity(c, actor, 'student.create', 'student', r.rows[0].id, b.full_name, {
    supervisor_id: supervisorId,
    ...(applicationId ? { application_id: applicationId } : {}),
  });
  return r.rows[0].id;
}

/** حذف ناعم: الطالب يختفي من القوائم، مواعيده القادمة تُلغى، وكل سجلاته تبقى */
export async function removeStudent(c, actor, st, reason) {
  await c.query(`update students set status = 'removed', removed_at = now(), removal_reason = $1 where id = $2`, [
    reason ?? null,
    st.id,
  ]);
  const r = await c.query(`update appointments set status = 'cancelled' where student_id = $1 and status = 'scheduled'`, [st.id]);
  await c.query(
    `update student_requests set status = 'cancelled', decision_note = 'أُغلق تلقائيًا: حُذف الطالب'
     where student_id = $1 and status = 'pending' and kind <> 'removal'`,
    [st.id]
  );
  await logActivity(c, actor, 'student.remove', 'student', st.id, st.full_name, {
    reason,
    supervisor_id: st.supervisor_id,
    cancelled_appointments: r.rowCount,
  });
}

/** فصل (إيقاف) طالب مع إلغاء مواعيده القادمة — السجلات محفوظة */
export async function suspendStudent(c, actor, st, reason) {
  await c.query(`update students set status = 'suspended', suspended_at = now(), suspension_reason = $1 where id = $2`, [
    reason ?? null,
    st.id,
  ]);
  const r = await c.query(`update appointments set status = 'cancelled' where student_id = $1 and status = 'scheduled'`, [st.id]);
  await logActivity(c, actor, 'student.suspend', 'student', st.id, st.full_name, { reason, cancelled_appointments: r.rowCount });
}
