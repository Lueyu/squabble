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
import { Route, Routes } from 'react-router-dom';
import { initAgentAPI } from './utils/agent-api';

import Layout from './components/Layout';
import DashboardPage from './pages/Dashboard/DashboardPage';
import HoldingsPage from './pages/Holdings/HoldingsPage';
import WatchlistPage from './pages/Watchlist/WatchlistPage';
import AnalysisPage from './pages/Analysis/AnalysisPage';
import DeepReportPage from './pages/Analysis/DeepReportPage';
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
  // One-time side effect: expose the in-page agent bridge so the host
  // container can call into this SPA.
  useEffect(() => {
    initAgentAPI();
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/recover" element={<RecoverPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="holdings" element={<HoldingsPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="watchlist" element={<WatchlistPage />} />
        <Route path="analysis" element={<AnalysisPage />} />
        <Route path="paper" element={<PaperPage />} />
        <Route path="agent-builder" element={<AgentBuilderPage />} />
        <Route path="council" element={<CouncilPage />} />
        <Route path="analysis/deep-report/:runId" element={<DeepReportPage />} />
        <Route path="journal" element={<JournalPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="settings/*" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default RoutesComponent;
