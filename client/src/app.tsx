/**
 * @file app.tsx
 * @description React SPA 的顶层路由表。
 * 声明全部浏览器路由：认证类页面（/login /register /recover /privacy）独立于
 * 全局壳渲染；其余功能页面统一包进共享 <Layout> 壳（导航栏 + 顶栏 + 市场状态徽章）；
 * 未匹配路径（*）回落到 NotFound 页。挂载时一次性完成内嵌 multi-agent 桥接的
 * 初始化（`initAgentAPI`）。
 *
 * 架构：本模块由 index.tsx（createRoot 入口）导入，只负责路由总装配 ——
 * 页面组件位于 `pages/`，数据访问位于 `api/`，全局壳位于 `components/Layout.tsx`。
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
 * 根路由组件。
 * 首次渲染时一次性挂载内嵌 agent API 桥接（把宿主容器可调用的接口暴露到页面内），
 * 然后渲染路由表。认证页渲染在应用壳之外；嵌套路由共享 <Layout> 元素；
 * 未匹配路径（`*`）回落到 NotFound 页。
 *
 * @returns 整个应用的 React 元素树。
 */
const RoutesComponent = () => {
  // 一次性副作用：暴露页面内的 agent 桥接，供宿主容器调用本 SPA。
  useEffect(() => {
    initAgentAPI();
  }, []);

  // 路由清单（与下方 <Routes> 一一对应的逐路由说明）：
  //   /login                              登录页（独立于 Layout 全局壳）
  //   /register                           注册页（独立于 Layout 全局壳）
  //   /recover                            账号找回页（独立于 Layout 全局壳）
  //   /privacy                            隐私政策页（独立于 Layout 全局壳）
  //   <Layout> 壳内嵌套路由（index 路由 = Dashboard，为默认首页）：
  //     /                                 Dashboard 仪表盘
  //     /holdings                         持仓
  //     /import                           数据导入
  //     /watchlist                        自选列表
  //     /analysis                         分析
  //     /paper                            模拟盘
  //     /agent-builder                    Agent 构建器
  //     /council                          Council 多空议会
  //     /analysis/deep-report/:runId      深度报告（:runId 为 run 标识）
  //     /journal                          交易日志
  //     /transactions                     交易流水
  //     /settings/*                       设置（含多级子路由）
  //   *                                   未匹配路径 → NotFound 页
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
