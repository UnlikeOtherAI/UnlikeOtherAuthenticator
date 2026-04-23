import { Navigate, Route, Routes } from 'react-router-dom';

import { AdminSessionGuard } from '../features/auth/admin-session';
import { AdminUiProvider } from '../features/shell/admin-ui';
import { AdminLayout } from '../layouts/AdminLayout';
import { AdminAuthCallbackPage } from '../pages/AdminAuthCallbackPage';
import { ConnectionErrorsPage } from '../pages/ConnectionErrorsPage';
import { FeatureAudienceGroupPage } from '../pages/FeatureAudienceGroupPage';
import { FeatureFlagDetailPage } from '../pages/FeatureFlagDetailPage';
import { FeatureFlagsPage } from '../pages/AppsFlagsPage';
import { DashboardPage } from '../pages/DashboardPage';
import { DirectoryDomainsPage } from '../pages/DirectoryDomainsPage';
import { DomainDetailPage } from '../pages/DomainDetailPage';
import { IntegrationRequestsPage } from '../pages/IntegrationRequestsPage';
import { LogsPage } from '../pages/LogsPage';
import { SecretsPage } from '../pages/SecretsPage';
import { LoginPage } from '../pages/LoginPage';
import { OrganisationDetailPage } from '../pages/OrganisationDetailPage';
import { OrganisationsPage } from '../pages/OrganisationsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { SuperUsersPage } from '../pages/SuperUsersPage';
import { TeamDetailPage } from '../pages/TeamDetailPage';
import { UserDetailPage } from '../pages/UserDetailPage';
import { TeamsPage } from '../pages/TeamsPage';
import { UsersPage } from '../pages/UsersPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AdminAuthCallbackPage />} />
      <Route
        element={
          <AdminSessionGuard>
            <AdminUiProvider>
              <AdminLayout />
            </AdminUiProvider>
          </AdminSessionGuard>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="integrations" element={<IntegrationRequestsPage />} />
        <Route path="secrets" element={<SecretsPage />} />
        <Route path="domains" element={<DirectoryDomainsPage />} />
        <Route path="domains/:domainId" element={<DomainDetailPage />} />
        <Route path="organisations" element={<OrganisationsPage />} />
        <Route path="organisations/:orgId" element={<OrganisationDetailPage />} />
        <Route path="organisations/:orgId/teams/:teamId" element={<TeamDetailPage />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:userId" element={<UserDetailPage />} />
        <Route path="superusers" element={<SuperUsersPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="connection-errors" element={<ConnectionErrorsPage />} />
        <Route path="feature-flags" element={<FeatureFlagsPage />} />
        <Route path="feature-flags/:appId/groups/:groupId" element={<FeatureAudienceGroupPage />} />
        <Route path="feature-flags/:appId" element={<FeatureFlagDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
