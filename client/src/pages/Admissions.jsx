import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth } from '../context/Auth.jsx';
import { useToast } from '../context/Toast.jsx';
import { useSummary } from '../context/Summary.jsx';
import { useLoad } from '../lib/hooks.js';
import { Alert, Badge, ConfirmDialog, CopyBox, Empty, Field, Icon, Modal, PageHeader, Spinner, Tabs } from '../components/ui.jsx';
import { APP_STATUS, supervisorTypeLabel } from '../lib/labels.js';
import { downloadCsv } from '../lib/csv.js';
import { fmtDate, fmtDateTime, fmtIso, norm, relativeTime } from '../lib/format.js';

const EVENT_LABEL = { imported: 'استُورد من النموذج', review: 'حُوِّل إلى قيد المراجعة', note: 'ملاحظة', accepted: 'قُبل', rejected: 'رُفض' };
const compatible = (type, gender) => !gender || type === 'kids' || (type === 'male' && gender === 'male') || (type === 'female' && gender === 'female');

function ApplicationDetail({ id, onClose, onChanged, supervisors }) {
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => (id ? api.get(`/admissions/applications/${id}`) : Promise.resolve(null)), [id]);
  const [mode, setMode] = useState(null); // accept | reject | note
  const [sup, setSup] = useState('');
  const [gender, setGender] = useState('');
  const [text, setText] = useState('');
  if (!id) return null;
  const a = data?.application;
  const decided = a && ['accepted', 'rejected'].includes(a.status);
  const g = gender || a?.gender || '';
  const options = (supervisors || []).filter((s) => compatible(s.supervisor_type, g));

  const after = (msg) => {
    toast.success(msg);
    setMode(null);
    setText('');
    reload();
    onChanged();
  };

  return (
    <>
      <Modal open onClose={onClose} title={a ? `طلب التحاق: ${a.full_name}` : 'طلب التحاق'} size="lg"
        footer={a && !decided && (
          <>
            <button className="btn btn-success" type="button" onClick={() => { setSup(''); setGender(a.gender || ''); setText(''); setMode('accept'); }}><Icon name="check" /> قبول</button>
            <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} type="button" onClick={() => { setText(''); setMode('reject'); }}>رفض</button>
            {a.status === 'new' && (
              <button className="btn btn-secondary" type="button" onClick={async () => { try { await api.post(`/admissions/applications/${a.id}/review`); after('حُوِّل إلى قيد المراجعة'); } catch (e) { toast.error(e.message); } }}>قيد المراجعة</button>
            )}
            <button className="btn btn-ghost" type="button" onClick={() => { setText(''); setMode('note'); }}>إضافة ملاحظة</button>
          </>
        )}>
        {loading && !data ? <Spinner /> : error ? <Alert tone="danger">{error}</Alert> : a && (
          <>
            {a.duplicate_reason && <Alert tone="warn"><b>تنبيه تكرار محتمل:</b> {a.duplicate_reason}</Alert>}
            {a.status === 'accepted' && <Alert tone="success">قُبل وأُنشئ حساب الطالب لدى {a.supervisor_name || 'المشرف'} في {fmtDateTime(a.decided_at)}.</Alert>}
            <dl className="kv">
              <dt>الحالة</dt><dd><Badge tone={APP_STATUS[a.status].tone}>{APP_STATUS[a.status].label}</Badge></dd>
              <dt>الجنس</dt><dd>{a.gender === 'female' ? 'أنثى' : a.gender === 'male' ? 'ذكر' : '—'}</dd>
              <dt>تاريخ الميلاد</dt><dd>{a.birth_date ? fmtIso(a.birth_date) : '—'}</dd>
              <dt>الهاتف</dt><dd dir="ltr" style={{ textAlign: 'right' }}>{a.phone || '—'}</dd>
              <dt>البريد</dt><dd dir="ltr" style={{ textAlign: 'right' }}>{a.email || '—'}</dd>
              <dt>ولي الأمر</dt><dd>{a.guardian_name || '—'} {a.guardian_phone && <span dir="ltr" className="muted small">{a.guardian_phone}</span>}</dd>
              <dt>العنوان</dt><dd>{a.address || '—'}</dd>
              <dt>المحفوظ حاليًا</dt><dd>{a.prior_parts ?? '—'} {a.prior_parts !== null && 'جزء'}</dd>
              {a.notes && <><dt>ملاحظات المتقدم</dt><dd>{a.notes}</dd></>}
              <dt>النموذج</dt><dd>{a.form_title || '—'} • أُرسل {fmtDateTime(a.submitted_at)}</dd>
              {a.admission_notes && <><dt>ملاحظات القبول</dt><dd style={{ whiteSpace: 'pre-line' }}>{a.admission_notes}</dd></>}
            </dl>
            <h3 style={{ margin: '16px 0 8px' }}>سجل القرار</h3>
            <ul className="timeline">
              {data.events.map((e) => (
                <li key={e.id} className={`t-${e.action === 'accepted' ? 'success' : e.action === 'rejected' ? 'danger' : 'info'}`}>
                  <div className="small"><b>{e.actor_name}</b> — {EVENT_LABEL[e.action] || e.action}{e.note ? `: ${e.note}` : ''}</div>
                  <div className="muted small">{fmtDateTime(e.created_at)}</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>

      <ConfirmDialog open={mode === 'accept'} onClose={() => setMode(null)} tone="success" title="قبول الطلب وإنشاء حساب الطالب" confirmText="قبول وإنشاء" disabled={!sup || !g}
        onConfirm={async () => { await api.post(`/admissions/applications/${id}/accept`, { supervisor_id: sup, gender: g || undefined, note: text || undefined }); after('قُبل الطالب وأُضيف إلى المشرف'); }}>
        <p>سيُنشأ سجل الطالب بنفس مسار إضافة الطلاب، ويُبلَّغ المشرف{a?.email ? '، ويُرسل بريد القبول للمتقدم' : ''}.</p>
        {!a?.gender && (
          <Field label="الجنس" required>{(fid) => <select id={fid} className="select" value={gender} onChange={(e) => { setGender(e.target.value); setSup(''); }}><option value="">— اختر —</option><option value="male">ذكر</option><option value="female">أنثى</option></select>}</Field>
        )}
        <Field label="المشرف / الحلقة" required hint="تظهر فقط الحلقات المتوافقة مع جنس الطالب">
          {(fid) => (
            <select id={fid} className="select" value={sup} onChange={(e) => setSup(e.target.value)}>
              <option value="">— اختر —</option>
              {options.map((s) => <option key={s.id} value={s.id}>{s.full_name} — {supervisorTypeLabel(s.supervisor_type)} ({s.students} طالب)</option>)}
            </select>
          )}
        </Field>
        <Field label="ملاحظة (اختياري)">{(fid) => <input id={fid} className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />}</Field>
      </ConfirmDialog>
      <ConfirmDialog open={mode === 'reject'} onClose={() => setMode(null)} title="رفض الطلب" confirmText="رفض"
        onConfirm={async () => { await api.post(`/admissions/applications/${id}/reject`, { note: text }); after('رُفض الطلب وحُفظ في السجل'); }}>
        <Field label="سبب الرفض (داخلي)">{(fid) => <textarea id={fid} className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />}</Field>
      </ConfirmDialog>
      <ConfirmDialog open={mode === 'note'} onClose={() => setMode(null)} tone="primary" title="ملاحظة قبول" confirmText="حفظ" disabled={!text.trim()}
        onConfirm={async () => { await api.post(`/admissions/applications/${id}/notes`, { note: text }); after('حُفظت الملاحظة'); }}>
        <Field label="الملاحظة" required>{(fid) => <textarea id={fid} className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />}</Field>
      </ConfirmDialog>
    </>
  );
}

export default function Admissions() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const { refresh } = useSummary();
  const [status, setStatus] = useState('');
  const [dupOnly, setDupOnly] = useState(false);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [newForm, setNewForm] = useState(null);
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState('');
  const [formsOpen, setFormsOpen] = useState(false);

  const { data: st } = useLoad(() => api.get('/admissions/status'), []);
  const { data: forms, reload: reloadForms } = useLoad(() => api.get('/admissions/forms'), []);
  const { data: sups } = useLoad(() => api.get('/admissions/supervisors'), []);
  const { data, loading, error, reload } = useLoad(() => api.get(`/admissions/applications${qs({ status, duplicates: dupOnly ? 'true' : '' })}`), [status, dupOnly]);

  const rows = useMemo(() => (data?.applications || []).filter((a) => !q || norm(`${a.full_name} ${a.phone} ${a.email}`).includes(norm(q))), [data, q]);
  const counts = data?.counts || {};
  const google = st?.google;

  const sync = async (f) => {
    setBusy(f.id);
    try {
      const r = await api.post(`/admissions/forms/${f.id}/sync`);
      toast.success(r.imported ? `استُورد ${r.imported} طلب جديد` : 'لا توجد استجابات جديدة');
      if (r.sheet_error) toast.error(r.sheet_error);
      reload();
      reloadForms();
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const createForm = async (e) => {
    e.preventDefault();
    setBusy('create');
    try {
      const r = await api.post('/admissions/forms', newForm);
      setNewForm(null);
      setCreated(r);
      reloadForms();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy('');
    }
  };

  const exportCsv = () =>
    downloadCsv(
      `طلبات-الالتحاق-${fmtIso(new Date())}.csv`,
      ['الاسم', 'الجنس', 'الميلاد', 'الهاتف', 'البريد', 'المحفوظ', 'الحالة', 'تنبيه تكرار', 'المشرف', 'تاريخ الإرسال'],
      rows.map((a) => [a.full_name, a.gender === 'female' ? 'أنثى' : a.gender === 'male' ? 'ذكر' : '', a.birth_date || '', a.phone || '', a.email || '', a.prior_parts ?? '', APP_STATUS[a.status].label, a.duplicate_reason || '', a.supervisor_name || '', fmtIso(a.submitted_at)])
    );

  return (
    <>
      <PageHeader
        title="القبول والتسجيل"
        subtitle="طلبات الالتحاق الواردة من نماذج التسجيل"
        actions={
          <button className="btn btn-ghost" type="button" onClick={() => setFormsOpen(true)}>
            <Icon name="clipboard" /> نماذج التسجيل
            {forms && <Badge tone={google && !google.connected ? 'warn' : 'muted'}>{google && !google.connected ? 'غير مربوط' : forms.forms.length}</Badge>}
          </button>
        }
      />

      <Tabs value={status} onChange={setStatus} tabs={[{ value: '', label: 'الكل' }, ...Object.entries(APP_STATUS).map(([k, v]) => ({ value: k, label: v.label, count: counts[k] || 0 }))]} />
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="بحث بالاسم أو الهاتف أو البريد…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في الطلبات" /></div>
        <label className="check small"><input type="checkbox" checked={dupOnly} onChange={(e) => setDupOnly(e.target.checked)} /> المكررة المحتملة فقط</label>
        <button className="btn btn-ghost" type="button" onClick={exportCsv} disabled={!rows.length}><Icon name="download" size={16} /> تصدير</button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="card card-flush">
        {loading && !data ? <Spinner /> : rows.length === 0 ? (
          <Empty icon="inbox" title="لا توجد طلبات" hint="تظهر الطلبات هنا بعد مزامنة نماذج التسجيل." />
        ) : (
          <div className="table-wrap">
            <table className="tbl tbl-click">
              <thead><tr><th>الاسم</th><th>الجنس</th><th>الميلاد</th><th>الهاتف</th><th>المحفوظ</th><th>أُرسل</th><th>الحالة</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} onClick={() => setOpenId(a.id)}>
                    <td><b>{a.full_name}</b>{a.duplicate_reason && <> <Badge tone="warn" title={a.duplicate_reason}>مكرر؟</Badge></>}</td>
                    <td>{a.gender === 'female' ? 'أنثى' : a.gender === 'male' ? 'ذكر' : '—'}</td>
                    <td className="num">{a.birth_date || '—'}</td>
                    <td className="num" dir="ltr">{a.phone || '—'}</td>
                    <td className="num">{a.prior_parts ?? '—'}</td>
                    <td className="small">{fmtDate(a.submitted_at)}</td>
                    <td><Badge tone={APP_STATUS[a.status].tone}>{APP_STATUS[a.status].label}</Badge>{a.supervisor_name && <div className="small muted">{a.supervisor_name}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={formsOpen} onClose={() => setFormsOpen(false)} title="نماذج التسجيل" size="lg"
        footer={<><button className="btn" type="button" disabled={!google?.connected} onClick={() => { setFormsOpen(false); setNewForm({ title: 'نموذج التسجيل في ملتقى المسك القرآني', description: '' }); }}><Icon name="plus" /> إنشاء نموذج تسجيل</button><button className="btn btn-ghost" type="button" onClick={() => setFormsOpen(false)}>إغلاق</button></>}>
        {google && !google.connected && (
          <Alert tone="warn">
            <b>تكامل Google غير مفعّل بعد.</b>{' '}
            {!google.configured ? 'لم تُضبط مفاتيح Google على الخادم (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). ' : 'يجب ربط حساب Google الخاص بالملتقى مرة واحدة. '}
            {isAdmin ? <Link to="/settings?tab=integrations">افتح الإعدادات ← التكاملات</Link> : 'تواصل مع المسؤول الإداري لإتمام الربط.'}
          </Alert>
        )}
        {google?.account && <div className="small muted" style={{ marginBottom: 10 }}>حساب Google: <span dir="ltr">{google.account}</span></div>}
        {!forms ? <Spinner /> : forms.forms.length === 0 ? (
          <Empty icon="clipboard" title="لا توجد نماذج بعد" hint="أنشئ نموذجًا ثم شارك رابطه مع المتقدمين. تُستورد الاستجابات تلقائيًا كل فترة، أو فورًا بزر المزامنة." />
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {forms.forms.map((f) => (
              <div key={f.id} className="form-row">
                <div style={{ flex: 1, minWidth: 220 }}>
                  <b>{f.title}</b> {f.status === 'closed' ? <Badge tone="muted">مغلق</Badge> : <Badge tone="success">يستقبل</Badge>}
                  <div className="small muted">{f.applications} طلب • آخر مزامنة: {f.last_synced_at ? relativeTime(f.last_synced_at) : 'لم تتم بعد'} • أُنشئ {fmtDate(f.created_at)}</div>
                  {f.last_sync_error && <div className="small" style={{ color: 'var(--danger)' }}>{f.last_sync_error}</div>}
                </div>
                <CopyBox label="رابط التسجيل للمشاركة" value={f.responder_url} mono={false} />
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" type="button" onClick={() => sync(f)} disabled={busy === f.id}><Icon name="refresh" size={14} /> {busy === f.id ? 'جارٍ…' : 'مزامنة الآن'}</button>
                  <a className="btn btn-sm btn-ghost" href={f.sheet_url} target="_blank" rel="noopener noreferrer">جدول الاستجابات</a>
                  <a className="btn btn-sm btn-ghost" href={f.edit_url} target="_blank" rel="noopener noreferrer">تحرير النموذج</a>
                  <button className="btn btn-sm btn-ghost" type="button" onClick={async () => { await api.post(`/admissions/forms/${f.id}/status`, { status: f.status === 'active' ? 'closed' : 'active' }); reloadForms(); }}>
                    {f.status === 'active' ? 'إيقاف المزامنة' : 'إعادة التفعيل'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <ApplicationDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => { reload(); refresh(); }} supervisors={sups?.supervisors} />

      <Modal open={!!newForm} onClose={() => setNewForm(null)} title="إنشاء نموذج تسجيل في Google Forms" persistent={busy === 'create'}
        footer={<><button className="btn" form="new-form" type="submit" disabled={busy === 'create'}>{busy === 'create' ? 'جارٍ الإنشاء في Google…' : 'إنشاء'}</button><button className="btn btn-ghost" type="button" onClick={() => setNewForm(null)}>إلغاء</button></>}>
        {newForm && (
          <form id="new-form" onSubmit={createForm}>
            <Alert tone="info">سيُنشأ نموذج بحقول القبول المطلوبة (الاسم، الجنس، الميلاد، الهاتف، ولي الأمر، المحفوظ…) وجدول Google Sheets خاص غير منشور للاستجابات.</Alert>
            <Field label="عنوان النموذج" required>{(id) => <input id={id} className="input" value={newForm.title} onChange={(e) => setNewForm({ ...newForm, title: e.target.value })} required maxLength={150} />}</Field>
            <Field label="وصف يظهر للمتقدمين (اختياري)">{(id) => <textarea id={id} className="textarea" value={newForm.description} onChange={(e) => setNewForm({ ...newForm, description: e.target.value })} maxLength={1000} />}</Field>
          </form>
        )}
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title="تم إنشاء النموذج ✓">
        {created && (
          <div className="stack" style={{ gap: 10 }}>
            {created.publish_warning && <Alert tone="warn">{created.publish_warning}</Alert>}
            <CopyBox label="رابط التسجيل — انسخه وشاركه" value={created.form.responder_url} mono={false} />
            <a className="btn btn-ghost" href={created.form.sheet_url} target="_blank" rel="noopener noreferrer">فتح جدول الاستجابات (خاص)</a>
          </div>
        )}
      </Modal>
    </>
  );
}
