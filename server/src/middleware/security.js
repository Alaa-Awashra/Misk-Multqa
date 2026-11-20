// طبقات حماية إضافية خفيفة: CSRF (التحقق من المصدر)، HTTPS، Permissions-Policy
import { config } from '../config.js';
import { HttpError } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
};

/** المضيفات المسموح لها بإرسال طلبات معدِّلة مع كوكي الجلسة */
function allowedHosts(req) {
  const hosts = new Set();
  const own = String(req.get('host') || '').toLowerCase();
  if (own) hosts.add(own);
  const app = hostOf(config.appUrl);
  if (app) hosts.add(app);
  for (const o of String(config.clientOrigin || '').split(',')) {
    const h = hostOf(o.trim());
    if (h) hosts.add(h);
  }
  return hosts;
}

/**
 * حماية CSRF دفاعية (إضافة إلى كوكي SameSite=Lax):
 * كل طلب يغيّر البيانات من متصفح يجب أن يأتي من نفس الموقع.
 * - Origin موجود ولا يطابق موقعنا ← رفض.
 * - بلا Origin لكن Sec-Fetch-Site = cross-site ← رفض.
 * - بلا أي منهما (أدوات سطر الأوامر، Supabase Cron، الاختبارات) ← مسموح؛ فهي لا تحمل كوكي المتصفح تلقائيًا.
 */
export function csrfOriginCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    if (!allowedHosts(req).has(hostOf(origin))) return next(new HttpError(403, 'طلب مرفوض من مصدر غير موثوق', 'BAD_ORIGIN'));
    return next();
  }
  if (origin === 'null' || req.get('sec-fetch-site') === 'cross-site') {
    return next(new HttpError(403, 'طلب مرفوض من مصدر غير موثوق', 'BAD_ORIGIN'));
  }
  next();
}

/**
 * في الإنتاج: تحويل أي طلب وصل عبر HTTP (حسب X-Forwarded-Proto من Render) إلى HTTPS.
 * Render يحوّل تلقائيًا أيضًا؛ هذه طبقة احتياطية. فحوصات الصحة الداخلية (بلا الترويسة) لا تتأثر.
 */
export function enforceHttps(req, res, next) {
  if (!config.isProd || req.get('x-forwarded-proto') !== 'http') return next();
  const host = hostOf(config.appUrl) || req.get('host');
  if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(301, `https://${host}${req.originalUrl}`);
  return next(new HttpError(403, 'يجب استخدام اتصال آمن (HTTPS)', 'HTTPS_REQUIRED'));
}

/** تعطيل صلاحيات المتصفح غير المستخدمة في المنصة */
export function permissionsPolicy(req, res, next) {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()'
  );
  next();
}

/** استجابات الـ API تحتوي بيانات خاصة: لا تُخزَّن في ذاكرة المتصفح أو الوسطاء */
export function noStoreApi(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
