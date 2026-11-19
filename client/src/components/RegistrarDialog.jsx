import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context/Toast.jsx';
import { Alert, Avatar, Badge, ConfirmDialog, CopyBox, Field, Icon, Modal } from './ui.jsx';
import { fmtDate } from '../lib/format.js';

/**
 * تفاصيل حساب مشرف التسجيل والقبول وإدارته (تعديل، كلمة مرور جديدة، إيقاف/تفعيل).
 * صلاحياته: نماذج التسجيل ومراجعة الطلبات وقبولها فقط.
 */
export default function RegistrarDialog({ staff, onClose, onChanged, onCredentials }) {
  const toast = useToast();
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(null);

  useEffect(() => {
    setEdit(null);
    setErr('');
  }, [staff?.id]);

  if (!staff) return null;
  const s = staff;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.put(`/staff/${s.id}`, edit);
      toast.success('تم حفظ التعديلات');
      setEdit(null);
      onChanged?.();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={!!staff}
        onClose={onClose}
        title={edit ? 'تعديل حساب مشرف التسجيل' : 'مشرف تسجيل وقبول'}
        persistent={busy}
        footer={
          edit ? (
            <>
              <button className="btn" form="registrar-form" type="submit" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
              <button className="btn btn-ghost" type="button" onClick={() => setEdit(null)} disabled={busy}>رجوع</button>
            </>
          ) : (
            <button className="btn btn-ghost" type="button" onClick={onClose}>إغلاق</button>
          )
        }
      >
        {edit ? (
          <form id="registrar-form" onSubmit={save}>
            {err && <Alert tone="danger">{err}</Alert>}
            <Field label="الاسم الكامل" required>
              {(id) => <input id={id} className="input" value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} required maxLength={120} autoFocus />}
            </Field>
            <div className="form-grid">
              <Field label="البريد الإلكتروني" required hint="تغييره يتطلب تأكيدًا جديدًا">
                {(id) => <input id={id} type="email" className="input ltr" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} required maxLength={150} />}
              </Field>
              <Field label="الهاتف">
                {(id) => <input id={id} className="input ltr" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} maxLength={30} />}
              </Field>
            </div>
          </form>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
              <Avatar name={s.full_name} size={52} />
              <div style={{ minWidth: 0 }}>
                <b style={{ fontSize: '1.05rem' }}>{s.full_name}</b>
                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                  {s.is_active ? <Badge tone="success">نشط</Badge> : <Badge tone="danger">موقوف</Badge>}
                  <Badge tone="info">تسجيل وقبول</Badge>
                </div>
              </div>
            </div>
            <dl className="kv">
              <dt>اسم المستخدم</dt><dd dir="ltr">@{s.username}</dd>
              <dt>البريد</dt>
              <dd>
                <span dir="ltr">{s.email || '—'}</span>{' '}
                {s.email && (s.email_verified_at ? <Badge tone="success">مؤكد</Badge> : <Badge tone="warn">غير مؤكد</Badge>)}
              </dd>
              {s.phone && <><dt>الهاتف</dt><dd dir="ltr">{s.phone}</dd></>}
              <dt>تاريخ الإنشاء</dt><dd>{fmtDate(s.created_at)}</dd>
            </dl>
            {s.password && <CopyBox label="كلمة المرور" value={s.password} secret />}
            <Alert tone="info">صلاحياته: نماذج التسجيل ومراجعة طلبات الالتحاق وقبولها فقط — لا وصول للطلاب أو التحليلات أو المشرفين.</Alert>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm btn-ghost" type="button" onClick={() => { setErr(''); setEdit({ full_name: s.full_name, phone: s.phone || '', email: s.email || '' }); }}>
                <Icon name="edit" size={14} /> تعديل
              </button>
              <button className="btn btn-sm btn-ghost" type="button" onClick={() => setConfirm('reset')}>
                <Icon name="key" size={14} /> كلمة مرور جديدة
              </button>
              <button className={`btn btn-sm ${s.is_active ? 'btn-warn' : 'btn-success'}`} type="button" onClick={() => setConfirm('active')}>
                {s.is_active ? 'إيقاف الحساب' : 'تفعيل الحساب'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        tone="warn"
        title={confirm === 'reset' ? 'توليد كلمة مرور جديدة' : s.is_active ? 'إيقاف الحساب' : 'تفعيل الحساب'}
        confirmText="تأكيد"
        onConfirm={async () => {
          if (confirm === 'reset') onCredentials?.(await api.post(`/staff/${s.id}/reset-password`));
          else await api.post(`/staff/${s.id}/active`, { active: !s.is_active });
          toast.success('تم');
          setConfirm(null);
          onChanged?.();
        }}
      >
        {confirm === 'reset' ? 'ستُلغى كلمة المرور الحالية.' : s.is_active ? 'لن يتمكن من الدخول حتى تعيد تفعيله.' : 'سيتمكن من الدخول مجددًا.'}
      </ConfirmDialog>
    </>
  );
}
