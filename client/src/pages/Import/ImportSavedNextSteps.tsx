import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { safeReturnPath } from '@/features/navigation/workspace-navigation';

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
          ? '持仓已保存。可以返回继续管理，或认识一起验证投资想法的股友。'
          : 'Your holdings are saved. Return to your work or meet agents to explore investment ideas.'}
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
          <Link to="/friends">
            {zh ? '下一步：认识股友' : 'Next: meet your agents'}
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
