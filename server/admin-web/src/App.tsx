import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './stores/authStore';
import { me } from './api/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Roles } from './pages/Roles';
import { Devices } from './pages/Devices';
import { DeviceDetail } from './pages/DeviceDetail';
import { Policies } from './pages/Policies';
import { Apps } from './pages/Apps';
import { Audit } from './pages/Audit';
import { AccessLog } from './pages/AccessLog';
import { Enrollment } from './pages/Enrollment';
import { Dashboard } from './pages/Dashboard';
import { Groups } from './pages/Groups';
import { Profile } from './pages/Profile';
import { TimeTravel } from './pages/TimeTravel';
import { Settings } from './pages/Settings';
import { ComplianceRules } from './pages/ComplianceRules';
import { AlertChannels } from './pages/AlertChannels';
import { Geofencing } from './pages/Geofencing';
import { AIInsights } from './pages/AIInsights';

function Private({ children }: { children: React.ReactNode }) {
  const token = useAuth(s => s.accessToken);
  const setUser = useAuth(s => s.setUser);
  // Refresh identity+permissions on load so a persisted session (whose stored
  // user predates RBAC, or whose role changed server-side) gets the current
  // permission set. Server remains the source of truth.
  useEffect(() => {
    if (!token) return;
    me().then(u => setUser(u)).catch(() => {});
  }, [token, setUser]);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <Private>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/devices/:id" element={<DeviceDetail />} />
                <Route path="/groups" element={<Groups />} />
                <Route path="/policies" element={<Policies />} />
                <Route path="/roles" element={<Roles />} />
                <Route path="/timetravel" element={<TimeTravel />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/apps" element={<Apps />} />
                <Route path="/enrollment" element={<Enrollment />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/geofencing" element={<Geofencing />} />
                <Route path="/ai-insights" element={<AIInsights />} />
                <Route path="/compliance" element={<ComplianceRules />} />
                <Route path="/alerts" element={<AlertChannels />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="/access-log" element={<AccessLog />} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </Layout>
          </Private>
        }
      />
    </Routes>
  );
}
