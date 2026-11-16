/**
 * NotFound.tsx — 404 兜底页：品牌吉祥物 + 返回首页入口。
 *
 * 职责边界：
 *  - 仅渲染 404 提示与"回到首页"按钮，不含任何数据逻辑。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 的 * 路由兜底；SettingsPage 将未知设置分区跳转至此。
 *  - 下游（调用哪些 hooks/api/组件）：react-i18next 的 useTranslation；Mascot、Button、Link。
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Mascot } from '@/components/Mascot';

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6 text-center">
      {/* 品牌吉祥物，占位说明当前处于站外路径 */}
      <Mascot className="h-16 w-16" />
      <h1 className="mt-6 font-serif text-4xl font-semibold text-foreground">
        {t('common.notFound')}
      </h1>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
        {t('common.notFoundText')}
      </p>
      {/* 唯一出口：整链回首页 */}
      <Link to="/" className="mt-8">
        <Button>{t('common.goHome')}</Button>
      </Link>
    </div>
  );
}

export default NotFound;
