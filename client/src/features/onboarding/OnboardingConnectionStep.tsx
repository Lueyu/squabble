import { Link } from 'react-router-dom';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OnboardingStepper } from './OnboardingStepper';
import { TEAM_ONBOARDING_PATH } from './onboarding-state';
import { useAiReadiness } from './use-ai-readiness';

export function OnboardingConnectionStep({ children, navigation, headingRef }: {
  children: ReactNode; navigation: ReactNode; headingRef: Ref<HTMLHeadingElement>;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const readiness = useAiReadiness({ watch: true });
  const { connection, error, pending, reload } = readiness;

  return <div className="space-y-4">
    <OnboardingStepper step="connection" zh={zh} />
    <header className="space-y-2">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold sm:text-3xl">{connection
        ? (zh ? '研究服务已连接' : 'Research service connected')
        : (zh ? '连接研究服务' : 'Connect a research service')}</h1>
      {!connection && <p className="text-sm text-muted-foreground">
        {zh ? '选择一种可用连接，供股友执行团队研究。' : 'Connect one service for friends to use for team research.'}
      </p>}
    </header>
    {navigation}
    {pending && <p role="status" className="text-sm text-muted-foreground">{zh ? '正在检查可用连接…' : 'Checking available connections…'}</p>}
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p>{zh ? '暂时无法核对连接状态。' : 'Connection status could not be checked.'}</p>
      <Button size="sm" variant="outline" onClick={() => void reload()}>{zh ? '重试' : 'Retry'}</Button>
    </div>}
    {connection && <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="break-words">{connection.connection.name}</CardTitle>
        <Badge variant="secondary" className="text-primary" role="status">
          {zh ? '已连接' : 'Connected'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{connection.kind === 'local'
          ? (zh ? '本地 Agent 可用' : 'Local agent is ready')
          : (zh ? '模型 API 测试已通过' : 'Model API test passed')}</p>
        <div className="space-y-4 border-t pt-4">
          <p className="text-sm">{zh ? '选择团队模板后，股友会自动就位。' : 'Choose a team template to start with its assigned friends.'}</p>
          <Button asChild><Link to={TEAM_ONBOARDING_PATH}>{zh ? '新建团队模拟盘' : 'Set up a team simulation'}</Link></Button>
        </div>
      </CardContent>
    </Card>}
    {!connection && children}
  </div>;
}
