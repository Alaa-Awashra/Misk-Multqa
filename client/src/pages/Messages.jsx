import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth } from '../context/Auth.jsx';
import { useToast } from '../context/Toast.jsx';
import { useSummary } from '../context/Summary.jsx';
import { Alert, Avatar, Badge, CountBadge, Dropdown, Empty, Field, Icon, Modal, PageHeader, Spinner } from '../components/ui.jsx';
import { CONV_CATEGORY, CONV_STATUS } from '../lib/labels.js';
import { fmtDate, fmtTime, norm, relativeTime } from '../lib/format.js';

const POLL_THREAD = 8_000;
const POLL_LIST = 20_000;

/** يستدعي fn دوريًا ما دام التبويب ظاهرًا */
function usePoll(fn, ms, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const tick = () => !document.hidden && fn();
    const t = setInterval(tick, ms);
    const onVis = () => !document.hidden && fn();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fn, ms, enabled]);
}

function Thread({ id, onChanged }) {
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const { refresh } = useSummary();
  const [conv, setConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [otherRead, setOtherRead] = useState(null);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);
  const lastId = useRef(0);

  const load = useCallback(
    async (initial = false) => {
      try {
        const d = await api.get(`/messages/conversations/${id}${qs({ after: initial ? 0 : lastId.current })}`);
        setConv(d.conversation);
        setOtherRead(d.other_last_read_at);
        if (initial) setMessages(d.messages);
        else if (d.messages.length) setMessages((m) => [...m, ...d.messages.filter((x) => !m.some((y) => y.id === x.id))]);
        if (d.messages.length) {
          lastId.current = d.messages[d.messages.length - 1].id;
          refresh();
          onChanged(); // تحديث عدّاد غير المقروء في القائمة
        }
        setError('');
      } catch (e) {
        setError(e.message);
      }
    },
    [id, refresh, onChanged]
  );

  useEffect(() => {
    lastId.current = 0;
    setConv(null);
    setMessages([]);
    load(true);
  }, [id, load]);
  usePoll(useCallback(() => load(false), [load]), POLL_THREAD);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [messages.length]);

  const send = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    try {
      const r = await api.post(`/messages/conversations/${id}/messages`, { body });
      setMessages((m) => [...m, r.message]);
      lastId.current = r.message.id;
      setBody('');
      onChanged();
      load(false);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (status) => {
    try {
      await api.post(`/messages/conversations/${id}/status`, { status });
      toast.success('تم تحديث الحالة');
      load(false);
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (error && !conv) return <Alert tone="danger">{error}</Alert>;
  if (!conv) return <Spinner />;
  const st = CONV_STATUS[conv.status];

  return (
    <div className="chat">
      <div className="chat-head">
        <div>
          <b>{conv.subject}</b>
          <div className="small muted">
            {CONV_CATEGORY[conv.category]} • {isAdmin ? conv.owner_name : 'الإدارة'} • <Badge tone={st.tone}>{st.label}</Badge>
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {isAdmin ? (
            <Dropdown
              size="sm"
              label="حالة المحادثة"
              value={conv.status}
              onChange={setStatus}
              options={Object.entries(CONV_STATUS).map(([k, v]) => ({ value: k, label: v.label }))}
            />
          ) : (
            conv.status !== 'closed' && <button className="btn btn-sm btn-ghost" type="button" onClick={() => setStatus('closed')}>إغلاق المحادثة</button>
          )}
        </div>
      </div>
      <div className="chat-body" aria-live="polite">
        {messages.map((m, i) => {
          const mine = m.sender_id === user.id;
          const day = fmtDate(m.created_at);
          const showDay = i === 0 || fmtDate(messages[i - 1].created_at) !== day;
          return (
            <div key={m.id}>
              {showDay && <div className="chat-day">{day}</div>}
              <div className={`bubble ${mine ? 'mine' : 'theirs'}`}>
                {!mine && <div className="bubble-name">{m.sender_role === 'admin' ? 'الإدارة' : m.sender_name}</div>}
                <div className="bubble-text">{m.body}</div>
                <div className="bubble-meta">
                  {fmtTime(m.created_at)}
                  {mine && <span title={otherRead && otherRead >= m.created_at ? 'مقروءة' : 'مرسلة'}>{otherRead && new Date(otherRead) >= new Date(m.created_at) ? ' ✓✓' : ' ✓'}</span>}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <form className="chat-input" onSubmit={send}>
        <textarea
          className="textarea"
          placeholder={conv.status === 'closed' && !isAdmin ? 'المحادثة مغلقة — إرسال رسالة سيعيد فتحها' : 'اكتب رسالتك…'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(e);
            }
          }}
          maxLength={5000}
          aria-label="نص الرسالة"
        />
        <button className="btn" type="submit" disabled={sending || !body.trim()} aria-label="إرسال"><Icon name="send" /> إرسال</button>
      </form>
    </div>
  );
}

export default function Messages() {
  const { id } = useParams();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [compose, setCompose] = useState(false);
  const [f, setF] = useState({ subject: '', category: 'question', body: '' });
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    try {
      setList((await api.get(`/messages/conversations${qs({ status: filter })}`)).conversations);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [filter]);
  useEffect(() => {
    loadList();
  }, [loadList]);
  usePoll(loadList, POLL_LIST);

  const shown = useMemo(() => (list || []).filter((c) => !q || norm(`${c.subject} ${c.owner_name} ${c.last_body}`).includes(norm(q))), [list, q]);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/messages/conversations', f);
      toast.success('أُرسلت رسالتك إلى الإدارة');
      setCompose(false);
      setF({ subject: '', category: 'question', body: '' });
      await loadList();
      navigate(`/messages/${r.id}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={isAdmin ? 'رسائل المشرفين' : 'التواصل مع الإدارة'}
        subtitle={isAdmin ? 'محادثات خاصة مع كل مشرف — لا يرى أي مشرف محادثات غيره' : 'أرسل استفساراتك وشكاواك واقتراحاتك للإدارة مباشرة وبشكل خاص'}
        actions={!isAdmin && <button className="btn" type="button" onClick={() => setCompose(true)}><Icon name="plus" /> محادثة جديدة</button>}
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className={`messenger ${id ? 'has-thread' : ''}`}>
        <div className="conv-list card card-flush">
          <div className="conv-tools">
            <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="بحث" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في المحادثات" /></div>
            <Dropdown
              label="الحالة"
              icon="sliders"
              value={filter}
              onChange={setFilter}
              options={[{ value: '', label: 'كل الحالات' }, ...Object.entries(CONV_STATUS).map(([k, v]) => ({ value: k, label: v.label }))]}
            />
          </div>
          {list === null ? <Spinner /> : shown.length === 0 ? (
            <Empty icon="message" title="لا توجد محادثات" hint={isAdmin ? 'تظهر هنا رسائل المشرفين فور إرسالها.' : 'ابدأ محادثة جديدة مع الإدارة من الزر أعلاه.'} />
          ) : (
            <ul className="conv-items">
              {shown.map((c) => (
                <li key={c.id}>
                  <button type="button" className={`conv-item ${c.id === id ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => navigate(`/messages/${c.id}`)}>
                    <Avatar name={isAdmin ? c.owner_name : 'الإدارة'} size={36} />
                    <span className="conv-main">
                      <span className="conv-top"><b>{isAdmin ? c.owner_name : c.subject}</b><span className="small muted">{relativeTime(c.last_message_at)}</span></span>
                      {isAdmin && <span className="small">{c.subject}</span>}
                      <span className="small muted conv-last">{c.last_body}</span>
                      <span className="conv-top"><Badge tone={CONV_STATUS[c.status].tone}>{CONV_STATUS[c.status].label}</Badge><CountBadge n={c.unread} /></span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="thread card card-flush">
          {id ? (
            <>
              <button className="btn btn-sm btn-ghost thread-back" type="button" onClick={() => navigate('/messages')}>→ كل المحادثات</button>
              <Thread id={id} onChanged={loadList} />
            </>
          ) : (
            <Empty icon="message" title="اختر محادثة" hint="اختر محادثة من القائمة لعرض الرسائل." />
          )}
        </div>
      </div>

      <Modal open={compose} onClose={() => setCompose(false)} title="محادثة جديدة مع الإدارة" persistent={busy}
        footer={<><button className="btn" form="conv-form" type="submit" disabled={busy}>{busy ? 'جارٍ الإرسال…' : 'إرسال'}</button><button className="btn btn-ghost" type="button" onClick={() => setCompose(false)}>إلغاء</button></>}>
        <form id="conv-form" onSubmit={create}>
          <div className="form-grid">
            <Field label="الموضوع" required>{(fid) => <input id={fid} className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required maxLength={150} />}</Field>
            <Field label="النوع">
              {(fid) => (
                <select id={fid} className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                  {Object.entries(CONV_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              )}
            </Field>
            <Field label="الرسالة" required className="full">{(fid) => <textarea id={fid} className="textarea" style={{ minHeight: 120 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required maxLength={5000} />}</Field>
          </div>
        </form>
      </Modal>
    </>
  );
}
