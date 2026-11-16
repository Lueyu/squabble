/**
 * DeepReportPage.tsx — 路由 `/analysis/deep-report/:runId`：单篇深度研究报告的全屏阅读页。
 *
 * 职责边界：
 *  - 按 runId 拉取一篇多智能体深度研究报告；
 *  - 只负责"取数据 + 四种页面状态（加载 / 出错 / 无报告 / 报告内容）"的切换，
 *    报告正文渲染全部委托给共享组件 DeepReportView；
 *  - 深色沉浸式阅读样式，顶栏带返回（由 DeepReportView 的 onBack 触发 navigate(-1)）。
 * 上下游：
 *  - 上游：AnalysisPage 的报告卡片、AnalysisRunner 的"查看报告"入口（链接 `/analysis/deep-report/:runId`）；
 *  - 下游：getDeepReport（@/api）、DeepReportView（@/components/MultiAgent）。
 * 关键约定：
 *  - useEffect 内用 cancelled 标志防止竞态（runId 快速切换或组件卸载后不 setState）。
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DeepReport as DeepReportType } from '@shared/api.interface';
import { getDeepReport } from '@/api';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import DeepReportView from '@/components/MultiAgent/DeepReportView';

/**
 * 深度报告阅读页组件。
 */
function DeepReportPage() {
  const { runId = '' } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  // ===== 状态声明区 =====
  const [report, setReport] = useState<DeepReportType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ===== 数据获取区：按 runId 拉取报告 =====
  // cancelled 标志防竞态：runId 变化或组件卸载后，过期请求的结果一律丢弃。
  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        const data = await getDeepReport(runId);
        if (cancelled) return;
        setReport(data);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : t('ui.analysis.contentLoadFailed');
        setError(msg);
        toast.error(t('ui.report.loadDeepReportFailed'), { description: msg });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, t]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ===== 渲染区：顶栏 + 四态切换 ===== */}
      {/* 顶栏：右侧显示引擎类型徽标（什么时候走到这里：报告已加载成功） */}
      <div className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="flex items-center justify-end px-2 sm:px-4 py-3">
          {report && (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium"
            >
              <Sparkles size={12} />
              {/* basic 引擎标注"基础分析"，其余统一按多智能体报告展示 */}
              {t(
                report.analysisTrace?.engine === 'basic'
                  ? 'analysisFlow.basic'
                  : 'analysisFlow.report',
              )}
            </Badge>
          )}
        </div>
      </div>

      {/* 加载中 */}
      {loading && (
        <div className="flex items-center justify-center p-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {t('ui.report.loadingDeepReport')}
        </div>
      )}

      {/* 加载失败：给出错误详情 + 重试按钮 */}
      {!loading && error && (
        <div className="p-8">
          <Empty>
            <EmptyMedia variant="icon">
              <Sparkles className="h-5 w-5" />
            </EmptyMedia>
            <EmptyContent>
              <EmptyTitle className="font-serif text-foreground">
                {t('ui.analysis.contentLoadFailed')}
              </EmptyTitle>
              <EmptyDescription className="text-muted-foreground">{error}</EmptyDescription>
              <div className="mt-4">
                <Button onClick={() => window.location.reload()}>{t('common.retry')}</Button>
              </div>
            </EmptyContent>
          </Empty>
        </div>
      )}

      {/* 什么时候走到这里：请求成功但该 runId 没有生成过报告 */}
      {!loading && !error && !report && (
        <div className="p-8">
          <Empty>
            <EmptyMedia variant="icon">
              <Sparkles className="h-5 w-5" />
            </EmptyMedia>
            <EmptyContent>
              <EmptyTitle className="font-serif text-foreground">
                {t('ui.report.noDeepReport')}
              </EmptyTitle>
              <EmptyDescription className="text-muted-foreground">
                {t('ui.report.deepReportGeneratedAfterRun')}
              </EmptyDescription>
            </EmptyContent>
          </Empty>
        </div>
      )}

      {/* 报告正文：全部交给共享组件 DeepReportView 渲染 */}
      {!loading && !error && report && (
        <div className="px-2 sm:px-4 pb-16">
          <DeepReportView report={report} runId={runId} onBack={() => navigate(-1)} />
        </div>
      )}
    </div>
  );
}

export default DeepReportPage;
