/**
 * CouncilReports.tsx — 报告归档侧栏：会话历史版本报告的紧凑列表与全文弹窗入口。
 *
 * 职责边界：
 *  - 按版本号倒序展示 session.reports：版本标题、当前/过时徽标、立场/决策、摘要（4 行截断）、
 *    证据数与生成时间；
 *  - 每张卡的"打开"按钮弹出 Dialog，内嵌 CouncilReportCard 渲染报告全文。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilPage（对话旁的归档栏）。
 *  - 下游（调用哪些 hooks/api/组件）：@/utils/council-state 的 isCurrentCouncilReport；
 *    Dialog/Badge/Button；CouncilReportCard。
 * 关键约定：
 *  - 当前版本判定交给 isCurrentCouncilReport(report, session, profileVersion)——
 *    版本号与配置版本双口径；当前版本卡用主色描边 + default 徽标；
 *  - 立场优先：report.researchStance 有值走 stances.<stance>，否则 decisions.<decision>。
 */
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, FileText, X } from 'lucide-react';
import type { CouncilReport, CouncilSession } from '@shared/council.interface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { isCurrentCouncilReport } from '@/utils/council-state';
import CouncilReportCard from './CouncilReportCard';

interface CouncilReportsProps {
  session: CouncilSession;
  profileVersion?: number;
}

/** 对话旁紧凑、可独立滚动的报告归档栏。 */
export default function CouncilReports({ session, profileVersion }: CouncilReportsProps) {
  const { t, i18n } = useTranslation();
  // 报告按版本号倒序（新版本在前）
  const reports: CouncilReport[] = [...session.reports].sort(
    (left: CouncilReport, right: CouncilReport) => right.version - left.version,
  );

  return (
    <section
      className="flex h-full min-h-0 min-w-0 w-full flex-col"
      aria-label={t('council.report.history')}
    >
      {/* 归档栏头：标题 + 数量徽标 */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-4 pr-12 xl:pr-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FileText className="size-4 text-primary" aria-hidden="true" />
          {t('council.report.history')}
        </h2>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
          {reports.length}
        </span>
      </header>

      {/* 报告列表：独立滚动；空态给引导占位 */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
        {/* 什么时候走到这里：还没有任何报告——空态引导 */}
        {reports.length === 0 && (
          <div className="mx-auto flex max-w-56 flex-col items-center py-12 text-center">
            <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <FileText className="size-5" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium">{t('council.report.empty')}</p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              {t('council.report.emptyHint')}
            </p>
          </div>
        )}

        {reports.map((report: CouncilReport) => {
          // 当前版本判定（版本号 + 配置版本双口径）
          const current: boolean = isCurrentCouncilReport(report, session, profileVersion);
          return (
            <article
              key={report.id}
              className={`rounded-xl border bg-card p-3.5 ${
                current ? 'border-primary/30' : 'border-border'
              }`}
            >
              {/* 卡头：版本标题 + 当前/过时徽标 */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {t('council.report.title', { version: report.version })}
                </h3>
                <Badge variant={current ? 'default' : 'secondary'} className="text-[10px]">
                  {t(current ? 'council.report.current' : 'council.report.obsolete')}
                </Badge>
              </div>
              {/* 研究立场优先，缺省回退投资决策 */}
              <p className="mt-2 text-xs font-medium text-muted-foreground">
                {t(
                  report.researchStance
                    ? `council.report.stances.${report.researchStance}`
                    : `council.report.decisions.${report.decision}`,
                )}
              </p>
              {/* 摘要（4 行截断） */}
              <p className="mt-3 line-clamp-4 break-words text-sm leading-6">{report.summary}</p>
              {/* 元信息：证据数 + 创建日期（title 悬浮完整时间） */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>{t('council.report.evidence', { count: report.evidence.length })}</span>
                <time
                  dateTime={report.createdAt}
                  title={new Date(report.createdAt).toLocaleString(i18n.language)}
                >
                  {new Date(report.createdAt).toLocaleDateString(i18n.language, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </div>

              {/* 全文弹窗：触发按钮 + 自绘关闭按钮（showCloseButton=false）+ CouncilReportCard */}
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3 h-8 w-full justify-between text-xs text-primary"
                    aria-label={t('council.report.openVersion', { version: report.version })}
                  >
                    {t('council.report.open')}
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </Button>
                </DialogTrigger>
                <DialogContent
                  showCloseButton={false}
                  className="flex max-h-[88dvh] max-w-3xl flex-col gap-0 overflow-hidden p-0"
                >
                  {/* 弹窗头：标题 + 关闭按钮；描述仅供读屏 */}
                  <DialogHeader className="shrink-0 border-b border-border p-4 text-left">
                    <div className="flex items-center justify-between gap-3">
                      <DialogTitle className="text-base">
                        {session.ticker} · {t('council.report.title', { version: report.version })}
                      </DialogTitle>
                      <DialogClose asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label={t('council.close')}
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </DialogClose>
                    </div>
                    <DialogDescription className="sr-only">
                      {t('council.report.detailHint')}
                    </DialogDescription>
                  </DialogHeader>
                  {/* 报告全文：独立滚动区域 */}
                  <div className="min-h-0 overflow-y-auto overscroll-contain p-3 sm:p-5">
                    <CouncilReportCard
                      report={report}
                      session={session}
                      profileVersion={profileVersion}
                    />
                  </div>
                </DialogContent>
              </Dialog>
            </article>
          );
        })}
      </div>
    </section>
  );
}
