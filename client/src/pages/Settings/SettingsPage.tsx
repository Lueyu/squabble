/**
 * SettingsPage.tsx — 设置页壳层：分区路由解析 + 已访问面板保挂 + 分区内容分发。
 *
 * 职责边界：
 *  - 把 URL 解析为分区（resolveSettingsSection），规范化旧入口地址，维护 visited 列表，
 *    并把每个分区映射到对应面板组件；面板本身的数据逻辑在各自文件内。
 *  - 未知路由渲染 NotFound，不做静默兜底。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 的 /settings 路由。
 *  - 下游（调用哪些 hooks/api/组件）：useTranslation/useLocation/useNavigate；
 *    SettingsNavigation、ModelConnectionsPanel、IntegrationSettingsPanel、LocalAgentsPanel、
 *    BudgetPanel、StrategyRulesPage(embedded)、AppearancePanel(内含 AppearanceControls/Select)、
 *    RecoveryCodeCard、SystemUpdateCard、SettingsGuide、NotFound；settings-navigation、settings.css。
 * 关键约定：
 *  - 已访问分区面板保持挂载（hidden 切换），保证表单草稿在分区间来回切换时不丢失；
 *    client/src/utils/settings-navigation.test.cjs 依赖 role="region" + key=models/data 的结构。
 *  - 分区切换时滚动回顶部，标题获得焦点（preventScroll），实现无障碍导航播报。
 *  - 本文件未显式 import useEffect/useRef 之外的 hook 以外的依赖顺序敏感项；勿调整面板渲染顺序。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BookOpenText, LockKeyhole } from 'lucide-react';
import { AppearanceControls } from '@/components/AppearancePicker';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { setLanguage } from '@/i18n';
import NotFound from '@/pages/NotFound/NotFound';
import StrategyRulesPage from '@/pages/StrategyRules/StrategyRulesPage';
import BudgetPanel from './BudgetPanel';
import IntegrationSettingsPanel from './IntegrationSettingsPanel';
import LocalAgentsPanel from './LocalAgentsPanel';
import ModelConnectionsPanel from './ModelConnectionsPanel';
import { RecoveryCodeCard } from './RecoveryCodeCard';
import SettingsGuide from './SettingsGuide';
import SettingsNavigation from './SettingsNavigation';
import SystemUpdateCard from './SystemUpdateCard';
import {
  resolveSettingsSection,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './settings-navigation';
import './settings.css';

export default function SettingsPage() {
  // —— 状态声明区 ——
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  // 当前分区：由 URL（含旧版 hash 兼容）解析得出；null 表示未知路由
  const active = resolveSettingsSection(location.pathname, location.hash);
  // 已到访过的分区：面板一旦渲染过就保挂，切换分区不卸载、不丢草稿
  const [visited, setVisited] = useState<SettingsSection[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previousSection = useRef(active);

  // —— 数据获取区（URL 规范化） ——
  // 兼容旧入口：/settings#hash 或带尾斜杠的地址重写为 /settings/<分区>，替换历史记录。
  // 面板树此时保持挂载，避免规范化瞬间卸载组件丢失草稿。
  useEffect(() => {
    if (active && location.pathname !== `/settings/${active}`) {
      // 在规范化旧入口 URL 期间保持面板树挂载。
      navigate({ pathname: `/settings/${active}`, search: location.search }, { replace: true });
    }
  }, [active, location.pathname, location.search, navigate]);

  // 到访登记 + 交互反馈：新分区记入 visited，滚动回顶，分区切换时让标题聚焦
  useEffect(() => {
    if (!active) return;
    setVisited((current) => (current.includes(active) ? current : [...current, active]));
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (previousSection.current !== active) titleRef.current?.focus({ preventScroll: true });
    previousSection.current = active;
  }, [active]);

  // —— 渲染区 ——
  // 什么时候走到这里：URL 解析不出分区（如 /settings/missing）——整页 404
  if (!active) return <NotFound />;
  const group = SETTINGS_SECTIONS.find((section) => section.id === active)!.group;
  return (
    <div className="settings-shell">
      <SettingsNavigation active={active} />
      <div ref={scrollRef} className="settings-content">
        <div className="settings-content-inner">
          {/* 页头：分区标题/描述 + 帮助入口（guide 分区本身不再放帮助链接） */}
          <header className="settings-page-heading">
            <div className="min-w-0">
              <p className="settings-kicker">{t(`settingsNav.groups.${group}`)}</p>
              <h1
                ref={titleRef}
                tabIndex={-1}
                className="settings-page-title"
                id="settings-page-title"
              >
                {t(`settingsNav.sections.${active}.title`)}
              </h1>
              <p className="settings-page-description">
                {t(`settingsNav.sections.${active}.description`)}
              </p>
            </div>
            {active !== 'guide' && (
              <Button asChild variant="ghost" size="sm" className="settings-help-link">
                <Link to="/settings/guide">
                  <BookOpenText />
                  {t('settingsNav.help')}
                  <ArrowUpRight />
                </Link>
              </Button>
            )}
          </header>

          {/* 面板区：当前分区 + 所有到访过的分区都渲染（hidden 控制显隐），保挂草稿 */}
          {SETTINGS_SECTIONS.filter(
            (section) => section.id === active || visited.includes(section.id),
          ).map((section) => (
            <div
              key={section.id}
              hidden={active !== section.id}
              className="settings-panel"
              role="region"
              aria-label={t(`settingsNav.sections.${section.id}.title`)}
            >
              <SettingsSectionContent section={section.id} active={active === section.id} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 分区 → 具体面板内容的映射；switch 全覆盖 SETTINGS_SECTIONS，无需 default。 */
function SettingsSectionContent({
  section,
  active,
}: {
  section: SettingsSection;
  active: boolean;
}) {
  const { t } = useTranslation();
  switch (section) {
    // 模型配置：模型连接 + 集成（models 区）
    case 'models':
      return (
        <div className="space-y-6">
          <ModelConnectionsPanel active={active} />
          <IntegrationSettingsPanel section="models" active={active} />
        </div>
      );
    // 本地智能体（CLI 工具连接）
    case 'agents':
      return <LocalAgentsPanel />;
    // 行情数据源集成
    case 'data':
      return <IntegrationSettingsPanel section="data" active={active} />;
    // 研究预算
    case 'budget':
      return <BudgetPanel />;
    // 策略规则页以嵌入模式复用
    case 'rules':
      return <StrategyRulesPage embedded active={active} />;
    // 外观与语言
    case 'appearance':
      return <AppearancePanel active={active} />;
    // 安全：恢复码 + 隐私说明
    case 'security':
      return (
        <div className="space-y-5">
          <RecoveryCodeCard />
          <div className="settings-privacy-note">
            <LockKeyhole size={18} aria-hidden="true" />
            <p>{t('ui.settings.privacyNote')}</p>
          </div>
        </div>
      );
    // 系统更新
    case 'updates':
      return <SystemUpdateCard />;
    // 使用指南
    case 'guide':
      return <SettingsGuide />;
  }
}

/** 外观分区面板：主题控件 + 界面语言选择（仅中文/英文两档）。 */
function AppearancePanel({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  // 语言下拉的展开状态；仅当前分区激活时才允许展开（active 由壳层传入）
  const [languageOpen, setLanguageOpen] = useState(false);
  return (
    <div className="space-y-6">
      {/* 主题外观控件（浅色/深色/跟随系统） */}
      <Card>
        <CardContent className="settings-appearance-controls">
          <AppearanceControls />
        </CardContent>
      </Card>
      {/* 界面语言：值由当前 i18n 语言推导，切换后全局生效 */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
          <div>
            <h2 className="font-semibold">{t('settingsNav.language')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('settingsNav.languageHint')}</p>
          </div>
          <Select
            open={active && languageOpen}
            onOpenChange={setLanguageOpen}
            value={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'}
            onValueChange={(value) => {
              if (value === 'zh-CN' || value === 'en') setLanguage(value);
            }}
          >
            <SelectTrigger className="w-40" aria-label={t('settingsNav.language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">简体中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>
  );
}
