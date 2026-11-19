// الإشعارات الداخلية + ملخص العدّادات (يُستطلع دوريًا من الواجهة)
import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const { rows } = await query(
    `select id, type, title, body, link, read_at, created_at from notifications
     where user_id = $1 order by id desc limit $2`,
    [req.user.id, limit]
  );
  res.json({ notifications: rows });
});

/** كل العدّادات في طلب واحد خفيف */
router.get('/summary', async (req, res) => {
  const uid = req.user.id;
  const role = req.user.role;
  const { rows } = await query(
    `select
       (select count(*) from notifications where user_id = $1 and read_at is null)::int as notifications,
       (select count(*) from conversations c
          where (${role === 'admin' ? 'true' : 'c.owner_id = $1'})
            and exists (select 1 from conversation_messages m where m.conversation_id = c.id
                          and m.sender_id is distinct from $1
                          and m.created_at > coalesce((select last_read_at from conversation_reads r
                                                       where r.conversation_id = c.id and r.user_id = $1), '-infinity')))::int as messages,
       (select count(*) from announcements a
          where a.deleted_at is null and a.published_at <= now() and (a.expires_at is null or a.expires_at > now())
            and a.audience = any($2::text[])
            and not exists (select 1 from announcement_reads r where r.announcement_id = a.id and r.user_id = $1))::int as announcements,
       ${role === 'admin' ? `(select count(*) from student_requests where status = 'pending')::int` : '0'} as requests,
       ${role === 'admin' || role === 'registrar' ? `(select count(*) from applications where status = 'new')::int` : '0'} as applications`,
    [uid, role === 'supervisor' ? ['supervisors', 'staff'] : role === 'registrar' ? ['registrars', 'staff'] : []]
  );
  res.json(rows[0]);
});

router.post('/:id/read', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.json({ ok: true });
  await query(`update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null`, [req.params.id, req.user.id]);
  res.json({ ok: true });
});

router.post('/read-all', async (req, res) => {
  await query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [req.user.id]);
  res.json({ ok: true });
});

export default router;
