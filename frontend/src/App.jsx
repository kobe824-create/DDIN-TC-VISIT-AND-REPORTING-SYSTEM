import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { ToastProvider } from './components/Toast';
import { NetworkProvider } from './NetworkContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import ForgotPassword from './pages/ForgotPassword';
import Dashboard from './pages/Dashboard';
import AgentList from './pages/AgentList';
import AgentForm from './pages/AgentForm';
import AgentDetail from './pages/AgentDetail';
import MoolaPlusAgentDetail from './pages/MoolaPlusAgentDetail';
import IremboAgentDetail from './pages/IremboAgentDetail';
import VisitList from './pages/VisitList';
import FieldPlans from './pages/FieldPlans';
import VisitWorkflow from './pages/VisitWorkflow';
import VisitDetail from './pages/VisitDetail';
import UserList from './pages/UserList';
import UserForm from './pages/UserForm';
import TerritoryList from './pages/TerritoryList';
import TerritoryForm from './pages/TerritoryForm';
import Reports from './pages/Reports';
import ConfigPage from './pages/ConfigPage';
import AuditLogs from './pages/AuditLogs';
import ProfilePage from './pages/ProfilePage';
import BulkImport from './pages/BulkImport';
import SectorGroups from './pages/SectorGroups';
import NetworkNotice from './components/NetworkNotice';
import { MOOLA_PLUS_NETWORK, useNetwork } from './NetworkContext';

const ProtectedRoute = ({ children, allowedRoles }) => {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) return <Navigate to="/login" />;
  if (user?.mustChangePassword && location.pathname !== '/profile') return <Navigate to="/profile" replace />;
  if (allowedRoles && !allowedRoles.includes(user?.role)) {
    return <Navigate to={user?.role === 'AGENT' ? '/profile' : '/dashboard'} replace />;
  }
  return children;
};

const IremboOnlyRoute = ({ children, title = 'Irembo workflow' }) => {
  const { network } = useNetwork();
  return network === MOOLA_PLUS_NETWORK
    ? <NetworkNotice title={title} description="This workflow is connected to Irembo agent records." />
    : children;
};

const NetworkAgentDetail = () => {
  const { network } = useNetwork();
  return network === MOOLA_PLUS_NETWORK ? <MoolaPlusAgentDetail /> : <AgentDetail />;
};

const AppRoutes = () => {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/" element={<Navigate to="/dashboard" />} />

      {/* Protected routes with Layout */}
      <Route element={<Layout />}>
        <Route path="/dashboard" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC', 'CHAMPION']}><Dashboard /></ProtectedRoute>} />

        {/* Visits */}
        <Route path="/visits/plans" element={<ProtectedRoute allowedRoles={['TC']}><FieldPlans /></ProtectedRoute>} />
        <Route path="/visits" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC', 'CHAMPION']}><VisitList /></ProtectedRoute>} />
        <Route path="/visits/new" element={<ProtectedRoute allowedRoles={['TC']}><VisitWorkflow /></ProtectedRoute>} />
        <Route path="/visits/:id" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC', 'CHAMPION']}><VisitDetail /></ProtectedRoute>} />

        {/* Agents */}
        <Route path="/agents" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC', 'CHAMPION']}><AgentList /></ProtectedRoute>} />
        <Route path="/irembo/agents/:id" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC', 'CHAMPION']}><IremboAgentDetail /></ProtectedRoute>} />
        <Route path="/moola-plus/agents/:id" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC', 'CHAMPION']}><MoolaPlusAgentDetail /></ProtectedRoute>} />
        <Route path="/sector-groups" element={<ProtectedRoute allowedRoles={['TC']}><SectorGroups /></ProtectedRoute>} />
        <Route path="/agents/new" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC']}><IremboOnlyRoute title="Register an Irembo agent"><AgentForm /></IremboOnlyRoute></ProtectedRoute>} />
        <Route path="/agents/:id" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC', 'CHAMPION']}><NetworkAgentDetail /></ProtectedRoute>} />
        <Route path="/agents/:id/edit" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER']}><IremboOnlyRoute title="Edit an Irembo agent"><AgentForm /></IremboOnlyRoute></ProtectedRoute>} />

        {/* Users */}
        <Route path="/users" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER']}><UserList /></ProtectedRoute>} />
        <Route path="/users/new" element={<ProtectedRoute allowedRoles={['ADMIN']}><UserForm /></ProtectedRoute>} />
        <Route path="/users/:id/edit" element={<ProtectedRoute allowedRoles={['ADMIN']}><UserForm /></ProtectedRoute>} />
        <Route path="/bulk-import" element={<ProtectedRoute allowedRoles={['ADMIN', 'TC']}><IremboOnlyRoute title="Irembo agent registration"><BulkImport /></IremboOnlyRoute></ProtectedRoute>} />

        {/* Territories */}
        <Route path="/territories" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER']}><TerritoryList /></ProtectedRoute>} />
        <Route path="/territories/new" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER']}><TerritoryForm /></ProtectedRoute>} />
        <Route path="/territories/:id/edit" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER']}><TerritoryForm /></ProtectedRoute>} />

        {/* Reports */}
        <Route path="/reports" element={<ProtectedRoute allowedRoles={['ADMIN', 'MANAGER', 'TC', 'CHAMPION']}><Reports /></ProtectedRoute>} />

        {/* Admin */}
        <Route path="/config" element={<ProtectedRoute allowedRoles={['ADMIN']}><ConfigPage /></ProtectedRoute>} />
        <Route path="/audit-logs" element={<ProtectedRoute allowedRoles={['ADMIN']}><AuditLogs /></ProtectedRoute>} />

        {/* Profile & Notifications */}
        <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
      </Route>
    </Routes>
  );
};

const App = () => (
  <AuthProvider>
    <NetworkProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </NetworkProvider>
  </AuthProvider>
);

export default App;
