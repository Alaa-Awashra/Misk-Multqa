import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import ErrorBoundary from './ErrorBoundary.jsx';
import { useAuth } from '../context/Auth.jsx';
import { useSummary } from '../context/Summary.jsx';
import { api } from '../api.js';
import { Avatar, CountBadge, Icon } from './ui.jsx';
import { BRAND } from '../lib/brand.js';
import { roleLabel } from '../lib/labels.js';
import { fmtDate, relativeTime } from '../lib/format.js';

function NotificationBell() {
  const { summary, refresh } = useSummary();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return undefined;
    api.get('/notifications?limit=25').then((d) => setItems(d.notifications)).catch(() => setItems([]));
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const go = async (n) => {
    setOpen(false);
    if (!n.read_at) await api.post(`/notifications/${n.id}/read`).catch(() => {});
    refresh();
    if (n.link) navigate(n.link);
  };
  const readAll = async () => {
    await api.post('/notifications/read-all').catch(() => {});
    setItems((xs) => xs?.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })));
    refresh();
  };

  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn bell-btn" type="button" onClick={() => setOpen((o) => !o)} aria-label={`الإشعارات (${summary.notifications} غير مقروء)`} aria-expanded={open}>
        <Icon name="bell" size={20} />
        <CountBadge n={summary.notifications} />
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="الإشعارات">
          <div className="bell-head">
            <b>الإشعارات</b>
            {summary.notifications > 0 && (
              <button className="btn btn-sm btn-ghost" type="button" onClick={readAll}>تعليم الكل كمقروء</button>
            )}
          </div>
          {items === null ? (
            <div className="muted small center" style={{ padding: 18 }}>جارٍ التحميل…</div>
          ) : items.length === 0 ? (
            <div className="muted small center" style={{ padding: 18 }}>لا توجد إشعارات بعد.</div>
          ) : (
            <ul className="bell-list">
              {items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={n.read_at ? '' : 'unread'} onClick={() => go(n)}>
                    <b>{n.title}</b>
                    {n.body && <span className="small muted bell-body">{n.body}</span>}
                    <span className="small muted">{relativeTime(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const NAV_KEY = 'mq.nav.groups';

function matches(pathname, l) {
  return l.end ? pathname === l.to : pathname === l.to || pathname.startsWith(`${l.to}/`);
}

function NavItem({ l, sub }) {
  return (
    <NavLink to={l.to} end={l.end} className={({ isActive }) => `${sub ? 'nav-sub' : ''} ${isActive ? 'active' : ''}`.trim()}>
      <Icon name={l.icon} size={sub ? 16 : 18} />
      <span className="nav-label">{l.label}</span>
      <CountBadge n={l.count} />
    </NavLink>
  );
}

// القائمة الجانبية: روابط مفردة + مجموعات قابلة للطي، وشريط تمرير يظهر فقط عند الحاجة
function SideNav({ links }) {
  const { pathname } = useLocation();
  const navRef = useRef(null);
  const innerRef = useRef(null);
  const [openGroups, setOpenGroups] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(NAV_KEY)) || {};
    } catch {
      return {};
    }
  });

  // افتح تلقائيًا المجموعة التي تحتوي الصفحة الحالية
  const activeGroup = links.find((l) => l.items?.some((i) => matches(pathname, i)))?.group;
  useEffect(() => {
    if (activeGroup) setOpenGroups((g) => (g[activeGroup] ? g : { ...g, [activeGroup]: true }));
  }, [activeGroup]);

  useEffect(() => {
    try {
      localStorage.setItem(NAV_KEY, JSON.stringify(openGroups));
    } catch {
      /* التخزين غير متاح — لا بأس */
    }
  }, [openGroups]);

  // هل المحتوى أطول من المساحة؟ وأين موضع التمرير؟ — لإظهار الشريط والتلاشي عند الحاجة فقط
  useEffect(() => {
    const el = navRef.current;
    if (!el) return undefined;
    const update = () => {
      const overflow = el.scrollHeight - el.clientHeight > 1;
      el.dataset.scroll = !overflow
        ? 'none'
        : el.scrollTop <= 1
          ? 'top'
          : el.scrollTop + el.clientHeight >= el.scrollHeight - 1
            ? 'bottom'
            : 'middle';
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (innerRef.current) ro?.observe(innerRef.current);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);

  const toggle = (key) => setOpenGroups((g) => ({ ...g, [key]: !g[key] }));

  return (
    <nav className="nav" aria-label="القائمة الرئيسية" ref={navRef} data-scroll="none">
      <div className="nav-list" ref={innerRef}>
        {links.map((l) => {
          if (!l.items) return <NavItem key={l.to} l={l} />;
          const open = !!openGroups[l.group];
          const total = l.items.reduce((a, i) => a + (i.count || 0), 0);
          const panelId = `nav-${l.group}`;
          return (
            <div key={l.group} className={`nav-group${open ? ' open' : ''}${l.group === activeGroup ? ' has-active' : ''}`}>
              <button type="button" className="nav-group-btn" onClick={() => toggle(l.group)} aria-expanded={open} aria-controls={panelId}>
                <Icon name={l.icon} />
                <span className="nav-label">{l.label}</span>
                {!open && <CountBadge n={total} />}
                <span className="nav-chevron" aria-hidden="true"><Icon name="chevron" size={16} /></span>
              </button>
              <div className="nav-group-panel" id={panelId} inert={open ? undefined : ''}>
                <div className="nav-group-items">
                  {l.items.map((i) => <NavItem key={i.to} l={i} sub />)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

export default function Layout() {
  const { user, isAdmin, isRegistrar, n, logout } = useAuth();
  const { summary } = useSummary();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // روابط مفردة + مجموعات قابلة للطي ({ group, label, icon, items })
  const links = isAdmin
    ? [
        { to: '/', label: 'لوحة التحكم', icon: 'home', end: true },
        {
          group: 'admin-people', label: 'الطلاب والمشرفون', icon: 'users',
          items: [
            { to: '/students', label: 'الطلاب', icon: 'user' },
            { to: '/supervisors', label: 'المشرفون', icon: 'users' },
            { to: '/requests', label: 'طلبات المشرفين', icon: 'inbox', count: summary.requests },
          ],
        },
        { to: '/admissions', label: 'القبول والتسجيل', icon: 'clipboard', count: summary.applications },
        {
          group: 'admin-perf', label: 'المتابعة والأداء', icon: 'chart',
          items: [
            { to: '/calendar', label: 'التقويم', icon: 'calendar' },
            { to: '/analytics', label: 'تحليلات الأداء', icon: 'chart' },
            { to: '/reports', label: 'التقارير', icon: 'report' },
            { to: '/compliance', label: 'متابعة السجلات', icon: 'shield' },
          ],
        },
        {
          group: 'admin-comm', label: 'التواصل', icon: 'message',
          items: [
            { to: '/messages', label: 'رسائل المشرفين', icon: 'message', count: summary.messages },
            { to: '/announcements', label: 'الإعلانات والتعاميم', icon: 'megaphone' },
          ],
        },
        {
          group: 'admin-system', label: 'النظام والحساب', icon: 'sliders',
          items: [
            { to: '/settings', label: 'الإعدادات', icon: 'sliders' },
            { to: '/activity', label: 'سجل النشاط', icon: 'activity' },
            { to: '/profile', label: 'ملفي الشخصي', icon: 'user' },
          ],
        },
      ]
    : isRegistrar
      ? [
          { to: '/admissions', label: 'القبول والتسجيل', icon: 'clipboard', count: summary.applications },
          {
            group: 'reg-comm', label: 'التواصل', icon: 'message',
            items: [
              { to: '/announcements', label: 'الإعلانات والتعاميم', icon: 'megaphone', count: summary.announcements },
              { to: '/messages', label: 'التواصل مع الإدارة', icon: 'message', count: summary.messages },
            ],
          },
          { to: '/profile', label: 'ملفي الشخصي', icon: 'user' },
        ]
      : [
          { to: '/', label: 'لوحة التحكم', icon: 'home', end: true },
          {
            group: 'sup-work', label: 'طلابي ومواعيدي', icon: 'book',
            items: [
              { to: '/students', label: n.many, icon: 'users' },
              { to: '/calendar', label: 'التقويم والمواعيد', icon: 'calendar' },
              { to: '/reports', label: 'التقارير', icon: 'report' },
            ],
          },
          {
            group: 'sup-comm', label: 'التواصل مع الإدارة', icon: 'message',
            items: [
              { to: '/messages', label: 'الرسائل', icon: 'message', count: summary.messages },
              { to: '/announcements', label: 'الإعلانات والتعاميم', icon: 'megaphone', count: summary.announcements },
              { to: '/requests', label: 'طلباتي للإدارة', icon: 'inbox' },
            ],
          },
          {
            group: 'sup-account', label: 'حسابي', icon: 'user',
            items: [
              { to: '/my-record', label: 'سجلي ومتابعتي', icon: 'shield' },
              { to: '/profile', label: 'ملفي الشخصي', icon: 'user' },
            ],
          },
        ];

  const needsEmail = !isAdmin && (!user.email || !user.email_verified);

  return (
    <div className="app">
      <div className={`scrim ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <img src={BRAND.logo} alt="" />
          <b>{BRAND.name}</b>
        </div>
        <SideNav links={links} />
        <div className="sidebar-foot">
          <button
            className="btn btn-block"
            style={{ background: '#ffffff1f' }}
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
            type="button"
          >
            <Icon name="logout" /> تسجيل الخروج
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar no-print">
          <button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="القائمة" type="button">
            <Icon name="menu" size={22} />
          </button>
          <span className="muted small hide-mobile">{fmtDate(new Date())}</span>
          <span className="spacer" />
          <NotificationBell />
          <div className="user">
            <div className="user-info">
              <b>{user.full_name}</b>
              {/* لا نكرر الدور إن كان مطابقًا للاسم (مثل «المسؤول الإداري») */}
              {roleLabel(user).trim() !== (user.full_name || '').trim() && <span className="muted small">{roleLabel(user)}</span>}
            </div>
            <Avatar name={user.full_name} />
          </div>
        </header>
        <main className="content">
          {needsEmail && location.pathname !== '/profile' && (
            <div className="alert alert-warn no-print" role="status">
              <Icon name="mail" size={16} />{' '}
              {user.email
                ? 'بريدك الإلكتروني غير مؤكد بعد — لن تصلك إشعارات الإدارة بالبريد حتى تؤكده.'
                : 'أضف بريدك الإلكتروني (إلزامي) لتصلك تحذيرات الإدارة وإعلاناتها.'}{' '}
              <Link to="/profile">{user.email ? 'تأكيد البريد' : 'إضافة البريد'}</Link>
            </div>
          )}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
