import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { HttpError, forbidden } from '../utils/errors.js';

export const COOKIE_NAME = 'mq_token';

export const ROLES = ['admin', 'supervisor', 'registrar'];

export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

/**
 * رمز الجلسة: typ يميّزه عن أي رمز آخر، و sv = رقم إصدار جلسات المستخدم
 * (يُرفع عند تغيير كلمة المرور أو إعادة تعيينها أو إيقاف الحساب ← تبطل كل الجلسات السابقة).
 */
export function signToken(userId, sessionVersion = 0) {
  return jwt.sign({ sub: userId, typ: 'session', sv: sessionVersion }, config.jwtSecret, {
    expiresIn: SESSION_TTL_SECONDS,
    algorithm: 'HS256',
  });
}

/** يُبطل كل جلسات المستخدم الحالية (داخل نفس transaction الإجراء) ويعيد رقم الإصدار الجديد */
export async function revokeSessions(db, userId) {
  const { rows } = await db.query(
    'update users set session_version = session_version + 1 where id = $1 returning session_version',
    [userId]
  );
  return rows[0]?.session_version ?? null;
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

export const clearAuthCookie = (res) =>
  res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProd });

export const USER_SQL = `
  select u.id, u.username, u.role, u.full_name, u.phone, u.email, u.email_verified_at, u.is_active, u.session_version,
         sp.id as supervisor_id, sp.supervisor_type, sp.status as supervisor_status
  from users u
  left join supervisors sp on sp.user_id = u.id`;

export function shapeUser(r) {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    full_name: r.full_name,
    phone: r.phone,
    email: r.email,
    email_verified: !!r.email_verified_at,
    supervisor_id: r.supervisor_id || null,
    supervisor_type: r.supervisor_type || null,
  };
}

/** سبب منع الدخول (حساب موقوف/مفصول) أو null */
export function accessBlockReason(u) {
  if (u.is_active === false) return 'تم إيقاف حسابك. تواصل مع الإدارة.';
  if (u.role === 'supervisor' && u.supervisor_status === 'suspended') return 'تم إيقاف حسابك. تواصل مع الإدارة.';
  if (u.role === 'supervisor' && !u.supervisor_id) return 'الحساب غير مكتمل. تواصل مع الإدارة.';
  return null;
}

/** يتحقق من الجلسة ويحمّل المستخدم في كل طلب (لضمان أثر الفصل/الحذف فورًا) */
export async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  const token = req.cookies?.[COOKIE_NAME] || (header?.startsWith('Bearer ') ? header.slice(7) : null);
  if (!token) return next(new HttpError(401, 'يرجى تسجيل الدخول', 'UNAUTHENTICATED'));

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return next(new HttpError(401, 'انتهت الجلسة، يرجى تسجيل الدخول من جديد', 'UNAUTHENTICATED'));
  }
  // رموز الجلسة فقط: الرموز القديمة بلا typ مقبولة (توافق مع الجلسات الحالية)، أما أي رمز لغرض آخر فمرفوض
  if ((payload.typ !== undefined && payload.typ !== 'session') || payload.p !== undefined || typeof payload.sub !== 'string') {
    return next(new HttpError(401, 'انتهت الجلسة، يرجى تسجيل الدخول من جديد', 'UNAUTHENTICATED'));
  }

  const { rows } = await query(`${USER_SQL} where u.id = $1`, [payload.sub]);
  const user = rows[0];
  if (!user) return next(new HttpError(401, 'الحساب غير موجود', 'UNAUTHENTICATED'));
  // جلسة صادرة قبل تغيير كلمة المرور أو إعادة تعيينها أو إيقاف الحساب
  if ((Number(payload.sv) || 0) !== (Number(user.session_version) || 0)) {
    clearAuthCookie(res);
    return next(new HttpError(401, 'انتهت الجلسة، يرجى تسجيل الدخول من جديد', 'UNAUTHENTICATED'));
  }
  const blocked = accessBlockReason(user);
  if (blocked) return next(new HttpError(403, blocked, 'SUSPENDED'));
  req.user = { ...shapeUser(user) };
  next();
}

/** يسمح فقط للأدوار المحددة — يُطبَّق على مستوى الخادم لكل مسار محمي */
export const allowRoles =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user?.role) ? next() : next(forbidden('ليست لديك صلاحية للوصول إلى هذه الصفحة'));

export const requireAdmin = (req, res, next) =>
  req.user?.role === 'admin' ? next() : next(forbidden('هذه الصفحة للمسؤول الإداري فقط'));

export const requireSupervisor = (req, res, next) =>
  req.user?.role === 'supervisor' && req.user.supervisor_id ? next() : next(forbidden('هذا الإجراء للمشرفين فقط'));
