import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useLoad } from '../lib/hooks.js';
import { Alert, Avatar, Badge, CopyBox, Dropdown, Empty, Icon, Modal, PageHeader, Spinner, Tabs } from '../components/ui.jsx';
import SupervisorForm from '../components/SupervisorForm.jsx';
import RegistrarDialog from '../components/RegistrarDialog.jsx';
import { supervisorTypeLabel } from '../lib/labels.js';
import { norm } from '../lib/format.js';

export function CredentialsDialog({ open, onClose, creds, title = 'بيانات الدخول' }) {
  if (!creds) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <button className="btn" onClick={onClose} type="button">
          تم، أغلق
        </button>
      }
    >
      <Alert tone="success">تم الحفظ بنجاح. سلّم هذه البيانات لصاحبها بطريقة آمنة (لا تُرسل كلمات المرور بالبريد). تبقى ظاهرة لك دائمًا في صفحة المشرف ما لم يغيّر كلمة المرور بنفسه.</Alert>
      <div className="stack" style={{ gap: 10 }}>
        <CopyBox label="اسم المستخدم" value={creds.username} />
        <CopyBox label="كلمة المرور" value={creds.password} />
      </div>
    </Modal>
  );
}

const CATEGORIES = [
  { value: 'male', label: 'ذكور' },
  { value: 'female', label: 'إناث' },
  { value: 'kids', label: 'كيدز' },
  { value: 'registrar', label: 'التسجيل والقبول' },
];

export default function Supervisors() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data, loading, error, reload } = useLoad(
    () => Promise.all([api.get('/supervisors'), api.get('/staff')]).then(([a, b]) => ({ supervisors: a.supervisors, staff: b.staff })),
    []
  );
  const [tab, setTab] = useState('active');
  const [type, setType] = useState(() => (CATEGORIES.some((c) => c.value === params.get('type')) ? params.get('type') : ''));
  const [q, setQ] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [creds, setCreds] = useState(null);
  const [openStaffId, setOpenStaffId] = useState(null);

  // المشرفون ومشرفو التسجيل في قائمة واحدة؛ مشرف التسجيل "نوع" من أنواع المشرفين
  const all = useMemo(
    () =>
      [
        ...(data?.supervisors || []).map((s) => ({ ...s, kind: 'supervisor', category: s.supervisor_type, active: s.status === 'active' })),
        ...(data?.staff || []).map((s) => ({ ...s, kind: 'registrar', category: 'registrar', active: s.is_active })),
      ].sort((a, b) => a.full_name.localeCompare(b.full_name, 'ar')),
    [data]
  );
  const list = useMemo(
    () =>
      all.filter(
        (s) =>
          (tab === 'all' || (tab === 'active' ? s.active : !s.active)) &&
          (!type || s.category === type) &&
          (!q || norm(s.full_name).includes(norm(q)) || s.username.includes(q.trim()))
      ),
    [all, tab, type, q]
  );
  const openStaff = all.find((s) => s.kind === 'registrar' && s.id === openStaffId) || null;
  const open = (s) => (s.kind === 'registrar' ? setOpenStaffId(s.id) : navigate(`/supervisors/${s.id}`));

  return (
    <>
      <PageHeader
        title="المشرفون"
        subtitle="إضافة المشرفين ومشرفي التسجيل وإدارتهم وفصلهم"
        actions={
          <button className="btn" onClick={() => setFormOpen(true)} type="button">
            <Icon name="plus" /> إضافة مشرف
          </button>
        }
      />

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'active', label: 'النشطون', count: all.filter((s) => s.active).length },
          { value: 'suspended', label: 'المفصولون والموقوفون', count: all.filter((s) => !s.active).length },
          { value: 'all', label: 'الكل', count: all.length },
        ]}
      />

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input className="input" placeholder="ابحث بالاسم أو اسم المستخدم…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Dropdown
          label="الفئة"
          icon="sliders"
          value={type}
          onChange={setType}
          options={[
            { value: '', label: 'كل الفئات' },
            ...CATEGORIES.map((c) => ({ ...c, hint: all.filter((s) => s.category === c.value).length })),
          ]}
        />
      </div>

      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert tone="danger">{error}</Alert>
      ) : list.length === 0 ? (
        <div className="card">
          <Empty
            icon="users"
            title={all.length === 0 ? 'لم تُضف أي مشرف بعد' : 'لا توجد نتائج'}
            hint={all.length === 0 ? 'أضف أول مشرف وسيُولَّد له اسم مستخدم وكلمة مرور تلقائيًا.' : 'جرّب تغيير الفلتر أو البحث.'}
          >
            {all.length === 0 && (
              <button className="btn" onClick={() => setFormOpen(true)} type="button">
                <Icon name="plus" /> إضافة مشرف
              </button>
            )}
          </Empty>
        </div>
      ) : (
        <div className="grid grid-auto">
          {list.map((s) => (
            <div key={`${s.kind}-${s.id}`} className="card sup-card" onClick={() => open(s)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(s)}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Avatar name={s.full_name} size={46} />
                <div style={{ minWidth: 0 }}>
                  <h3>{s.full_name}</h3>
                  <span className="muted small">{s.kind === 'registrar' ? 'مشرف تسجيل وقبول' : supervisorTypeLabel(s.supervisor_type)}</span>
                </div>
              </div>
              <div className="row">
                {s.kind === 'registrar' ? (
                  <>
                    {s.active ? <Badge tone="success">نشط</Badge> : <Badge tone="danger">موقوف</Badge>}
                    <Badge tone="info">التسجيل والقبول</Badge>
                  </>
                ) : (
                  <>
                    {s.active ? <Badge tone="success">نشط</Badge> : <Badge tone="danger">مفصول</Badge>}
                    <Badge tone="primary">{s.students_active} طالب نشط</Badge>
                  </>
                )}
              </div>
              {s.phone && (
                <span className="muted small" dir="ltr" style={{ textAlign: 'right' }}>
                  {s.phone}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <SupervisorForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={(res) => {
          setCreds({ username: res.username, password: res.password, registrar: res.registrar });
          reload();
        }}
      />
      <RegistrarDialog staff={openStaff} onClose={() => setOpenStaffId(null)} onChanged={reload} onCredentials={(c) => setCreds({ ...c, registrar: true })} />
      <CredentialsDialog
        open={!!creds}
        creds={creds}
        onClose={() => setCreds(null)}
        title={creds?.registrar ? 'بيانات دخول مشرف التسجيل' : 'تم إنشاء حساب المشرف'}
      />
    </>
  );
}
