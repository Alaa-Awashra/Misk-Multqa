// إدارة حسابات مشرفي التسجيل والقبول (للمسؤول فقط)
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query, tx } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { notFound, conflict, uuidParam } from '../utils/errors.js';
import { parse, z, reqText, optPhone } from '../utils/validate.js';
import { encrypt, decrypt, generatePassword } from '../utils/crypto.js';
import { logActivity } from '../services/activity.js';
import { assertEmailAvailable, normalizeEmail, setUserEmail, startEmailVerification } from '../services/emailVerification.js';

const router = Router();
router.use(requireAdmin);
router.param('id', uuidParam);

const SELECT = `select id, username, full_name, phone, email, email_verified_at, is_active, created_at, password_enc
                from users where role = 'registrar'`;

async function load(id) {
  const { rows } = await query(`${SELECT} and id = $1`, [id]);
  if (!rows[0]) throw notFound('الحساب غير موجود');
  return rows[0];
}

const shape = ({ password_enc, ...r }) => ({ ...r, password: decrypt(password_enc) });

router.get('/', async (req, res) => {
  const { rows } = await query(`${SELECT} order by full_name`);
  res.json({ staff: rows.map(shape) });
});

const schema = z.object({
  full_name: reqText('الاسم', 120),
  phone: optPhone,
  email: z.string({ required_error: 'البريد الإلكتروني مطلوب' }).trim().email('البريد الإلكتروني غير صالح').max(150),
});

async function uniqueUsername(c) {
  for (let i = 0; i < 20; i++) {
    const u = `r${crypto.randomInt(10000, 100000)}`;
    const { rowCount } = await c.query('select 1 from users where lower(username) = $1', [u]);
    if (!rowCount) return u;
  }
  throw new Error('تعذر توليد اسم مستخدم فريد');
}

router.post('/', async (req, res) => {
  const b = parse(schema, req.body);
  const email = normalizeEmail(b.email);
  const out = await tx(async (c) => {
    await assertEmailAvailable(c, email);
    const username = await uniqueUsername(c);
    const password = generatePassword();
    const { rows } = await c.query(
      `insert into users (username, password_hash, password_enc, role, full_name, phone, email)
       values ($1, $2, $3, 'registrar', $4, $5, $6) returning id`,
      [username, await bcrypt.hash(password, 10), encrypt(password), b.full_name, b.phone ?? null, email]
    );
    await logActivity(c, req.user, 'staff.create', 'staff', rows[0].id, b.full_name, { role: 'registrar' });
    await startEmailVerification(c, rows[0].id);
    return { id: rows[0].id, username, password };
  });
  res.status(201).json(out);
});

router.put('/:id', async (req, res) => {
  const b = parse(schema, req.body);
  const u = await load(req.params.id);
  await tx(async (c) => {
    await c.query('update users set full_name = $1, phone = $2 where id = $3', [b.full_name, b.phone ?? null, u.id]);
    const { changed } = await setUserEmail(c, u.id, b.email);
    if (changed) await startEmailVerification(c, u.id);
    await logActivity(c, req.user, 'staff.update', 'staff', u.id, b.full_name);
  });
  res.json({ staff: shape(await load(u.id)) });
});

router.post('/:id/active', async (req, res) => {
  const { active } = parse(z.object({ active: z.boolean() }), req.body);
  const u = await load(req.params.id);
  if (u.is_active === active) throw conflict(active ? 'الحساب مفعّل بالفعل' : 'الحساب موقوف بالفعل');
  await tx(async (c) => {
    await c.query('update users set is_active = $1 where id = $2', [active, u.id]);
    await logActivity(c, req.user, active ? 'staff.activate' : 'staff.deactivate', 'staff', u.id, u.full_name);
  });
  res.json({ staff: shape(await load(u.id)) });
});

router.post('/:id/reset-password', async (req, res) => {
  const u = await load(req.params.id);
  const password = generatePassword();
  await tx(async (c) => {
    await c.query('update users set password_hash = $1, password_enc = $2 where id = $3', [await bcrypt.hash(password, 10), encrypt(password), u.id]);
    await logActivity(c, req.user, 'staff.reset_password', 'staff', u.id, u.full_name);
  });
  res.json({ username: u.username, password });
});

export default router;
