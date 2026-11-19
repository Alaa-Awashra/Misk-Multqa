export const SUPERVISOR_TYPES = [
  { value: 'male', label: 'مشرف (ذكور)' },
  { value: 'female', label: 'مشرفة (إناث)' },
  { value: 'kids', label: 'مشرف كيدز' },
];

export const supervisorTypeLabel = (t) => SUPERVISOR_TYPES.find((x) => x.value === t)?.label || '—';

/** مسميات الواجهة حسب نوع المشرف: ذكور / إناث / كيدز */
export function nouns(type) {
  switch (type) {
    case 'female':
      return { one: 'طالبة', many: 'الطالبات', mine: 'طالباتي', add: 'إضافة طالبة', the: 'الطالبة', supervisor: 'المشرفة' };
    case 'kids':
      return { one: 'طفل', many: 'الأطفال', mine: 'أطفالي', add: 'إضافة طفل', the: 'الطفل', supervisor: 'المشرف' };
    case 'male':
      return { one: 'طالب', many: 'الطلاب', mine: 'طلابي', add: 'إضافة طالب', the: 'الطالب', supervisor: 'المشرف' };
    default:
      return { one: 'طالب', many: 'الطلاب', mine: 'الطلاب', add: 'إضافة طالب', the: 'الطالب', supervisor: 'المشرف' };
  }
}

export const genderLabel = (g) => (g === 'female' ? 'أنثى' : 'ذكر');

export const KIND_LABEL = { recitation: 'تسميع', exam: 'امتحان سورة' };
export const RECITATION_TYPE_LABEL = { new: 'حفظ جديد', review: 'مراجعة' };
export const APPT_STATUS = {
  scheduled: { label: 'محجوز', tone: 'info' },
  completed: { label: 'تم', tone: 'success' },
  missed: { label: 'لم يلتزم', tone: 'danger' },
  cancelled: { label: 'ملغي', tone: 'muted' },
};

export const ACTION_LABEL = {
  'supervisor.create': 'أضاف المشرف',
  'supervisor.update': 'عدّل بيانات المشرف',
  'supervisor.suspend': 'فصل المشرف',
  'supervisor.reinstate': 'أعاد تفعيل المشرف',
  'supervisor.delete': 'حذف المشرف',
  'supervisor.reset_password': 'أعاد تعيين كلمة مرور المشرف',
  'student.create': 'أضاف الطالب',
  'student.update': 'عدّل بيانات الطالب',
  'student.suspend': 'فصل الطالب',
  'student.reinstate': 'أعاد تفعيل الطالب',
  'student.delete': 'حذف الطالب',
  'student.transfer': 'نقل الطالب',
  'student.warning': 'أضاف تحذيرًا على الطالب',
  'student.warning_resolved': 'أغلق تحذيرًا على الطالب',
  'appointment.create': 'حجز موعدًا للطالب',
  'appointment.record': 'سجّل موعدًا سابقًا للطالب',
  'appointment.reschedule': 'أعاد جدولة موعد الطالب',
  'appointment.update': 'عدّل موعد الطالب',
  'appointment.complete': 'سجّل إتمام موعد الطالب',
  'appointment.missed': 'سجّل عدم التزام الطالب',
  'appointment.cancel': 'ألغى موعد الطالب',
  'appointment.delete': 'حذف موعد الطالب',
  'profile.update': 'عدّل ملفه الشخصي',
  'profile.password': 'غيّر كلمة المرور',
  'settings.update': 'عدّل الإعدادات',
  'student.remove': 'حذف (حذفًا ناعمًا) الطالب',
  'student.restore': 'استعاد الطالب',
  'student.request_removal': 'طلب حذف الطالب',
  'student.request_dismissal': 'طلب فصل الطالب',
  'student.request_approved': 'وافق على طلب بخصوص الطالب',
  'student.request_rejected': 'رفض طلبًا بخصوص الطالب',
  'student.request_cancelled': 'سحب طلبًا بخصوص الطالب',
  'supervisor.warning': 'أصدر تحذيرًا رسميًا للمشرف',
  'supervisor.warning_revoked': 'ألغى تحذيرًا للمشرف',
  'supervisor.auto_dismiss': 'أوقف المشرف تلقائيًا (بلوغ حد التحذيرات)',
  'supervisor.email_verified_manual': 'أكّد بريد المشرف يدويًا',
  'user.email_verified': 'أكّد بريده الإلكتروني',
  'compliance.reminder': 'أرسل تذكير استكمال سجلات إلى',
  'compliance.excuse': 'قبل عذر مخالفة المشرف',
  'compliance.exemption': 'أضاف إعفاء/إجازة',
  'compliance.exemption_deleted': 'حذف إعفاء/إجازة',
  'appointment.session_reschedule': 'نقل جلسة جماعية',
  'appointment.session_cancel': 'ألغى جلسة جماعية',
  'appointment.series_cancel': 'ألغى سلسلة مواعيد متكررة',
  'announcement.create': 'نشر الإعلان',
  'announcement.update': 'عدّل الإعلان',
  'announcement.delete': 'حذف الإعلان',
  'conversation.status': 'غيّر حالة المحادثة',
  'staff.create': 'أضاف مشرف التسجيل',
  'staff.update': 'عدّل بيانات مشرف التسجيل',
  'staff.activate': 'فعّل حساب',
  'staff.deactivate': 'أوقف حساب',
  'staff.reset_password': 'أعاد تعيين كلمة مرور',
  'admission.form_created': 'أنشأ نموذج التسجيل',
  'admission.form_closed': 'أغلق نموذج التسجيل',
  'admission.form_opened': 'فتح نموذج التسجيل',
  'admission.accepted': 'قبل طلب التحاق',
  'admission.rejected': 'رفض طلب التحاق',
  'google.connected': 'ربط حساب',
  'google.disconnected': 'فصل حساب',
  'email.test': 'أرسل بريدًا تجريبيًا',
  'analytics.generate': 'ولّد التقارير الدورية',
};

export const REQUEST_KIND = { removal: 'حذف', dismissal: 'فصل' };
export const REQUEST_STATUS = {
  pending: { label: 'بانتظار القرار', tone: 'warn' },
  approved: { label: 'تمت الموافقة', tone: 'success' },
  rejected: { label: 'مرفوض', tone: 'danger' },
  cancelled: { label: 'مسحوب', tone: 'muted' },
};
export const CONV_STATUS = {
  open: { label: 'مفتوحة', tone: 'info' },
  in_progress: { label: 'قيد المعالجة', tone: 'warn' },
  closed: { label: 'مغلقة', tone: 'muted' },
};
export const CONV_CATEGORY = { question: 'استفسار', complaint: 'شكوى', suggestion: 'اقتراح', request: 'طلب', other: 'أخرى' };
export const ANN_CATEGORY = {
  schedule: { label: 'جدول التسميع', tone: 'info' },
  meeting: { label: 'اجتماع إداري', tone: 'primary' },
  important: { label: 'إعلان مهم', tone: 'warn' },
  policy: { label: 'تحديث سياسات', tone: 'muted' },
  instructions: { label: 'تعليمات', tone: 'success' },
  urgent: { label: 'تنبيه عاجل', tone: 'danger' },
};
export const ANN_AUDIENCE = { supervisors: 'المشرفون', registrars: 'مشرفو التسجيل والقبول', staff: 'كل الطاقم' };
export const APP_STATUS = {
  new: { label: 'جديد', tone: 'info' },
  under_review: { label: 'قيد المراجعة', tone: 'warn' },
  accepted: { label: 'مقبول', tone: 'success' },
  rejected: { label: 'مرفوض', tone: 'danger' },
};
export const GROUP_LABEL = { male: 'ذكور', female: 'إناث', kids: 'كيدز' };
export const EMAIL_STATUS = {
  pending: { label: 'بالانتظار', tone: 'info' },
  sending: { label: 'قيد الإرسال', tone: 'info' },
  sent: { label: 'أُرسل', tone: 'success' },
  failed: { label: 'فشل', tone: 'danger' },
  disabled: { label: 'البريد غير مُعدّ', tone: 'muted' },
};
export const roleLabel = (u) =>
  u.role === 'admin' ? 'المسؤول الإداري' : u.role === 'registrar' ? 'مشرف التسجيل والقبول' : supervisorTypeLabel(u.supervisor_type);

export const actionTone = (a) =>
  /delete|suspend$|dismiss|remove$|rejected/.test(a)
    ? 'danger'
    : /create|record|reinstate|approved|accepted|restore|verified/.test(a)
      ? 'success'
      : /missed|warning$|reminder|request_/.test(a)
        ? 'warn'
        : 'info';
