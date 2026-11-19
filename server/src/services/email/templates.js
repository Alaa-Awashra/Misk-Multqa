// قوالب البريد العربية (HTML متجاوب + نص بديل)
// ملاحظة أمنية: لا تُرسل بيانات حساسة للطلاب ولا كلمات مرور عبر البريد.
import { config } from '../../config.js';

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br>');

const FORUM = 'ملتقى المسك القرآني';

function fmtDateTime(v) {
  if (!v) return '';
  try {
    return new Intl.DateTimeFormat('ar-PS-u-nu-latn', {
      timeZone: config.timezone,
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(new Date(v));
  } catch {
    return String(v);
  }
}

const link = (path) => (path ? (/^https?:/.test(path) ? path : `${config.appUrl}${path}`) : null);

/**
 * يبني رسالة كاملة من أجزاء: عنوان، فقرات، صناديق معلومات، زر
 * parts: { heading, intro, rows: [[label, value]], body, tone, cta: {label, url}, footnote }
 */
function layout(parts) {
  const tone = { danger: '#c0392b', warn: '#c77d06', success: '#1e8a4c', info: '#0f5c4d' }[parts.tone || 'info'];
  const rowsHtml = (parts.rows || [])
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#6b7776;white-space:nowrap;vertical-align:top;padding-left:12px">${esc(k)}</td><td style="padding:6px 0;color:#1f2a2a;font-weight:600">${nl2br(v)}</td></tr>`
    )
    .join('');
  const cta = parts.cta?.url
    ? `<p style="margin:24px 0 8px"><a href="${esc(link(parts.cta.url))}" style="display:inline-block;background:${tone};color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:10px;font-weight:700">${esc(parts.cta.label)}</a></p>`
    : '';

  const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(parts.heading)}</title></head>
<body style="margin:0;padding:0;background:#f5f3ec;font-family:Tahoma,'Segoe UI',Arial,sans-serif;direction:rtl;text-align:right">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ec;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e4e0d3">
<tr><td style="background:#0f5c4d;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700">${FORUM}</td></tr>
<tr><td style="height:4px;background:${tone}"></td></tr>
<tr><td style="padding:24px;color:#1f2a2a;font-size:15px;line-height:1.8">
<h1 style="margin:0 0 12px;font-size:20px;color:${tone}">${esc(parts.heading)}</h1>
${parts.intro ? `<p style="margin:0 0 14px">${nl2br(parts.intro)}</p>` : ''}
${rowsHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#faf9f5;border-radius:10px;padding:12px 16px;margin:8px 0 14px">${rowsHtml}</table>` : ''}
${parts.body ? `<div style="margin:0 0 14px">${nl2br(parts.body)}</div>` : ''}
${cta}
${parts.footnote ? `<p style="margin:18px 0 0;color:#6b7776;font-size:13px">${nl2br(parts.footnote)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 24px;background:#faf9f5;color:#6b7776;font-size:12px;border-top:1px solid #e4e0d3">
هذه رسالة آلية من إدارة ${FORUM}. للتواصل يمكنك الرد على هذه الرسالة مباشرة.
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    FORUM,
    '',
    parts.heading,
    '',
    parts.intro || '',
    ...(parts.rows || []).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${v}`),
    parts.body ? `\n${parts.body}` : '',
    parts.cta?.url ? `\n${parts.cta.label}: ${link(parts.cta.url)}` : '',
    parts.footnote ? `\n${parts.footnote}` : '',
    '',
    `— إدارة ${FORUM}`,
  ]
    .filter((x) => x !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return { html, text };
}

const TEMPLATES = {
  verify_email: (d) => ({
    subject: `تأكيد بريدك الإلكتروني — ${FORUM}`,
    ...layout({
      heading: 'تأكيد البريد الإلكتروني',
      intro: `مرحبًا ${d.name}،\nيرجى تأكيد أن هذا البريد يخصك لتصلك إشعارات الإدارة.`,
      cta: { label: 'تأكيد البريد الإلكتروني', url: d.url },
      footnote: 'الرابط صالح لمدة 48 ساعة. إن لم تطلب ذلك فتجاهل هذه الرسالة.',
    }),
  }),

  supervisor_warning: (d) => ({
    subject: `تحذير إداري رسمي (${d.number}) — ${FORUM}`,
    ...layout({
      tone: 'warn',
      heading: `تحذير إداري رسمي رقم ${d.number}`,
      intro: `السلام عليكم ${d.name}،\nنحيطكم علمًا بأنه صدر بحقكم تحذير إداري رسمي.`,
      rows: [
        ['السبب', d.reason],
        ['ملاحظات', d.notes],
        ['التاريخ', fmtDateTime(d.date)],
        ['أصدره', d.issuer],
        ['عدد التحذيرات السارية', `${d.active} من ${d.threshold}`],
      ],
      body:
        d.active < d.threshold
          ? `يرجى الانتباه: بلوغ ${d.threshold} تحذيرات سارية يؤدي إلى إيقاف صلاحيات الإشراف تلقائيًا.`
          : null,
      cta: { label: 'عرض التفاصيل', url: '/' },
    }),
  }),

  supervisor_dismissal: (d) => ({
    subject: `إيقاف صلاحيات الإشراف — ${FORUM}`,
    ...layout({
      tone: 'danger',
      heading: 'إيقاف صلاحيات الإشراف',
      intro: `السلام عليكم ${d.name}،\nنظرًا لبلوغ عدد التحذيرات الرسمية السارية الحد المعتمد (${d.threshold})، تم إيقاف صلاحياتك الإشرافية في المنصة.`,
      rows: [
        ['التاريخ', fmtDateTime(d.date)],
        ['آخر سبب', d.reason],
      ],
      body: 'بيانات الطلاب محفوظة بالكامل. للاستفسار أو الاعتراض يرجى الرد على هذه الرسالة.',
    }),
  }),

  admin_supervisor_dismissed: (d) => ({
    subject: `تم إيقاف المشرف ${d.supervisor} تلقائيًا — ${FORUM}`,
    ...layout({
      tone: 'danger',
      heading: 'إيقاف مشرف تلقائيًا',
      intro: `تم إيقاف صلاحيات المشرف ${d.supervisor} تلقائيًا بعد بلوغ ${d.threshold} تحذيرات رسمية سارية.`,
      rows: [
        ['آخر سبب', d.reason],
        ['التاريخ', fmtDateTime(d.date)],
      ],
      body: 'يمكن نقل طلابه إلى مشرف آخر من صفحة المشرف.',
      cta: { label: 'فتح صفحة المشرف', url: d.url },
    }),
  }),

  compliance_reminder: (d) => ({
    subject: `تذكير: سجلات بحاجة إلى استكمال — ${FORUM}`,
    ...layout({
      tone: 'warn',
      heading: 'سجلات طلاب بحاجة إلى استكمال',
      intro: `السلام عليكم ${d.name}،\n${d.intro}`,
      rows: [
        ['الفترة', d.period],
        ['عدد البنود الناقصة', String(d.count)],
        ['آخر موعد للاستكمال', d.deadline ? fmtDateTime(d.deadline) : null],
      ],
      body: d.items?.length ? `من البنود المطلوبة:\n• ${d.items.slice(0, 15).join('\n• ')}` : null,
      cta: { label: 'استكمال السجلات', url: '/' },
    }),
  }),

  announcement: (d) => ({
    subject: `${d.urgent ? '🔴 عاجل: ' : ''}${d.title} — ${FORUM}`,
    ...layout({
      tone: d.urgent ? 'danger' : 'info',
      heading: d.title,
      rows: [
        ['التصنيف', d.category],
        ['موعد الحدث', d.event_at ? fmtDateTime(d.event_at) : null],
      ],
      body: d.body,
      cta: { label: 'عرض الإعلان في المنصة', url: '/announcements' },
    }),
  }),

  admission_decision: (d) => ({
    subject: `${d.accepted ? 'قبول طلب الالتحاق' : 'نتيجة طلب الالتحاق'} — ${FORUM}`,
    ...layout({
      tone: d.accepted ? 'success' : 'info',
      heading: d.accepted ? 'تم قبول طلب الالتحاق' : 'نتيجة طلب الالتحاق',
      intro: d.accepted
        ? `السلام عليكم،\nيسرّنا إبلاغكم بقبول طلب التحاق ${d.name} في ${FORUM}. سيتواصل معكم المشرف قريبًا لتحديد مواعيد التسميع.`
        : `السلام عليكم،\nنشكر لكم اهتمامكم بالتسجيل في ${FORUM}. نعتذر عن عدم إمكانية قبول طلب ${d.name} في الوقت الحالي.`,
      body: d.note || null,
    }),
  }),

  notification: (d) => ({
    subject: `${d.title} — ${FORUM}`,
    ...layout({ tone: d.tone || 'info', heading: d.title, body: d.body, cta: d.link ? { label: 'فتح المنصة', url: d.link } : null }),
  }),

  test: (d) => ({
    subject: `رسالة تجريبية — ${FORUM}`,
    ...layout({
      tone: 'success',
      heading: 'رسالة تجريبية',
      intro: `هذه رسالة تجريبية للتأكد من إعدادات البريد.\nأرسلها: ${d.by}`,
      rows: [['وقت الإرسال', fmtDateTime(new Date())]],
    }),
  }),
};

export function renderEmail(template, data) {
  const fn = TEMPLATES[template];
  if (!fn) throw new Error(`قالب بريد غير معروف: ${template}`);
  return fn(data || {});
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);
