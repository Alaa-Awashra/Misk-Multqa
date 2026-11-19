// القبول والتسجيل: مزامنة استجابات Google Forms إلى جدول الطلبات + كشف التكرار + قرار القبول
import { query, tx } from '../db.js';
import { listFormResponses, appendSheetRows, ADMISSION_FIELDS, googleConfigured } from './google.js';
import { createStudent } from './students.js';
import { notifyUser } from './notify.js';
import { enqueueEmail } from './email/outbox.js';
import { conflict, notFound, badRequest } from '../utils/errors.js';

// ---------------------------------------------------------------- توحيد القيم
export const toLatinDigits = (s) =>
  String(s ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** آخر 9 أرقام من الهاتف (يتجاهل 00970 / +972 / 0) أو null */
export function phoneKey(p) {
  const d = toLatinDigits(p).replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-9) : null;
}

export function normName(s) {
  return String(s ?? '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const clean = (v, max = 300) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, max) : null;
};

/** يحوّل استجابة Google Forms إلى حقول طلب */
export function parseResponse(resp, questionMap) {
  const v = {};
  for (const [qid, ans] of Object.entries(resp.answers || {})) {
    const key = questionMap[qid];
    if (!key) continue;
    v[key] = (ans.textAnswers?.answers || []).map((a) => a.value).join(', ');
  }
  const genderRaw = clean(v.gender, 20) || '';
  const gender = /أنث|female/i.test(genderRaw) ? 'female' : /ذكر|male/i.test(genderRaw) ? 'male' : null;
  const bd = toLatinDigits(v.birth_date || '').trim();
  const parts = parseFloat(toLatinDigits(v.prior_parts || '').replace(/[٫,]/, '.'));
  const email = clean(v.email, 150);
  return {
    full_name: clean(v.full_name, 150) || 'بدون اسم',
    gender,
    birth_date: /^\d{4}-\d{2}-\d{2}$/.test(bd) && !Number.isNaN(Date.parse(bd)) ? bd : null,
    phone: clean(toLatinDigits(v.phone), 30),
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : null,
    guardian_name: clean(v.guardian_name, 150),
    guardian_phone: clean(toLatinDigits(v.guardian_phone), 30),
    address: clean(v.address, 300),
    prior_parts: Number.isFinite(parts) ? Math.min(30, Math.max(0, Math.round(parts * 100) / 100)) : null,
    notes: clean(v.notes, 2000),
    raw: v,
  };
}

/** يبحث عن طلب سابق أو طالب مسجّل بنفس الهاتف، أو بنفس الاسم وتاريخ الميلاد */
export async function detectDuplicate(db, app) {
  const pk = phoneKey(app.phone);
  const nk = normName(app.full_name);
  const { rows: apps } = await db.query(
    `select id, full_name, phone, birth_date from applications
     where id <> $1 and status <> 'rejected'
       and ((cast($2 as text) is not null and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 9) = $2)
            or (cast($3 as date) is not null and birth_date = $3))
     order by submitted_at limit 50`,
    [app.id, pk, app.birth_date]
  );
  for (const a of apps) {
    if (pk && phoneKey(a.phone) === pk && normName(a.full_name) === nk) {
      return { application: a.id, student: null, reason: `طلب سابق بنفس الاسم والهاتف (${a.full_name})` };
    }
    if (app.birth_date && a.birth_date === app.birth_date && normName(a.full_name) === nk) {
      return { application: a.id, student: null, reason: `طلب سابق بنفس الاسم وتاريخ الميلاد (${a.full_name})` };
    }
  }
  const { rows: studs } = await db.query(
    `select id, full_name, phone, guardian_phone, birth_date from students
     where status <> 'removed'
       and ((cast($1 as text) is not null and (right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 9) = $1
                                     or right(regexp_replace(coalesce(guardian_phone, ''), '\\D', '', 'g'), 9) = $1))
            or (cast($2 as date) is not null and birth_date = $2))
     limit 50`,
    [pk, app.birth_date]
  );
  for (const s of studs) {
    if (normName(s.full_name) === nk) return { application: null, student: s.id, reason: `طالب مسجّل مسبقًا: ${s.full_name}` };
  }
  // نفس الهاتف لاسم مختلف (قد يكون أخًا) — تنبيه فقط
  const samePhone = apps.find((a) => pk && phoneKey(a.phone) === pk);
  if (samePhone) return { application: samePhone.id, student: null, reason: `نفس رقم الهاتف في طلب آخر (${samePhone.full_name}) — قد يكون من نفس العائلة` };
  return null;
}

async function logEvent(db, appId, actor, action, fromStatus, toStatus, note = null) {
  await db.query(
    `insert into application_events (application_id, actor_id, actor_name, action, from_status, to_status, note)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [appId, actor?.id ?? null, actor?.full_name ?? 'النظام', action, fromStatus, toStatus, note]
  );
}

/** يستورد قائمة استجابات (من Google أو من الاختبارات). idempotent عبر unique(form_id, response_id) */
export async function importResponses(form, responses) {
  const imported = [];
  for (const resp of responses) {
    const f = parseResponse(resp, form.question_map || {});
    const row = await tx(async (c) => {
      const { rows } = await c.query(
        `insert into applications (form_id, response_id, submitted_at, full_name, gender, birth_date, phone, email,
                                   guardian_name, guardian_phone, address, prior_parts, notes, raw)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (form_id, response_id) do nothing returning *`,
        [
          form.id,
          resp.responseId,
          resp.lastSubmittedTime || resp.createTime || new Date().toISOString(),
          f.full_name,
          f.gender,
          f.birth_date,
          f.phone,
          f.email,
          f.guardian_name,
          f.guardian_phone,
          f.address,
          f.prior_parts,
          f.notes,
          JSON.stringify(f.raw),
        ]
      );
      if (!rows[0]) return null;
      const app = rows[0];
      const dup = await detectDuplicate(c, app);
      if (dup) {
        await c.query(
          `update applications set duplicate_of_application = $1, duplicate_of_student = $2, duplicate_reason = $3 where id = $4`,
          [dup.application, dup.student, dup.reason, app.id]
        );
        app.duplicate_reason = dup.reason;
      }
      await logEvent(c, app.id, null, 'imported', null, 'new', dup ? `تنبيه تكرار: ${dup.reason}` : 'استُورد من Google Forms');
      return app;
    });
    if (row) imported.push(row);
  }
  return imported;
}

async function notifyAdmissionStaff(count, formTitle, key) {
  if (!count) return;
  const { rows } = await query(`select id from users where is_active and role in ('registrar', 'admin')`);
  await tx(async (c) => {
    for (const u of rows) {
      await notifyUser(c, u.id, {
        type: 'new_applications',
        title: `${count} طلب التحاق جديد`,
        body: `من نموذج: ${formTitle}`,
        link: '/admissions',
        dedupeKey: `apps:${key}`,
      });
    }
  });
}

/** مزامنة نموذج واحد من Google */
export async function syncForm(formId) {
  const { rows } = await query(`select * from registration_forms where id = $1`, [formId]);
  const form = rows[0];
  if (!form) throw notFound('النموذج غير موجود');
  if (!form.google_form_id) throw badRequest('النموذج غير مرتبط بـ Google Forms');
  try {
    // تداخل دقيقة للأمان — التكرار مستحيل بفضل القيد الفريد
    const since = form.last_synced_at ? new Date(new Date(form.last_synced_at).getTime() - 60_000) : null;
    const responses = await listFormResponses(form.google_form_id, since);
    const imported = await importResponses(form, responses);
    let sheetError = null;
    if (imported.length && form.sheet_id) {
      try {
        await appendSheetRows(
          form.sheet_id,
          imported.map((a) => [
            new Date(a.submitted_at).toISOString(),
            a.response_id,
            ...ADMISSION_FIELDS.map((f) => (f.key === 'gender' ? (a.gender === 'female' ? 'أنثى' : a.gender === 'male' ? 'ذكر' : '') : a[f.key] ?? '')),
            a.duplicate_reason || '',
          ])
        );
      } catch (e) {
        sheetError = `تعذر تحديث جدول Google Sheets: ${e.message}`;
      }
    }
    const latest = responses.reduce((m, r) => {
      const t = r.lastSubmittedTime || r.createTime;
      return t && (!m || t > m) ? t : m;
    }, null);
    await query(
      `update registration_forms set last_synced_at = greatest(coalesce(last_synced_at, $2::timestamptz), coalesce($2::timestamptz, now())),
              last_sync_error = $3, synced_count = synced_count + $4 where id = $1`,
      [form.id, latest, sheetError, imported.length]
    );
    await notifyAdmissionStaff(imported.length, form.title, `${form.id}:${latest}`);
    return { imported: imported.length, fetched: responses.length, sheet_error: sheetError };
  } catch (err) {
    await query(`update registration_forms set last_sync_error = $2 where id = $1`, [form.id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

export async function syncAllForms() {
  if (!googleConfigured()) return { skipped: 'google_not_configured' };
  const { rowCount: connected } = await query(`select 1 from integration_secrets where key = 'google'`);
  if (!connected) return { skipped: 'google_not_connected' };
  const { rows } = await query(`select id from registration_forms where status = 'active' and google_form_id is not null`);
  const out = { forms: rows.length, imported: 0, errors: [] };
  for (const f of rows) {
    try {
      out.imported += (await syncForm(f.id)).imported;
    } catch (e) {
      out.errors.push(e.message);
    }
  }
  return out;
}

// ---------------------------------------------------------------- القرارات
async function lockApp(c, id) {
  const { rows } = await c.query(`select * from applications where id = $1 for update`, [id]);
  if (!rows[0]) throw notFound('الطلب غير موجود');
  return rows[0];
}

export async function markUnderReview(actor, id) {
  return tx(async (c) => {
    const a = await lockApp(c, id);
    if (a.status !== 'new') throw conflict('يمكن تحويل الطلبات الجديدة فقط إلى «قيد المراجعة»');
    await c.query(`update applications set status = 'under_review', updated_at = now() where id = $1`, [id]);
    await logEvent(c, id, actor, 'review', 'new', 'under_review');
  });
}

export async function addNote(actor, id, note) {
  return tx(async (c) => {
    const a = await lockApp(c, id);
    await c.query(
      `update applications set admission_notes = concat_ws(E'\\n', admission_notes, $2::text), updated_at = now() where id = $1`,
      [id, `[${actor.full_name}] ${note}`]
    );
    await logEvent(c, id, actor, 'note', a.status, a.status, note);
  });
}

/** قبول: إنشاء الطالب عبر نفس مسار إنشاء الطلاب، وتعيينه لمشرف */
export async function acceptApplication(actor, id, { supervisorId, note, gender, initialParts }) {
  return tx(async (c) => {
    const a = await lockApp(c, id);
    if (!['new', 'under_review'].includes(a.status)) throw conflict('تم البت في هذا الطلب مسبقًا');
    const studentId = await createStudent(
      c,
      actor,
      {
        full_name: a.full_name,
        gender: gender || a.gender || undefined,
        birth_date: a.birth_date,
        phone: a.phone,
        guardian_name: a.guardian_name,
        guardian_phone: a.guardian_phone,
        address: a.address,
        initial_parts: initialParts ?? a.prior_parts ?? 0,
        notes: a.notes ? `من طلب الالتحاق: ${a.notes}` : null,
      },
      { supervisorId, applicationId: a.id }
    );
    await c.query(
      `update applications set status = 'accepted', student_id = $2, assigned_supervisor_id = $3, decided_by = $4,
              decided_at = now(), updated_at = now() where id = $1`,
      [id, studentId, supervisorId, actor.id]
    );
    await logEvent(c, id, actor, 'accepted', a.status, 'accepted', note || null);

    const { rows: sup } = await c.query(`select user_id from supervisors where id = $1`, [supervisorId]);
    if (sup[0]) {
      await notifyUser(c, sup[0].user_id, {
        type: 'student_assigned',
        title: 'طالب جديد أُضيف إليك',
        body: `${a.full_name} — مقبول عبر التسجيل`,
        link: `/students/${studentId}`,
        dedupeKey: `assigned:${studentId}`,
      });
    }
    if (a.email) {
      await enqueueEmail(c, {
        to: a.email,
        template: 'admission_decision',
        data: { accepted: true, name: a.full_name, note: null },
        dedupeKey: `admission:${a.id}:accepted`,
      });
    }
    return studentId;
  });
}

export async function rejectApplication(actor, id, note) {
  return tx(async (c) => {
    const a = await lockApp(c, id);
    if (!['new', 'under_review'].includes(a.status)) throw conflict('تم البت في هذا الطلب مسبقًا');
    await c.query(
      `update applications set status = 'rejected', decided_by = $2, decided_at = now(), updated_at = now() where id = $1`,
      [id, actor.id]
    );
    await logEvent(c, id, actor, 'rejected', a.status, 'rejected', note || null);
    if (a.email) {
      await enqueueEmail(c, {
        to: a.email,
        template: 'admission_decision',
        data: { accepted: false, name: a.full_name, note: null },
        dedupeKey: `admission:${a.id}:rejected`,
      });
    }
  });
}
