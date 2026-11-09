/**
 * @file app.tsx
 * @description Top-level route table for the React SPA.
 * Declares every browser route, wraps all feature pages inside the shared
 * <Layout> shell (navigation chrome + market-status badges), and performs
 * one-time setup of the embedded multi-agent bridge (`initAgentAPI`) on mount.
 *
 * Architecture: this module is imported by index.tsx (the createRoot entry)
 * and only owns routing — page components live under `pages/`, data access
 * under `api/`, and shared layout under `components/Layout.tsx`.
 */
import React, { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getAuthMode } from './api/auth-mode';
import { initAgentAPI } from './utils/agent-api';

import Layout from './components/Layout';
import DashboardPage from './pages/Dashboard/DashboardPage';
import HoldingsPage from './pages/Holdings/HoldingsPage';
import WatchlistPage from './pages/Watchlist/WatchlistPage';
import AnalysisPage from './pages/Analysis/AnalysisPage';
import DeepReportPage from './pages/Analysis/DeepReportPage';
import PortfolioReportPage from './pages/Analysis/PortfolioReportPage';
import JournalPage from './pages/Journal/JournalPage';
import TransactionsPage from './pages/Transactions/TransactionsPage';
import SettingsPage from './pages/Settings/SettingsPage';
import PaperPage from './pages/Paper/PaperPage';
import AgentBuilderPage from './pages/AgentBuilder/AgentBuilderPage';
import CouncilPage from './pages/Council/CouncilPage';
import ImportPage from './pages/Import/ImportPage';
import LoginPage from './pages/Auth/LoginPage';
import RegisterPage from './pages/Auth/RegisterPage';
import RecoverPage from './pages/Auth/RecoverPage';
import PrivacyPage from './pages/Privacy/PrivacyPage';
import NotFound from './pages/NotFound/NotFound';
import ResearchDocumentPage from './pages/Analysis/ResearchDocumentPage';
import PortfolioOverviewPage from './pages/Overview/PortfolioOverviewPage';
import SimpleAnalysisPage from './pages/Analysis/SimpleAnalysisPage';
import SimpleCouncilPage from './pages/Council/SimpleCouncilPage';
import SimulationAccountsPage from './pages/Paper/SimulationAccountsPage';
import SimulationAccountPage from './pages/Paper/SimulationAccountPage';
import AccountStrategyCombinationPage from './features/investment-strategies/AccountStrategyCombinationPage';
import { useSimpleExperience } from './hooks/use-simple-experience';

function ExperienceRoute({ current, legacy }: { current: React.ReactNode; legacy: React.ReactNode }) {
  const { enabled, isPending } = useSimpleExperience();
  if (isPending) return <div role="status" className="p-6">Squabble…</div>;
  return <>{enabled ? current : legacy}</>;
}

/**
 * Root route component.
 * Mounts the embedded agent API bridge once on first render, then renders
 * the route table. Auth pages render outside the app shell; nested routes
 * share the <Layout> element; an unmatched path (`*`) falls through to the
 * NotFound page.
 *
 * @returns The React element tree for the whole application.
 */
const RoutesComponent = () => {
  const localWorkspace = getAuthMode() === 'local';
  // One-time side effect: expose the in-page agent bridge so the host
  // container can call into this SPA.
  useEffect(() => {
    initAgentAPI();
  }, []);

  return (
    <Routes>
      <Route path="/login" element={localWorkspace ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/register" element={localWorkspace ? <Navigate to="/" replace /> : <RegisterPage />} />
      <Route path="/recover" element={localWorkspace ? <Navigate to="/" replace /> : <RecoverPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route element={<Layout />}>
        <Route index element={<ExperienceRoute current={<PortfolioOverviewPage />} legacy={<DashboardPage />} />} />
        <Route path="holdings" element={<HoldingsPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="watchlist" element={<WatchlistPage />} />
        <Route path="analysis" element={<ExperienceRoute current={<SimpleAnalysisPage />} legacy={<AnalysisPage />} />} />
        <Route path="analysis/reports/:versionId" element={<ResearchDocumentPage />} />
        <Route path="paper" element={<ExperienceRoute current={<SimulationAccountsPage />} legacy={<PaperPage />} />} />
        <Route path="paper/:accountId" element={<SimulationAccountPage />} />
        <Route path="paper/:accountId/strategies" element={<AccountStrategyCombinationPage />} />
        <Route path="agent-builder" element={<ExperienceRoute current={<Navigate to="/settings/agents" replace />} legacy={<AgentBuilderPage />} />} />
        <Route path="council" element={<ExperienceRoute current={<SimpleCouncilPage />} legacy={<CouncilPage />} />} />
        <Route path="analysis/deep-report/:runId" element={<DeepReportPage />} />
        <Route path="analysis/portfolio-report/:runId" element={<PortfolioReportPage />} />
        <Route path="journal" element={<JournalPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="settings/*" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default RoutesComponent;
