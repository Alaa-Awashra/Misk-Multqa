import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { HttpError } from '../utils/errors.js';
import { parse, z, reqText } from '../utils/validate.js';
import {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  authenticate,
  shapeUser,
  accessBlockReason,
  USER_SQL,
} from '../middleware/auth.js';
import { confirmEmailToken } from '../services/emailVerification.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.', code: 'RATE_LIMIT' },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة. حاول لاحقًا.', code: 'RATE_LIMIT' },
});

const loginSchema = z.object({
  username: reqText('اسم المستخدم', 100),
  password: z.string({ required_error: 'كلمة المرور مطلوبة' }).min(1, 'كلمة المرور مطلوبة').max(200),
});

// هاش وهمي لتقليل الفارق الزمني عند اسم مستخدم غير موجود
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = parse(loginSchema, req.body);
  const { rows } = await query(
    `select x.*, p.password_hash from (${USER_SQL} where lower(u.username) = lower($1)) x
     join users p on p.id = x.id`,
    [username]
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة', 'BAD_CREDENTIALS');
  const blocked = accessBlockReason(user);
  if (blocked) throw new HttpError(403, blocked, 'SUSPENDED');
  setAuthCookie(res, signToken(user.id));
  res.json({ user: shapeUser(user) });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------- تأكيد ملكية البريد الإلكتروني (رابط من البريد)
router.post('/verify-email', verifyLimiter, async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
  res.json(await confirmEmailToken(token));
});

export default router;
