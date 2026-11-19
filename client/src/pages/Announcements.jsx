import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/Auth.jsx';
import { useToast } from '../context/Toast.jsx';
import { useSummary } from '../context/Summary.jsx';
import { useLoad } from '../lib/hooks.js';
import { Alert, Badge, ConfirmDialog, Empty, Field, Icon, Modal, PageHeader, Spinner, Tabs } from '../components/ui.jsx';
import { ANN_AUDIENCE, ANN_CATEGORY, EMAIL_STATUS } from '../lib/labels.js';
import { fmtDateTime, localHM, localISODate, norm, toISO } from '../lib/format.js';

const EMPTY = { title: '', body: '', category: 'important', audience: 'supervisors', pinned: false, send_email: true, event_date: '', event_time: '', expires_date: '' };

function AnnouncementForm({ open, initial, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key, setKey] = useState(null);
  if (open && key !== (initial?.id || 'new')) {
    setKey(initial?.id || 'new');
    setError('');
    setF(
      initial
        ? {
            ...EMPTY,
            ...initial,
            event_date: initial.event_at ? localISODate(new Date(initial.event_at)) : '',
            event_time: initial.event_at ? localHM(new Date(initial.event_at)) : '',
            expires_date: initial.expires_at ? localISODate(new Date(initial.expires_at)) : '',
          }
        : EMPTY
    );
  }
  if (!open && key) setKey(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      title: f.title,
      body: f.body,
      category: f.category,
      audience: f.audience,
      pinned: !!f.pinned,
      send_email: !!f.send_email,
      event_at: f.event_date ? toISO(f.event_date, f.event_time || '00:00') : null,
      expires_at: f.expires_date ? toISO(f.expires_date, '23:59') : null,
    };
    try {
      const r = initial ? await api.put(`/announcements/${initial.id}`, body) : await api.post('/announcements', body);
      toast.success(initial ? 'تم حفظ التعديل' : `نُشر الإعلان${r.delivery ? ` ووصل إلى ${r.delivery.recipients} مستلم` : ''}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'تعديل الإعلان' : 'إعلان جديد'} persistent={busy} size="lg"
      footer={<><button className="btn" form="ann-form" type="submit" disabled={busy}>{busy ? 'جارٍ الحفظ…' : initial ? 'حفظ' : 'نشر'}</button><button className="btn btn-ghost" type="button" onClick={onClose}>إلغاء</button></>}>
      <form id="ann-form" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="form-grid">
          <Field label="العنوان" required className="full">{(id) => <input id={id} className="input" value={f.title} onChange={set('title')} required maxLength={200} />}</Field>
          <Field label="التصنيف" required>
            {(id) => <select id={id} className="select" value={f.category} onChange={set('category')}>{Object.entries(ANN_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>}
          </Field>
          <Field label="موجّه إلى" required hint="لا يملك الطلاب حسابات في المنصة، فالإعلانات للطاقم فقط">
            {(id) => <select id={id} className="select" value={f.audience} onChange={set('audience')}>{Object.entries(ANN_AUDIENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
          </Field>
          <Field label="الوصف" required className="full">{(id) => <textarea id={id} className="textarea" style={{ minHeight: 140 }} value={f.body} onChange={set('body')} required maxLength={10000} />}</Field>
          <Field label="تاريخ الحدث (اختياري)">{(id) => <input id={id} type="date" className="input" value={f.event_date} onChange={set('event_date')} />}</Field>
          <Field label="وقت الحدث">{(id) => <input id={id} type="time" className="input" value={f.event_time} onChange={set('event_time')} disabled={!f.event_date} />}</Field>
          <Field label="ينتهي عرضه في (اختياري)" hint="بعده يختفي الإعلان من صفحات المشرفين">{(id) => <input id={id} type="date" className="input" value={f.expires_date} onChange={set('expires_date')} />}</Field>
          <div className="field">
            <label className="check"><input type="checkbox" checked={!!f.pinned} onChange={set('pinned')} /> تثبيت في الأعلى</label>
            <label className="check"><input type="checkbox" checked={!!f.send_email} onChange={set('send_email')} /> إرسال بريد للمستلمين (مرة واحدة فقط)</label>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function Deliveries({ ann, onClose }) {
  const { data, loading } = useLoad(() => (ann ? api.get(`/announcements/${ann.id}/deliveries`) : Promise.resolve(null)), [ann?.id]);
  return (
    <Modal open={!!ann} onClose={onClose} title="سجل التسليم">
      {loading || !data ? <Spinner /> : (
        <>
          <h3>البريد ({data.emails.length})</h3>
          {data.emails.length === 0 ? <p className="muted small">لم يُرسل بريد (الإرسال معطّل لهذا الإعلان أو لا يوجد مستلمون ببريد مؤكد).</p> : (
            <ul className="list-plain">
              {data.emails.map((e) => (
                <li key={e.id}><span>{e.full_name || e.to_email} <span className="small muted" dir="ltr">{e.to_email}</span></span><span><Badge tone={EMAIL_STATUS[e.status].tone}>{EMAIL_STATUS[e.status].label}</Badge>{e.last_error && <span className="small muted"> {e.last_error.slice(0, 80)}</span>}</span></li>
              ))}
            </ul>
          )}
          <h3 style={{ marginTop: 14 }}>القراءة داخل المنصة ({data.reads.length})</h3>
          {data.reads.length === 0 ? <p className="muted small">لم يقرأه أحد بعد.</p> : (
            <ul className="list-plain">{data.reads.map((r, i) => <li key={i}><span>{r.full_name}</span><span className="small muted">{fmtDateTime(r.read_at)}</span></li>)}</ul>
          )}
        </>
      )}
    </Modal>
  );
}

export default function Announcements() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const { refresh } = useSummary();
  const { data, loading, error, reload, setData } = useLoad(() => api.get('/announcements'), []);
  const [form, setForm] = useState(null); // { initial }
  const [del, setDel] = useState(null);
  const [deliv, setDeliv] = useState(null);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);

  const list = (data?.announcements || []).filter((a) => (!cat || a.category === cat) && (!q || norm(`${a.title} ${a.body}`).includes(norm(q))));

  const expand = async (a) => {
    setOpenId(openId === a.id ? null : a.id);
    if (!isAdmin && !a.read_at) {
      await api.post(`/announcements/${a.id}/read`).catch(() => {});
      setData((d) => ({ ...d, announcements: d.announcements.map((x) => (x.id === a.id ? { ...x, read_at: new Date().toISOString() } : x)) }));
      refresh();
    }
  };

  return (
    <>
      <PageHeader
        title="الإعلانات والتعاميم"
        subtitle={isAdmin ? 'جداول التسميع، الاجتماعات، التعليمات والتنبيهات العاجلة' : 'إعلانات الإدارة الموجهة إليك'}
        actions={isAdmin && <button className="btn" type="button" onClick={() => setForm({ initial: null })}><Icon name="plus" /> إعلان جديد</button>}
      />
      <div className="toolbar">
        <Tabs value={cat} onChange={setCat} tabs={[{ value: '', label: 'الكل' }, ...Object.entries(ANN_CATEGORY).map(([k, v]) => ({ value: k, label: v.label }))]} />
        <span className="spacer" />
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="بحث" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في الإعلانات" /></div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {loading && !data ? <Spinner /> : list.length === 0 ? (
        <div className="card"><Empty icon="megaphone" title="لا توجد إعلانات" hint={isAdmin ? 'انشر أول إعلان من الزر أعلاه.' : 'ستظهر هنا إعلانات الإدارة فور نشرها.'} /></div>
      ) : (
        <div className="stack">
          {list.map((a) => {
            const c = ANN_CATEGORY[a.category];
            const unread = !isAdmin && !a.read_at;
            return (
              <article key={a.id} className={`card ann ann-${a.category} ${unread ? 'ann-unread' : ''}`}>
                <button type="button" className="ann-head" onClick={() => expand(a)} aria-expanded={openId === a.id}>
                  <span className="row" style={{ gap: 8 }}>
                    {a.pinned && <Icon name="pin" size={16} />}
                    <Badge tone={c.tone}>{c.label}</Badge>
                    {unread && <Badge tone="info">جديد</Badge>}
                    {a.expired && <Badge tone="muted">منتهي</Badge>}
                    <b className="ann-title">{a.title}</b>
                  </span>
                  <span className="small muted nowrap">{fmtDateTime(a.published_at)}</span>
                </button>
                {(openId === a.id || a.pinned || a.category === 'urgent') && (
                  <div className="ann-body">
                    {a.event_at && <p className="small"><Icon name="calendar" size={14} /> موعد الحدث: <b>{fmtDateTime(a.event_at)}</b></p>}
                    <p style={{ whiteSpace: 'pre-line' }}>{a.body}</p>
                    {isAdmin && (
                      <div className="row ann-admin">
                        <span className="small muted">إلى: {ANN_AUDIENCE[a.audience]} • قُرئ {a.reads} مرة • البريد: {a.send_email ? `${a.emails_sent}/${a.emails_total} أُرسل` : 'معطّل'}{a.created_by_name ? ` • ${a.created_by_name}` : ''}</span>
                        <span className="spacer" />
                        <button className="btn btn-sm btn-ghost" type="button" onClick={() => setDeliv(a)}>سجل التسليم</button>
                        <button className="btn btn-sm btn-ghost" type="button" onClick={() => setForm({ initial: a })}><Icon name="edit" size={14} /> تعديل</button>
                        <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} type="button" onClick={() => setDel(a)}><Icon name="trash" size={14} /> حذف</button>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <AnnouncementForm open={!!form} initial={form?.initial} onClose={() => setForm(null)} onSaved={reload} />
      <Deliveries ann={deliv} onClose={() => setDeliv(null)} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title="حذف الإعلان" confirmText="حذف"
        onConfirm={async () => { await api.del(`/announcements/${del.id}`); toast.success('تم حذف الإعلان'); setDel(null); reload(); }}>
        سيختفي الإعلان «<b>{del?.title}</b>» من صفحات المستلمين. يبقى سجل البريد المرسل محفوظًا.
      </ConfirmDialog>
    </>
  );
}
