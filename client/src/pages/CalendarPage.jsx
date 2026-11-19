import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
import arLocale from '@fullcalendar/core/locales/ar';
import { api, qs } from '../api.js';
import { useAuth } from '../context/Auth.jsx';
import { useToast } from '../context/Toast.jsx';
import { useLoad } from '../lib/hooks.js';
import { Alert, Badge, ConfirmDialog, Dropdown, Icon, Modal, PageHeader } from '../components/ui.jsx';
import { AppointmentDetail, AppointmentForm, apptTitle } from '../components/Appointments.jsx';
import { APPT_STATUS, GROUP_LABEL, KIND_LABEL } from '../lib/labels.js';
import { APP_TZ, fmtDate, fmtTime, fmtWeekday, localHM, localISODate, norm, toISO } from '../lib/format.js';

// لوحة ألوان مميزة لكل مشرف (ثابتة حسب المعرّف)
const PALETTE = ['#0f5c4d', '#1d4f91', '#8a3a6b', '#e0771a', '#2a9d8f', '#b8860b', '#6a4c93', '#c0392b', '#3c6e71', '#d1495b', '#00798c', '#7a5c2e'];
function colorFor(id) {
  if (!id) return '#7b8794';
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** نافذة الجلسة الجماعية: قائمة الطلاب وإجراءات الجلسة */
function SessionDetail({ session, onClose, onOpenAppt, onChanged, canManage, canCancel, onAddStudent, onMove }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(null);
  if (!session) return null;
  const { appts } = session;
  const first = appts[0];
  const scheduled = appts.filter((a) => a.status === 'scheduled');
  return (
    <>
      <Modal open onClose={onClose} title={`جلسة ${KIND_LABEL[first.kind]} — ${appts.length} طلاب`}
        footer={
          scheduled.length > 0 && (canManage || canCancel) ? (
            <>
              {canManage && <button className="btn" type="button" onClick={() => onAddStudent(session)}><Icon name="plus" /> إضافة طالب للجلسة</button>}
              {canManage && <button className="btn btn-secondary" type="button" onClick={() => onMove(session)}>نقل الجلسة</button>}
              <button className="btn btn-ghost" type="button" onClick={() => setConfirm('session')}>إلغاء الجلسة</button>
              {first.series_id && <button className="btn btn-ghost" type="button" onClick={() => setConfirm('series')}><Icon name="repeat" size={14} /> إلغاء السلسلة القادمة</button>}
            </>
          ) : null
        }>
        <dl className="kv">
          <dt>الموعد</dt><dd>{fmtWeekday(first.start_at)} {fmtDate(first.start_at)} • {fmtTime(first.start_at)} – {fmtTime(first.end_at)}</dd>
          {first.supervisor_name && <><dt>المشرف</dt><dd><span className="sup-dot" style={{ background: colorFor(first.supervisor_id) }} /> {first.supervisor_name} ({GROUP_LABEL[first.supervisor_type] || '—'})</dd></>}
          {first.surah && <><dt>السورة</dt><dd>{first.surah}</dd></>}
          {first.series_id && <><dt>التكرار</dt><dd>جزء من سلسلة متكررة</dd></>}
        </dl>
        <h3 style={{ margin: '14px 0 6px' }}>الطلاب</h3>
        <ul className="list-plain">
          {appts.map((a) => (
            <li key={a.id} style={{ cursor: 'pointer' }} onClick={() => onOpenAppt(a)}>
              <span>{a.student_name}</span>
              <Badge tone={APPT_STATUS[a.status].tone}>{APPT_STATUS[a.status].label}</Badge>
            </li>
          ))}
        </ul>
      </Modal>
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} tone="warn" title={confirm === 'series' ? 'إلغاء السلسلة المتكررة' : 'إلغاء الجلسة'} confirmText="نعم، إلغاء"
        onConfirm={async () => {
          const r = confirm === 'series'
            ? await api.post(`/appointments/series/${first.series_id}/cancel`)
            : await api.post(`/appointments/sessions/${first.session_id}/cancel`);
          toast.success(`أُلغي ${r.cancelled} موعدًا`);
          setConfirm(null);
          onChanged();
          onClose();
        }}>
        {confirm === 'series' ? 'ستُلغى كل المواعيد القادمة في هذه السلسلة لكل طلابها.' : `ستُلغى مواعيد ${scheduled.length} طالب في هذه الجلسة.`}
      </ConfirmDialog>
    </>
  );
}

export default function CalendarPage() {
  const { isAdmin, isSupervisor, settings, n } = useAuth();
  const toast = useToast();
  const [range, setRange] = useState(null);
  const [filters, setFilters] = useState({ supervisor_id: '', group: '', kind: '', q: '', cancelled: false });
  const [detail, setDetail] = useState(null);
  const [session, setSession] = useState(null);
  const [form, setForm] = useState(null); // { appointment?, initial? }
  const [move, setMove] = useState(null);

  const { data: students } = useLoad(() => (isSupervisor ? api.get('/students') : Promise.resolve({ students: [] })), [isSupervisor]);
  const { data: sups } = useLoad(() => (isAdmin ? api.get('/supervisors') : Promise.resolve({ supervisors: [] })), [isAdmin]);

  const { data, error, reload } = useLoad(
    async () => {
      if (!range) return { appointments: [] };
      return api.get(`/appointments${qs({ from: range.start, to: range.end, supervisor_id: filters.supervisor_id, group: filters.group, kind: filters.kind, include_cancelled: filters.cancelled ? 'true' : 'false' })}`);
    },
    [range?.start, range?.end, filters.supervisor_id, filters.group, filters.kind, filters.cancelled]
  );

  // تجميع طلاب الجلسة الواحدة في حدث واحد — كل جلسة تظهر مستقلة دون أن تستبدل غيرها
  const { events, legend } = useMemo(() => {
    const list = (data?.appointments || []).filter((a) => !filters.q || norm(`${a.student_name} ${a.supervisor_name}`).includes(norm(filters.q)));
    const groups = new Map();
    for (const a of list) {
      const key = a.session_id || a.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const now = new Date();
    const usedSups = new Map();
    const evs = [...groups.entries()].map(([key, appts]) => {
      const a = appts[0];
      const color = isAdmin ? colorFor(a.supervisor_id) : undefined;
      if (isAdmin && a.supervisor_id) usedSups.set(a.supervisor_id, { name: a.supervisor_name, color });
      const allStatus = new Set(appts.map((x) => x.status));
      const status = allStatus.size === 1 ? a.status : 'scheduled';
      const overdue = appts.some((x) => x.status === 'scheduled' && new Date(x.end_at) < now);
      const isSession = appts.length > 1 || !!a.session_id;
      const title = isSession
        ? `${KIND_LABEL[a.kind]} جماعي • ${appts.length} طلاب${isAdmin && a.supervisor_name ? ` • ${a.supervisor_name}` : ''}`
        : isAdmin && a.supervisor_name
          ? `${apptTitle(a)} • ${a.supervisor_name}`
          : apptTitle(a);
      return {
        id: key,
        title: `${a.series_id ? '↻ ' : ''}${title}`,
        start: a.start_at,
        end: a.end_at,
        editable: (isSupervisor || isAdmin) && status === 'scheduled' && !overdue,
        backgroundColor: color,
        borderColor: color,
        classNames: [`ev-${a.kind}`, status !== 'scheduled' ? `ev-${status}` : '', overdue ? 'ev-pending' : '', isAdmin ? 'ev-colored' : ''],
        extendedProps: { appts, isSession },
      };
    });
    return { events: evs, legend: [...usedSups.values()] };
  }, [data, filters.q, isAdmin, isSupervisor]);

  const onDrop = useCallback(
    async (info) => {
      const { appts, isSession } = info.event.extendedProps;
      try {
        if (isSession && appts[0].session_id) await api.put(`/appointments/sessions/${appts[0].session_id}`, { start_at: info.event.start.toISOString() });
        else await api.put(`/appointments/${appts[0].id}`, { start_at: info.event.start.toISOString() });
        toast.success('تمت إعادة الجدولة');
        reload();
      } catch (e) {
        info.revert();
        toast.error(e.message);
      }
    },
    [reload, toast]
  );

  const openNew = (date, allDay) => {
    if (!isSupervisor) return;
    const isPast = !allDay && date < new Date(Date.now() - 120000);
    if (allDay && localISODate(date) < localISODate()) return toast.info('اختر يومًا قادمًا للحجز، أو استخدم «تسجيل تسميع سابق».');
    if (isPast) return toast.info('لا يمكن الحجز في وقت مضى. لتسجيل تسميع سابق استخدم الزر المخصص.');
    setForm({ initial: { date: localISODate(date), time: allDay ? '16:00' : localHM(date) } });
  };

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 700;
  const setV = (k) => (v) => setFilters((x) => ({ ...x, [k]: v }));
  const setF = (k) => (e) => setFilters((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <>
      <PageHeader
        title="التقويم"
        subtitle={isAdmin ? 'كل جلسات المشرفين — جلسات متزامنة لمشرفين مختلفين تظهر مستقلة بلون كل مشرف' : 'اضغط على يوم أو ساعة للحجز (طالب أو جلسة جماعية)، واسحب الجلسة لإعادة جدولتها'}
        actions={
          isSupervisor && (
            <>
              <button className="btn" onClick={() => setForm({ initial: {} })} type="button"><Icon name="plus" /> حجز موعد / جلسة</button>
              <button className="btn btn-ghost" onClick={() => setForm({ initial: { past: true } })} type="button"><Icon name="clock" /> تسجيل تسميع سابق</button>
            </>
          )
        }
      />

      <div className="toolbar cal-filters">
        {isAdmin && (
          <>
            <Dropdown
              label="المشرف"
              icon="users"
              value={filters.supervisor_id}
              onChange={setV('supervisor_id')}
              searchable={(sups?.supervisors || []).length > 7}
              options={[
                { value: '', label: 'كل المشرفين' },
                ...(sups?.supervisors || []).map((s) => ({ value: s.id, label: s.full_name, hint: GROUP_LABEL[s.supervisor_type] })),
              ]}
            />
            <Dropdown
              label="الفئة"
              icon="sliders"
              value={filters.group}
              onChange={setV('group')}
              options={[{ value: '', label: 'كل الفئات' }, ...Object.entries(GROUP_LABEL).map(([k, v]) => ({ value: k, label: v }))]}
            />
          </>
        )}
        <Dropdown
          label="نوع الموعد"
          icon="book"
          value={filters.kind}
          onChange={setV('kind')}
          options={[{ value: '', label: 'تسميع وامتحانات' }, ...Object.entries(KIND_LABEL).map(([k, v]) => ({ value: k, label: v }))]}
        />
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder={isAdmin ? 'بحث بالطالب أو المشرف' : `بحث باسم ${n.one}`} value={filters.q} onChange={setF('q')} aria-label="بحث" /></div>
        <label className="check small"><input type="checkbox" checked={filters.cancelled} onChange={setF('cancelled')} /> إظهار الملغاة</label>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="card">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, luxonPlugin]}
          timeZone={APP_TZ}
          locale={arLocale}
          direction="rtl"
          firstDay={6}
          initialView={isMobile ? 'listWeek' : 'timeGridWeek'}
          headerToolbar={isMobile ? { start: 'prev,next', center: 'title', end: 'today' } : { start: 'prev,next today', center: 'title', end: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' }}
          footerToolbar={isMobile ? { center: 'dayGridMonth,timeGridDay,listWeek' } : undefined}
          buttonText={{ today: 'اليوم', month: 'شهر', week: 'أسبوع', day: 'يوم', list: 'قائمة' }}
          height="auto"
          contentHeight={isMobile ? undefined : 720}
          slotMinTime={`${settings.work_start}:00`}
          slotMaxTime={`${settings.work_end}:00`}
          slotDuration="00:30:00"
          scrollTime="08:00:00"
          allDaySlot={false}
          nowIndicator
          navLinks
          dayMaxEvents={4}
          slotEventOverlap={false}
          eventTimeFormat={{ hour: 'numeric', minute: '2-digit', hour12: true }}
          events={events}
          editable={isSupervisor || isAdmin}
          eventDurationEditable={false}
          eventDrop={onDrop}
          datesSet={(arg) => setRange((r) => (r?.start === arg.start.toISOString() && r?.end === arg.end.toISOString() ? r : { start: arg.start.toISOString(), end: arg.end.toISOString() }))}
          dateClick={(info) => openNew(info.date, info.allDay || info.view.type === 'dayGridMonth')}
          eventClick={(info) => {
            const { appts, isSession } = info.event.extendedProps;
            if (isSession) setSession({ appts });
            else setDetail(appts[0]);
          }}
          noEventsContent="لا توجد مواعيد في هذه الفترة"
        />
        <div className="cal-legend">
          {isAdmin ? (
            legend.length ? legend.map((l) => <span key={l.name}><i style={{ background: l.color }} />{l.name}</span>) : <span className="muted">ألوان المشرفين تظهر هنا</span>
          ) : (
            <>
              <span><i style={{ background: 'var(--primary)' }} />تسميع محجوز</span>
              <span><i style={{ background: '#b8860b' }} />امتحان سورة</span>
            </>
          )}
          <span><i style={{ background: 'var(--success)' }} />تم</span>
          <span><i style={{ background: 'var(--danger)' }} />لم يلتزم</span>
          <span><i style={{ background: 'transparent', border: '2px dashed var(--warn)' }} />بانتظار تسجيل النتيجة</span>
          <span>↻ متكرر</span>
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>الأوقات بتوقيت فلسطين ({APP_TZ}). {isSupervisor && <Link to="/my-record">متابعة سجلاتك</Link>}</p>
      </div>

      <AppointmentForm
        open={!!form}
        onClose={() => setForm(null)}
        onSaved={reload}
        students={students?.students || []}
        appointment={form?.appointment || null}
        initial={form?.initial || {}}
      />
      <AppointmentDetail
        appointment={detail}
        canManage={isSupervisor}
        canCancel={isAdmin}
        onClose={() => setDetail(null)}
        onChanged={reload}
        onEdit={(a) => { setDetail(null); setForm({ appointment: a }); }}
      />
      <SessionDetail
        session={session}
        canManage={isSupervisor}
        canCancel={isAdmin}
        onClose={() => setSession(null)}
        onChanged={reload}
        onOpenAppt={(a) => { setSession(null); setDetail(a); }}
        onAddStudent={(s) => {
          const a = s.appts[0];
          setSession(null);
          setForm({ initial: { join_session_id: a.session_id, date: localISODate(new Date(a.start_at)), time: localHM(new Date(a.start_at)), kind: a.kind } });
        }}
        onMove={(s) => { setSession(null); setMove({ appts: s.appts, date: localISODate(new Date(s.appts[0].start_at)), time: localHM(new Date(s.appts[0].start_at)) }); }}
      />
      <MoveSession move={move} onClose={() => setMove(null)} onDone={reload} />
    </>
  );
}

function MoveSession({ move, onClose, onDone }) {
  const toast = useToast();
  const [v, setV] = useState(null);
  const cur = v || move;
  if (!move) return null;
  return (
    <ConfirmDialog open onClose={() => { setV(null); onClose(); }} tone="primary" title="نقل الجلسة الجماعية" confirmText="نقل"
      onConfirm={async () => {
        const r = await api.put(`/appointments/sessions/${move.appts[0].session_id}`, { start_at: toISO(cur.date, cur.time) });
        toast.success(`نُقلت مواعيد ${r.moved} طالب`);
        setV(null);
        onClose();
        onDone();
      }}>
      <div className="form-grid">
        <label className="field"><span className="field-label">التاريخ</span><input type="date" className="input" value={cur.date} onChange={(e) => setV({ ...cur, date: e.target.value })} /></label>
        <label className="field"><span className="field-label">الوقت</span><input type="time" className="input" value={cur.time} onChange={(e) => setV({ ...cur, time: e.target.value })} /></label>
      </div>
      <p className="small muted">يُتحقق من تعارض كل طالب في الجلسة قبل النقل.</p>
    </ConfirmDialog>
  );
}
