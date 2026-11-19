import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/Auth.jsx';
import { Spinner } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Supervisors from './pages/Supervisors.jsx';
import SupervisorDetail from './pages/SupervisorDetail.jsx';
import Students from './pages/Students.jsx';
import StudentDetail from './pages/StudentDetail.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import Reports from './pages/Reports.jsx';
import Profile from './pages/Profile.jsx';
import Settings from './pages/Settings.jsx';
import ActivityPage from './pages/Activity.jsx';
import Requests from './pages/Requests.jsx';
import MyRecord from './pages/MyRecord.jsx';
import Compliance from './pages/Compliance.jsx';
import Analytics from './pages/Analytics.jsx';
import Messages from './pages/Messages.jsx';
import Announcements from './pages/Announcements.jsx';
import Admissions from './pages/Admissions.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';

/**
 * حماية المسارات في الواجهة (الحماية الفعلية على الخادم لكل نقطة API).
 * roles: الأدوار المسموح لها؛ غير المسموح يُعاد لصفحته الرئيسية.
 */
function Protected({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="جارٍ التحميل…" />;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={home(user)} replace />;
  return children;
}

const home = (user) => (user.role === 'registrar' ? '/admissions' : '/');

const ADMIN = ['admin'];
const STAFF = ['admin', 'supervisor'];
const SUP = ['supervisor'];
const ALL = ['admin', 'supervisor', 'registrar'];
const ADMISSIONS = ['admin', 'registrar'];

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="جارٍ التحميل…" />;

  const guard = (roles, el) => <Protected roles={roles}>{el}</Protected>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={home(user)} replace /> : <Login />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route element={guard(ALL, <Layout />)}>
        <Route index element={guard(STAFF, <Dashboard />)} />
        <Route path="students" element={guard(STAFF, <Students />)} />
        <Route path="students/:id" element={guard(STAFF, <StudentDetail />)} />
        <Route path="calendar" element={guard(STAFF, <CalendarPage />)} />
        <Route path="reports" element={guard(STAFF, <Reports />)} />
        <Route path="requests" element={guard(STAFF, <Requests />)} />
        <Route path="my-record" element={guard(SUP, <MyRecord />)} />
        <Route path="messages" element={guard(ALL, <Messages />)} />
        <Route path="messages/:id" element={guard(ALL, <Messages />)} />
        <Route path="announcements" element={guard(ALL, <Announcements />)} />
        <Route path="admissions" element={guard(ADMISSIONS, <Admissions />)} />
        <Route path="profile" element={guard(ALL, <Profile />)} />
        <Route path="supervisors" element={guard(ADMIN, <Supervisors />)} />
        <Route path="supervisors/:id" element={guard(ADMIN, <SupervisorDetail />)} />
        <Route path="analytics" element={guard(ADMIN, <Analytics />)} />
        <Route path="compliance" element={guard(ADMIN, <Compliance />)} />
        <Route path="staff" element={<Navigate to="/supervisors?type=registrar" replace />} />
        <Route path="activity" element={guard(ADMIN, <ActivityPage />)} />
        <Route path="settings" element={guard(ADMIN, <Settings />)} />
      </Route>
      <Route path="*" element={<Navigate to={user ? home(user) : '/login'} replace />} />
    </Routes>
  );
}
