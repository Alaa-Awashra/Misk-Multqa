// الإعلانات والتعاميم
//   المسؤول: إنشاء/تعديل/حذف + سجل التسليم
//   المشرفون / مشرفو التسجيل: يرون فقط ما يخص دورهم (لا يوجد دخول للطلاب في النظام أصلًا)
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, tx } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { notFound, uuidParam } from '../utils/errors.js';
import { parse, z, reqText } from '../utils/validate.js';
import { logActivity } from '../services/activity.js';
import { notifyUser } from '../services/notify.js';

const router = Router();
router.param('id', uuidParam);

export const CATEGORY_LABEL = {
  schedule: 'جدول التسميع',
  meeting: 'اجتماع إداري',
  important: 'إعلان مهم',
  policy: 'تحديث سياسات',
  instructions: 'تعليمات',
  urgent: 'تنبيه عاجل',
};

/** الجماهير المسموح بها لكل دور */
const audiencesFor = (role) => (role === 'supervisor' ? ['supervisors', 'staff'] : role === 'registrar' ? ['registrars', 'staff'] : null);

const VISIBLE = `a.deleted_at is null and a.published_at <= now() and (a.expires_at is null or a.expires_at > now())`;

router.get('/', async (req, res) => {
  if (req.user.role === 'admin') {
    const { rows } = await query(
      `select a.*, u.full_name as created_by_name,
              (a.expires_at is not null and a.expires_at <= now()) as expired,
              (select count(*) from announcement_reads r where r.announcement_id = a.id)::int as reads,
              (select count(*) from email_outbox e where e.dedupe_key like 'announcement:ann:' || a.id || ':%' and e.status = 'sent')::int as emails_sent,
              (select count(*) from email_outbox e where e.dedupe_key like 'announcement:ann:' || a.id || ':%')::int as emails_total
       from announcements a left join users u on u.id = a.created_by
       where a.deleted_at is null order by a.pinned desc, a.published_at desc limit 300`
    );
    return res.json({ announcements: rows });
  }
  const { rows } = await query(
    `select a.id, a.title, a.body, a.category, a.audience, a.pinned, a.event_at, a.published_at, a.expires_at,
            r.read_at
     from announcements a
     left join announcement_reads r on r.announcement_id = a.id and r.user_id = $1
     where ${VISIBLE} and a.audience = any($2::text[])
     order by a.pinned desc, a.published_at desc limit 200`,
    [req.user.id, audiencesFor(req.user.role)]
  );
  res.json({ announcements: rows });
});

router.post('/:id/read', async (req, res) => {
  const aud = audiencesFor(req.user.role);
  if (aud) {
    const { rowCount } = await query(`select 1 from announcements a where a.id = $1 and ${VISIBLE} and a.audience = any($2::text[])`, [
      req.params.id,
      aud,
    ]);
    if (!rowCount) throw notFound('الإعلان غير موجود');
  }
  await query(
    `insert into announcement_reads (announcement_id, user_id) values ($1, $2) on conflict do nothing`,
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------- إدارة (للمسؤول فقط)
const optTs = z.preprocess((v) => (v === '' ? null : v), z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'تاريخ غير صالح').nullable().optional());

const schema = z.object({
  title: reqText('العنوان', 200),
  body: reqText('الوصف', 10000),
  category: z.enum(Object.keys(CATEGORY_LABEL), { errorMap: () => ({ message: 'اختر التصنيف' }) }),
  audience: z.enum(['supervisors', 'registrars', 'staff']).default('supervisors'),
  pinned: z.boolean().default(false),
  event_at: optTs,
  published_at: optTs,
  expires_at: optTs,
  send_email: z.boolean().default(true),
});

// حماية من الإرسال الجماعي المفرط
const publishLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 20,
  keyGenerator: (req) => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تجاوزت الحد المسموح لنشر الإعلانات خلال ساعة', code: 'RATE_LIMIT' },
});

async function recipients(db, audience) {
  const roles = audience === 'staff' ? ['supervisor', 'registrar'] : audience === 'registrars' ? ['registrar'] : ['supervisor'];
  const { rows } = await db.query(
    `select u.id from users u left join supervisors sp on sp.user_id = u.id
     where u.is_active and u.role = any($1::text[]) and (u.role <> 'supervisor' or sp.status = 'active')`,
    [roles]
  );
  return rows.map((r) => r.id);
}

/** يرسل الإشعارات والبريد مرة واحدة فقط لكل إعلان ولكل مستلم (dedupe) */
async function deliver(c, a) {
  const ids = await recipients(c, a.audience);
  let notified = 0;
  for (const uid of ids) {
    const created = await notifyUser(
      c,
      uid,
      {
        type: 'announcement',
        title: `${a.category === 'urgent' ? 'عاجل: ' : ''}${a.title}`,
        body: CATEGORY_LABEL[a.category],
        link: '/announcements',
        dedupeKey: `ann:${a.id}`,
      },
      a.send_email
        ? {
            template: 'announcement',
            data: { title: a.title, body: a.body, category: CATEGORY_LABEL[a.category], event_at: a.event_at, urgent: a.category === 'urgent' },
          }
        : null
    );
    if (created) notified++;
  }
  await c.query(`update announcements set email_enqueued_at = coalesce(email_enqueued_at, now()) where id = $1`, [a.id]);
  return { recipients: ids.length, notified };
}

router.post('/', requireAdmin, publishLimiter, async (req, res) => {
  const b = parse(schema, req.body);
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `insert into announcements (title, body, category, audience, pinned, event_at, published_at, expires_at, send_email, created_by)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), $8, $9, $10)
       returning *, (published_at <= now()) as due`,
      [b.title, b.body, b.category, b.audience, b.pinned, b.event_at ?? null, b.published_at ?? null, b.expires_at ?? null, b.send_email, req.user.id]
    );
    const a = rows[0];
    await logActivity(c, req.user, 'announcement.create', 'announcement', a.id, a.title, { audience: a.audience });
    // المنشور الآن يُسلَّم فورًا؛ المجدول للمستقبل يُسلَّم عند حلول وقته (المهمة المجدولة)
    // "مستحق الآن" يُحسب داخل قاعدة البيانات (ساعة واحدة) لتجنب فرق التوقيت بين الخادم وقاعدة البيانات
    const delivery = a.due ? await deliver(c, a) : null;
    return { announcement: a, delivery };
  });
  res.status(201).json(out);
});

router.put('/:id', requireAdmin, async (req, res) => {
  const b = parse(schema, req.body);
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `update announcements set title = $2, body = $3, category = $4, audience = $5, pinned = $6, event_at = $7,
              published_at = coalesce($8::timestamptz, published_at), expires_at = $9, send_email = $10, updated_at = now()
       where id = $1 and deleted_at is null returning *, (published_at <= now()) as due`,
      [req.params.id, b.title, b.body, b.category, b.audience, b.pinned, b.event_at ?? null, b.published_at ?? null, b.expires_at ?? null, b.send_email]
    );
    if (!rows[0]) throw notFound('الإعلان غير موجود');
    await logActivity(c, req.user, 'announcement.update', 'announcement', rows[0].id, rows[0].title);
    // تغيير الجمهور يوصل الإعلان للمستلمين الجدد فقط (لا تكرار للسابقين)
    if (rows[0].due) await deliver(c, rows[0]);
    return rows[0];
  });
  res.json({ announcement: out });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `update announcements set deleted_at = now() where id = $1 and deleted_at is null returning title`,
    [req.params.id]
  );
  if (!rows[0]) throw notFound('الإعلان غير موجود');
  await logActivity({ query }, req.user, 'announcement.delete', 'announcement', req.params.id, rows[0].title);
  res.json({ ok: true });
});

router.get('/:id/deliveries', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `select e.id, e.to_email, e.status, e.attempts, e.last_error, e.sent_at, e.created_at, u.full_name
     from email_outbox e left join users u on u.id = e.to_user_id
     where e.dedupe_key like 'announcement:ann:' || $1 || ':%' order by e.id`,
    [req.params.id]
  );
  const { rows: reads } = await query(
    `select u.full_name, r.read_at from announcement_reads r join users u on u.id = r.user_id where r.announcement_id = $1 order by r.read_at`,
    [req.params.id]
  );
  res.json({ emails: rows, reads });
});

/** للمهمة المجدولة: تسليم الإعلانات المجدولة التي حان وقتها */
export async function deliverScheduledAnnouncements() {
  const { rows } = await query(
    `select * from announcements where deleted_at is null and email_enqueued_at is null and published_at <= now()
       and (expires_at is null or expires_at > now())`
  );
  let delivered = 0;
  for (const a of rows) {
    await tx((c) => deliver(c, a));
    delivered++;
  }
  return { delivered };
}

export default router;
