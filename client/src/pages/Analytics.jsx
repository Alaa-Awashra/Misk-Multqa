import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, qs } from '../api.js';
import { useToast } from '../context/Toast.jsx';
import { useLoad } from '../lib/hooks.js';
import { Alert, Badge, Empty, HBarChart, Icon, LineChart, PageHeader, Spinner, StatCard, Tabs } from '../components/ui.jsx';
import { BRAND } from '../lib/brand.js';
import { GROUP_LABEL } from '../lib/labels.js';
import { fmtDate, fmtDateShort, fmtNum, fmtPct, norm } from '../lib/format.js';

const GROUP_COLOR = { male: '#1d4f91', female: '#8a3a6b', kids: '#e0771a' };
const changeTone = (v) => (v === null || v === undefined ? 'muted' : v > 0 ? 'success' : v < 0 ? 'danger' : 'muted');

function Change({ v }) {
  if (v === null || v === undefined) return <span className="muted small">جديد</span>;
  return <Badge tone={changeTone(v)}>{v > 0 ? '▲' : v < 0 ? '▼' : '•'} {fmtPct(v)}</Badge>;
}

/** لوحة تحليلات الأداء (للمسؤول) — بيانات حقيقية من قاعدة البيانات */
export default function Analytics() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const reportId = params.get('report') || '';
  const [filters, setFilters] = useState({ from: params.get('from') || '', to: params.get('to') || '', supervisor_id: '', group: '', student_id: '' });
  const [applied, setApplied] = useState(filters);
  const [tab, setTab] = useState('students');
  const [order, setOrder] = useState('desc');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: reports, reload: reloadReports } = useLoad(() => api.get('/analytics/reports'), []);
  const { data: sups } = useLoad(() => api.get('/supervisors'), []);
  const { data, loading, error } = useLoad(
    async () => (reportId ? { ...(await api.get(`/analytics/reports/${reportId}`)).report.data, _report: reportId } : api.get(`/analytics${qs(applied)}`)),
    [reportId, JSON.stringify(applied)]
  );

  const students = useMemo(() => {
    const rows = (data?.students || []).filter((s) => !q || norm(`${s.full_name} ${s.supervisor_name}`).includes(norm(q)));
    return order === 'asc' ? [...rows].reverse() : rows;
  }, [data, order, q]);

  const apply = (e) => {
    e?.preventDefault();
    setParams({});
    setApplied({ ...filters });
  };
  const openReport = (id) => setParams(id ? { report: id } : {});

  const exportXlsx = async () => {
    try {
      await download(`/analytics/export.xlsx${qs(reportId ? { report: reportId } : applied)}`, `تحليلات-${data.period.from}-${data.period.to}.xlsx`);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.post('/analytics/reports/generate');
      toast.success(r.generated.length ? `تم توليد ${r.generated.length} تقرير` : 'كل التقارير المستحقة موجودة بالفعل');
      reloadReports();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const t = data?.totals;
  const trendLabels = (data?.trend || []).map((p) => fmtDateShort(p.to));
  const groupsInTrend = Object.keys(GROUP_LABEL).filter((g) => (data?.trend || []).some((p) => p.by_group?.[g] > 0));

  return (
    <>
      <PageHeader
        title="تحليلات الأداء"
        subtitle="تقرير تلقائي كل 14 يومًا + تحليل مخصص لأي فترة. الحفظ الجديد لا يشمل المراجعة."
        actions={
          data && (
            <>
              <button className="btn" type="button" onClick={exportXlsx}><Icon name="download" /> Excel</button>
              <button className="btn btn-ghost" type="button" onClick={() => window.print()}><Icon name="printer" /> PDF / طباعة</button>
            </>
          )
        }
      />

      <div className="grid grid-main analytics-top no-print" style={{ marginBottom: 16 }}>
        <form className="card" onSubmit={apply}>
          <div className="card-head"><h2>تحليل مخصص</h2></div>
          <div className="form-grid">
            <label className="field"><span className="field-label">من</span><input type="date" className="input" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
            <label className="field"><span className="field-label">إلى</span><input type="date" className="input" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
            <label className="field">
              <span className="field-label">المشرف</span>
              <select className="select" value={filters.supervisor_id} onChange={(e) => setFilters({ ...filters, supervisor_id: e.target.value })}>
                <option value="">الكل</option>
                {(sups?.supervisors || []).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">الفئة</span>
              <select className="select" value={filters.group} onChange={(e) => setFilters({ ...filters, group: e.target.value })}>
                <option value="">الكل</option>
                {Object.entries(GROUP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <button className="btn" type="submit">تحليل</button>
            <span className="muted small">بدون تواريخ = آخر فترة تقرير مكتملة (14 يومًا)</span>
          </div>
        </form>

        <div className="card">
          <div className="card-head">
            <h2>التقارير الدورية</h2>
            <button className="btn btn-sm btn-ghost" type="button" onClick={generate} disabled={busy}><Icon name="refresh" size={14} /> {busy ? '…' : 'توليد المستحق'}</button>
          </div>
          {!reports ? <Spinner /> : reports.reports.length === 0 ? (
            <p className="muted small">لم يُولَّد أي تقرير بعد. يُولَّد التقرير تلقائيًا بعد انتهاء كل فترة 14 يومًا.</p>
          ) : (
            <ul className="list-plain report-list">
              {reports.reports.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`link-btn ${reportId === r.id ? 'active' : ''}`} onClick={() => openReport(r.id)}>
                    {fmtDateShort(r.period_start)} — {fmtDate(r.period_end)}
                  </button>
                  <span className="small">{fmtNum(r.totals?.new_pages, 1)} ص <Change v={r.totals?.change_pct} /></span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {loading && !data ? <Spinner label="جارٍ حساب التحليلات…" /> : data && (
        <div className="report-sheet analytics-sheet">
          <div className="print-only r-brand">{BRAND.name}</div>
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>{data._report ? 'تقرير دوري' : 'تحليل'}: {fmtDate(data.period.from)} — {fmtDate(data.period.to)}</h2>
            <span className="muted small">مقارنة مع {fmtDate(data.previous.from)} — {fmtDate(data.previous.to)}</span>
            {data._report && <button className="btn btn-sm btn-ghost no-print" type="button" onClick={() => openReport('')}>عودة للتحليل المخصص</button>}
          </div>

          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <StatCard label="إجمالي محفوظ الملتقى" value={`${fmtNum(t.forum_total_juz, 1)} جزء`} icon="book" />
            <StatCard label="الحفظ الجديد في الفترة" value={`${fmtNum(t.new_pages, 1)} صفحة`} icon="chart" tone={changeTone(t.change_pct) === 'danger' ? 'danger' : 'success'} hint={`السابقة: ${fmtNum(t.prev_new_pages, 1)} • التغير ${t.change_pct === null ? '—' : fmtPct(t.change_pct)}`} />
            <StatCard label="المشاركة" value={t.participation_rate === null ? '—' : `${t.participation_rate}%`} icon="users" tone="info" hint={`${t.participating} من ${t.students} طالب سمّعوا`} />
            <StatCard label="اكتمال السجلات" value={t.completeness_rate === null ? '—' : `${t.completeness_rate}%`} icon="clipboard" tone={t.completeness_rate !== null && t.completeness_rate < 80 ? 'warn' : 'success'} hint={`الالتزام ${t.commitment_rate === null ? '—' : `${t.commitment_rate}%`} • بلا تقدم ${t.no_progress}`} />
          </div>

          <div className="grid grid-main" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head"><h2>اتجاه الحفظ الجديد (صفحات لكل فترة)</h2></div>
              <LineChart
                labels={trendLabels}
                format={(v) => `${fmtNum(v, 1)} ص`}
                series={[
                  { key: 'all', label: 'الكل', color: '#0f5c4d', values: data.trend.map((p) => p.new_pages) },
                  ...groupsInTrend.map((g) => ({ key: g, label: GROUP_LABEL[g], color: GROUP_COLOR[g], values: data.trend.map((p) => p.by_group[g] || 0) })),
                  { key: 'rev', label: 'مراجعة', color: '#b9c4d6', values: data.trend.map((p) => p.review_pages) },
                ]}
              />
            </div>
            <div className="card">
              <div className="card-head"><h2>مقارنة الفئات</h2></div>
              {data.groups.length === 0 ? <p className="muted">لا بيانات.</p> : (
                <>
                  <HBarChart rows={data.groups.map((g) => ({ key: g.key, label: g.label, value: g.avg_new_pages || 0, color: GROUP_COLOR[g.key], hint: `${g.students} طالب • ${g.new_pages} صفحة` }))} format={(v) => `${fmtNum(v, 1)} ص/طالب`} />
                  <div className="table-wrap" style={{ marginTop: 10 }}><table className="tbl small">
                    <thead><tr><th>الفئة</th><th>طلاب</th><th>صفحات</th><th>التغير</th><th>مشاركة</th></tr></thead>
                    <tbody>{data.groups.map((g) => <tr key={g.key}><td>{g.label}</td><td className="num">{g.students}</td><td className="num">{fmtNum(g.new_pages, 1)}</td><td><Change v={g.change_pct} /></td><td className="num">{g.participation_rate ?? '—'}%</td></tr>)}</tbody>
                  </table></div>
                </>
              )}
            </div>
          </div>

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'students', label: 'ترتيب الطلاب', count: data.students.length },
              { value: 'supervisors', label: 'ترتيب المشرفين', count: data.supervisors.length },
              { value: 'noprogress', label: 'بلا تقدم', count: data.no_progress.length },
            ]}
          />

          {tab === 'students' && (
            <div className="card card-flush">
              <div className="toolbar no-print" style={{ padding: '12px 16px 0' }}>
                <div className="seg-control">
                  <button type="button" className={order === 'desc' ? 'active' : ''} onClick={() => setOrder('desc')}>الأعلى أولًا</button>
                  <button type="button" className={order === 'asc' ? 'active' : ''} onClick={() => setOrder('asc')}>الأدنى أولًا</button>
                </div>
                <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="بحث بالاسم" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث" /></div>
              </div>
              {students.length === 0 ? <Empty icon="users" title="لا يوجد طلاب في هذا النطاق" /> : (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead><tr><th>#</th><th>الطالب</th><th>المشرف</th><th>حفظ جديد</th><th>السابقة</th><th>التغير</th><th>مراجعة</th><th>إجمالي (جزء)</th><th>التزام</th></tr></thead>
                    <tbody>
                      {students.map((s) => (
                        <tr key={s.id}>
                          <td className="num">{s.rank}</td>
                          <td><Link to={`/students/${s.id}`}>{s.full_name}</Link>{s.status !== 'active' && <Badge tone="muted">موقوف</Badge>}</td>
                          <td className="small">{s.supervisor_name || '—'}</td>
                          <td className="num"><b>{fmtNum(s.new_pages, 1)}</b></td>
                          <td className="num muted">{fmtNum(s.prev_new_pages, 1)}</td>
                          <td><Change v={s.change_pct} /></td>
                          <td className="num">{fmtNum(s.review_pages, 1)}</td>
                          <td className="num">{fmtNum(s.total_juz)}</td>
                          <td className="num small">{s.rec_completed}/{s.rec_completed + s.rec_missed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'supervisors' && (
            <div className="card">
              {data.supervisors.length === 0 ? <Empty icon="users" title="لا بيانات" /> : (
                <>
                  <HBarChart rows={data.supervisors.map((s) => ({ key: s.id, label: s.full_name, value: s.avg_new_pages || 0, color: GROUP_COLOR[s.group] }))} format={(v) => `${fmtNum(v, 1)} ص/طالب`} />
                  <div className="table-wrap" style={{ marginTop: 12 }}>
                    <table className="tbl">
                      <thead><tr><th>#</th><th>المشرف</th><th>الطلاب</th><th>حفظ جديد</th><th>متوسط/طالب</th><th>التغير</th><th>الالتزام</th><th>اكتمال السجلات</th><th>بلا تقدم</th></tr></thead>
                      <tbody>
                        {data.supervisors.map((s) => (
                          <tr key={s.id}>
                            <td className="num">{s.rank}</td>
                            <td><Link to={`/supervisors/${s.id}`}>{s.full_name}</Link> <span className="muted small">{GROUP_LABEL[s.group]}</span></td>
                            <td className="num">{s.students}</td>
                            <td className="num">{fmtNum(s.new_pages, 1)}</td>
                            <td className="num"><b>{fmtNum(s.avg_new_pages, 2)}</b></td>
                            <td><Change v={s.change_pct} /></td>
                            <td className="num">{s.commitment_rate ?? '—'}%</td>
                            <td className="num">{s.completeness_rate ?? '—'}%</td>
                            <td className="num">{s.no_progress}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'noprogress' && (
            <div className="card">
              {data.no_progress.length === 0 ? <Empty icon="check" title="كل الطلاب حققوا تقدمًا في هذه الفترة" /> : (
                <ul className="list-plain">
                  {data.no_progress.map((s) => (
                    <li key={s.id}>
                      <span><Link to={`/students/${s.id}`}>{s.full_name}</Link> <span className="muted small">— {s.supervisor_name || 'بلا مشرف'}</span></span>
                      <span className="small muted">{s.rec_missed ? `${s.rec_missed} غياب` : 'لا تسميع'}{s.review_pages ? ` • مراجعة ${s.review_pages} ص` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <p className="small muted" style={{ marginTop: 12 }}>
            التعريفات: {data.definitions.new_pages}. إجمالي المحفوظ = {data.definitions.total_juz}. اكتمال السجلات = {data.definitions.completeness}.
          </p>
        </div>
      )}
    </>
  );
}
