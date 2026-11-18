import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { safeReturnPath } from '@/features/navigation/workspace-navigation';
import { LOCAL_ONBOARDING_PATH } from '@/features/onboarding/onboarding-state';

/** Saving is complete before these links appear; following them never starts research. */
export function ImportSavedNextSteps() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const location = useLocation();
  const state = location.state as { returnTo?: unknown } | null;
  const returnTo =
    safeReturnPath(new URLSearchParams(location.search).get('returnTo')) ??
    safeReturnPath(state?.returnTo);
  return (
    <div className="mt-3 space-y-3" role="status">
      <p className="text-sm">
        {zh
          ? '持仓已保存。下一步，连接一种可用的研究服务。'
          : 'Holdings saved. Connect a research service to continue.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {returnTo && (
          <Button asChild>
            <Link to={returnTo}>
              {zh ? '返回上一页' : 'Return to previous page'}
            </Link>
          </Button>
        )}
        <Button asChild variant={returnTo ? 'outline' : 'default'}>
          <Link to={LOCAL_ONBOARDING_PATH}>
            {zh ? '连接研究服务' : 'Connect a research service'}
          </Link>
        </Button>
        {!returnTo && (
          <Button asChild variant="outline">
            <Link to="/holdings?accountId=real">
              {zh ? '查看持仓' : 'View holdings'}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
