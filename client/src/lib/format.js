import { DateTime } from 'luxon';

// كل التواريخ تُعرض وتُدخَل بتوقيت المنتدى (Asia/Hebron) بغض النظر عن توقيت جهاز المستخدم
export const APP_TZ = 'Asia/Hebron';

// أرقام لاتينية (0-9) مع أسماء الأشهر الفلسطينية، مثل التقارير الورقية
const LOCALE = 'ar-PS-u-nu-latn';

const safe = (fn) => {
  try {
    return fn();
  } catch {
    return '';
  }
};

const fmt = (opts) => new Intl.DateTimeFormat(LOCALE, { timeZone: APP_TZ, ...opts });
const dateFmt = fmt({ day: 'numeric', month: 'long', year: 'numeric' });
const dateShortFmt = fmt({ day: 'numeric', month: 'short' });
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit', hour12: true });
const weekdayFmt = fmt({ weekday: 'long' });
const monthFmt = fmt({ month: 'long', year: 'numeric' });

// تاريخ بلا وقت (YYYY-MM-DD) يُعامل كمنتصف النهار UTC حتى لا ينزاح اليوم
const toDate = (v) => (v instanceof Date ? v : new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v));

export const fmtDate = (v) => (v ? safe(() => dateFmt.format(toDate(v))) : '—');
export const fmtDateShort = (v) => (v ? safe(() => dateShortFmt.format(toDate(v))) : '—');
export const fmtTime = (v) => (v ? safe(() => timeFmt.format(toDate(v))) : '—');
export const fmtWeekday = (v) => (v ? safe(() => weekdayFmt.format(toDate(v))) : '');
export const fmtMonth = (v) => (v ? safe(() => monthFmt.format(toDate(v))) : '');
export const fmtDateTime = (v) => (v ? `${fmtDate(v)} • ${fmtTime(v)}` : '—');
/** التاريخ بصيغة ISO مثل التقارير: 2026-10-07 */
export const fmtIso = (v) => (v ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : localISODate(toDate(v))) : '—');

export function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || n === '') return '—';
  return String(parseFloat(Number(n).toFixed(digits)));
}

export const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}%`);

export const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD بتوقيت المنتدى */
export const localISODate = (d = new Date()) => DateTime.fromJSDate(toDate(d)).setZone(APP_TZ).toISODate();
/** HH:MM بتوقيت المنتدى */
export const localHM = (d) => DateTime.fromJSDate(toDate(d)).setZone(APP_TZ).toFormat('HH:mm');

export function addDaysISO(iso, n) {
  return DateTime.fromISO(iso, { zone: 'UTC' }).plus({ days: n }).toISODate();
}

export const monthStartISO = () => `${localISODate().slice(0, 7)}-01`;

export function lastMonthRange() {
  const first = DateTime.now().setZone(APP_TZ).startOf('month').minus({ months: 1 });
  return { from: first.toISODate(), to: first.endOf('month').toISODate() };
}

/** من تاريخ + وقت بتوقيت المنتدى إلى ISO UTC */
export const toISO = (dateStr, timeStr) => DateTime.fromISO(`${dateStr}T${timeStr}`, { zone: APP_TZ }).toUTC().toISO();

export function age(birthDate) {
  if (!birthDate) return null;
  const b = DateTime.fromISO(birthDate);
  return Math.floor(DateTime.now().setZone(APP_TZ).diff(b, 'years').years);
}

/** توحيد النص العربي للبحث (أ/إ/آ → ا ، ى → ي ، ة → ه ، إزالة التشكيل) */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

export function relativeDays(v) {
  if (!v) return null;
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000);
  if (days <= 0) return 'اليوم';
  if (days === 1) return 'أمس';
  return `منذ ${days} يومًا`;
}

export function relativeTime(v) {
  if (!v) return '';
  const mins = Math.floor((Date.now() - new Date(v).getTime()) / 60_000);
  if (mins < 1) return 'الآن';
  if (mins < 60) return `قبل ${mins} د`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `قبل ${h} س`;
  return fmtDateShort(v);
}
