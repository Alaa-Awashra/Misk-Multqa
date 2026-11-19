// التواصل مع الإدارة — محادثات خاصة بين المشرف والإدارة
// المشرف يرى محادثاته فقط؛ المسؤول يرى الكل. التحديث شبه الفوري عبر الاستطلاع (polling) من الواجهة.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, tx } from '../db.js';
import { notFound, forbidden, uuidParam } from '../utils/errors.js';
import { parse, z, reqText } from '../utils/validate.js';
import { notifyUser, notifyAdmins } from '../services/notify.js';
import { logActivity } from '../services/activity.js';

const router = Router();
router.param('id', uuidParam);

const isAdmin = (req) => req.user.role === 'admin';
const CATEGORIES = ['question', 'complaint', 'suggestion', 'request', 'other'];
const STATUSES = ['open', 'in_progress', 'closed'];

const sendLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: (req) => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'رسائل كثيرة خلال وقت قصير. انتظر قليلًا.', code: 'RATE_LIMIT' },
});

/** يحمّل المحادثة ويتحقق من الصلاحية (منع الوصول لمحادثات مشرف آخر) */
async function loadConv(req, id, db = { query }) {
  const { rows } = await db.query(
    `select c.*, u.full_name as owner_name, u.role as owner_role from conversations c join users u on u.id = c.owner_id where c.id = $1`,
    [id]
  );
  const c = rows[0];
  if (!c || (!isAdmin(req) && c.owner_id !== req.user.id)) throw notFound('المحادثة غير موجودة');
  return c;
}

const unreadSql = `(select count(*) from conversation_messages m
   where m.conversation_id = c.id and m.sender_id is distinct from $1
     and m.created_at > coalesce((select last_read_at from conversation_reads r where r.conversation_id = c.id and r.user_id = $1), '-infinity'))::int`;

router.get('/conversations', async (req, res) => {
  const params = [req.user.id];
  const where = [];
  if (!isAdmin(req)) where.push('c.owner_id = $1');
  if (STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`c.status = $${params.length}`);
  }
  const { rows } = await query(
    `select c.id, c.subject, c.category, c.status, c.created_at, c.last_message_at, u.full_name as owner_name, u.role as owner_role,
            ${unreadSql} as unread,
            (select body from conversation_messages m where m.conversation_id = c.id order by m.id desc limit 1) as last_body
     from conversations c join users u on u.id = c.owner_id
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by c.last_message_at desc limit 300`,
    params
  );
  res.json({ conversations: rows });
});

router.post('/conversations', sendLimiter, async (req, res) => {
  if (isAdmin(req)) throw forbidden('تبدأ المحادثات من المشرفين؛ يمكنك الرد على أي محادثة');
  const b = parse(
    z.object({
      subject: reqText('الموضوع', 150),
      category: z.enum(CATEGORIES).default('question'),
      body: reqText('نص الرسالة', 5000),
    }),
    req.body
  );
  const id = await tx(async (c) => {
    const { rows } = await c.query(
      `insert into conversations (owner_id, subject, category) values ($1, $2, $3) returning id`,
      [req.user.id, b.subject, b.category]
    );
    const conv = rows[0].id;
    const m = await c.query(
      `insert into conversation_messages (conversation_id, sender_id, sender_name, sender_role, body) values ($1, $2, $3, $4, $5) returning id`,
      [conv, req.user.id, req.user.full_name, req.user.role, b.body]
    );
    await c.query(`insert into conversation_reads (conversation_id, user_id) values ($1, $2)`, [conv, req.user.id]);
    await notifyAdmins(c, {
      type: 'message',
      title: `رسالة جديدة من ${req.user.full_name}`,
      body: b.subject,
      link: `/messages/${conv}`,
      dedupeKey: `msg:${m.rows[0].id}`,
    });
    return conv;
  });
  res.status(201).json({ id });
});

router.get('/conversations/:id', async (req, res) => {
  const conv = await loadConv(req, req.params.id);
  const after = /^\d+$/.test(req.query.after || '') ? req.query.after : '0';
  const { rows: messages } = await query(
    `select id, sender_id, sender_name, sender_role, body, created_at from conversation_messages
     where conversation_id = $1 and id > $2 order by id`,
    [conv.id, after]
  );
  await query(
    `insert into conversation_reads (conversation_id, user_id, last_read_at) values ($1, $2, now())
     on conflict (conversation_id, user_id) do update set last_read_at = now()`,
    [conv.id, req.user.id]
  );
  // وقت آخر قراءة للطرف الآخر (لإظهار "مقروءة")
  const { rows: other } = await query(
    `select max(r.last_read_at) as t from conversation_reads r join users u on u.id = r.user_id
     where r.conversation_id = $1 and r.user_id <> $2 and ${isAdmin(req) ? 'r.user_id = $3' : "u.role = 'admin'"}`,
    isAdmin(req) ? [conv.id, req.user.id, conv.owner_id] : [conv.id, req.user.id]
  );
  res.json({ conversation: conv, messages, other_last_read_at: other[0]?.t || null });
});

router.post('/conversations/:id/messages', sendLimiter, async (req, res) => {
  const { body } = parse(z.object({ body: reqText('نص الرسالة', 5000) }), req.body);
  const msg = await tx(async (c) => {
    const conv = await loadConv(req, req.params.id, c);
    let status = conv.status;
    if (isAdmin(req) && status === 'open') status = 'in_progress';
    if (!isAdmin(req) && status === 'closed') status = 'open'; // رد المشرف يعيد فتح المحادثة
    const { rows } = await c.query(
      `insert into conversation_messages (conversation_id, sender_id, sender_name, sender_role, body)
       values ($1, $2, $3, $4, $5) returning id, sender_id, sender_name, sender_role, body, created_at`,
      [conv.id, req.user.id, req.user.full_name, req.user.role, body]
    );
    await c.query(`update conversations set last_message_at = now(), updated_at = now(), status = $2 where id = $1`, [conv.id, status]);
    await c.query(
      `insert into conversation_reads (conversation_id, user_id, last_read_at) values ($1, $2, now())
       on conflict (conversation_id, user_id) do update set last_read_at = now()`,
      [conv.id, req.user.id]
    );
    const n = {
      type: 'message',
      title: isAdmin(req) ? 'رد جديد من الإدارة' : `رسالة جديدة من ${req.user.full_name}`,
      body: conv.subject,
      link: `/messages/${conv.id}`,
      dedupeKey: `msg:${rows[0].id}`,
    };
    if (isAdmin(req)) await notifyUser(c, conv.owner_id, n);
    else await notifyAdmins(c, n);
    return rows[0];
  });
  res.status(201).json({ message: msg });
});

router.post('/conversations/:id/status', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(STATUSES) }), req.body);
  const conv = await loadConv(req, req.params.id);
  // المشرف يستطيع إغلاق محادثته فقط؛ المسؤول يغيّر أي حالة
  if (!isAdmin(req) && status !== 'closed') throw forbidden('يمكنك إغلاق المحادثة فقط');
  await tx(async (c) => {
    await c.query(`update conversations set status = $2, updated_at = now() where id = $1`, [conv.id, status]);
    await logActivity(c, req.user, 'conversation.status', 'conversation', conv.id, conv.subject, { status });
    if (isAdmin(req) && status !== conv.status) {
      await notifyUser(c, conv.owner_id, {
        type: 'conversation_status',
        title: `تغيّرت حالة محادثتك: ${{ open: 'مفتوحة', in_progress: 'قيد المعالجة', closed: 'مغلقة' }[status]}`,
        body: conv.subject,
        link: `/messages/${conv.id}`,
        dedupeKey: `conv_status:${conv.id}:${status}:${Date.now()}`,
      });
    }
  });
  res.json({ ok: true });
});

export default router;
