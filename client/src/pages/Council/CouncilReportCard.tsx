/**
 * CouncilReportCard.tsx — 研究报告全文卡：版本徽标、结论、分歧、证据与溯源链接。
 *
 * 职责边界：
 *  - 渲染单份 CouncilReport 的完整内容：当前/过时判定、研究立场/引擎徽标、摘要、
 *    候选交易（candidate）、反对意见（dissent）、下次复核条件、证据折叠列表、
 *    溯源链接（深研报告/纸面订单）与外部用量说明；
 *  - 只做展示，不负责报告的生成与列表管理（列表侧是 CouncilReports）。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilReports（全文弹窗内嵌）、CouncilPage（最终报告展示）。
 *  - 下游（调用哪些 hooks/api/组件）：@/utils/council-state 的 isCurrentCouncilReport；
 *    Badge/Card。
 * 关键约定：
 *  - 当前版本判定交给 isCurrentCouncilReport(report, session, profileVersion)——
 *    当前版本主色描边 + default 徽标，过时版本加 obsoleteHint 提示；
 *  - 证据节点带 id=`evidence-<reportId>-<itemId>`，供外部锚点跳转引用；
 *  - 来源 URL 仅接受 http/https 协议（safeSourceUrl 过滤 javascript: 等危险协议）。
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BookOpen, FileCheck2, FlaskConical } from 'lucide-react';
import type { CouncilReport, CouncilSession } from '@shared/council.interface';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { isCurrentCouncilReport } from '@/utils/council-state';

/** 来源 URL 白名单过滤：只放行 http/https，解析失败或协议不在白名单返回 null。 */
function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** 研究报告全文卡（只读展示组件）。 */
export default function CouncilReportCard({
  report,
  session,
  profileVersion,
}: {
  report: CouncilReport;
  session: CouncilSession;
  profileVersion?: number;
}) {
  const { t, i18n } = useTranslation();
  // 当前版本判定（版本号 + 配置版本双口径），决定描边与徽标
  const current = isCurrentCouncilReport(report, session, profileVersion);
  return (
    <Card className={`min-w-0 ${current ? 'border-primary/30' : 'border-border'}`}>
      <CardHeader>
        {/* 卡头：报告标题 + 当前/过时徽标 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 font-serif text-lg">
            <FileCheck2 className="size-5 text-primary" />
            {t('council.report.title', { version: report.version })}
          </CardTitle>
          <Badge variant={current ? 'default' : 'secondary'}>
            {t(current ? 'council.report.current' : 'council.report.obsolete')}
          </Badge>
        </div>
        {/* 元信息：研究立场（优先）/投资决策 + 生成引擎 + 时间 */}
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge variant="outline">
            {t(
              report.researchStance
                ? `council.report.stances.${report.researchStance}`
                : `council.report.decisions.${report.decision}`,
            )}
          </Badge>
          <Badge variant="outline">{t(`council.report.engines.${report.engine}`)}</Badge>
          <span className="self-center text-xs text-muted-foreground">
            {new Date(report.createdAt).toLocaleString(i18n.language)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 什么时候走到这里：报告已过时——先提示"按旧配置生成，仅供参考" */}
        {!current && (
          <p className="rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">
            {t('council.report.obsoleteHint')}
          </p>
        )}
        {/* 摘要正文 */}
        <p className="whitespace-pre-wrap break-words text-sm leading-7">{report.summary}</p>
        {/* 什么时候走到这里：报告给出候选交易——展示标的/方向/数量×价格/理由 */}
        {report.candidate && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-semibold">{t('council.report.candidate')}</p>
            <p className="mt-2 font-mono">
              {report.candidate.ticker} · {t(`ui.builder.side.${report.candidate.side}`)}{' '}
              {report.candidate.quantity} × {report.candidate.price}
            </p>
            <p className="mt-2 break-words text-xs leading-5 text-muted-foreground">
              {report.candidate.reason}
            </p>
          </div>
        )}
        {/* 什么时候走到这里：存在反对意见——逐条列出 */}
        {report.dissent.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold">{t('council.report.dissent')}</h4>
            <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
              {report.dissent.map((point: string, index: number) => (
                <li className="break-words" key={index}>
                  {point}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* 下次复核条件框：条件缺失时给占位文案 */}
        <div className="rounded-lg bg-primary/5 p-3">
          <h4 className="text-xs font-semibold text-primary">{t('council.report.nextReview')}</h4>
          <p className="mt-1 break-words text-sm leading-6">
            {report.nextReviewCondition || t('council.report.noCondition')}
          </p>
        </div>
        {/* 证据折叠列表：节点 id 供外部锚点跳转；来源链接仅 http/https */}
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t('council.report.evidence', { count: report.evidence.length })}
          </summary>
          <div className="mt-3 space-y-3">
            {/* 什么时候走到这里：报告没有任何证据条目 */}
            {report.evidence.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('council.report.noEvidence')}</p>
            )}
            {report.evidence.map((item) => {
              const url = safeSourceUrl(item.sourceUrl);
              return (
                <div
                  id={`evidence-${report.id}-${item.id}`}
                  key={item.id}
                  className="min-w-0 border-t border-border pt-3"
                >
                  <p className="break-words text-sm font-medium">
                    [{item.id}] {item.title}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">
                    {item.content}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span>{new Date(item.fetchedAt).toLocaleString(i18n.language)}</span>
                    {url && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {t('council.report.source')}
                        <ArrowUpRight className="size-3" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
        {/* 冻结证据说明 */}
        <p className="text-xs leading-5 text-muted-foreground">
          {t('council.report.frozenEvidence')}
        </p>
        {/* 溯源链接：来源深研报告 / 纸面订单（仅存在对应 id 时渲染） */}
        <div className="flex flex-wrap gap-3 text-xs text-primary">
          {report.sourceRunId && (
            <Link
              className="inline-flex items-center gap-1 hover:underline"
              to={`/analysis/deep-report/${encodeURIComponent(report.sourceRunId)}`}
            >
              <BookOpen className="size-3.5" />
              {t('council.report.sourceRun')}
            </Link>
          )}
          {report.paperOrderId && (
            <Link
              className="inline-flex items-center gap-1 hover:underline"
              to={`/paper?orderId=${encodeURIComponent(report.paperOrderId)}`}
            >
              <FlaskConical className="size-3.5" />
              {t('council.report.paperOrder')} · {report.paperOrderId.slice(0, 8)}
            </Link>
          )}
        </div>
        {/* 外部用量说明：未知 → 未知文案；本地/a2a/混合引擎 → 已上报外部 token；否则常规 token 计数 */}
        <p className="text-xs leading-5 text-muted-foreground">
          {report.externalUsageUnknown
            ? t('council.report.externalUsageUnknown')
            : t(
                report.engine === 'local' || report.engine === 'a2a' || report.engine === 'mixed'
                  ? 'council.report.externalReportedTokens'
                  : 'council.report.tokens',
                {
                  count: report.tokensUsed.toLocaleString(i18n.language),
                },
              )}
        </p>
        {/* 尾注：研究型报告给"人工解读"提示，执行型给"自动执行"提示 */}
        <p className="text-xs leading-5 text-muted-foreground">
          {t(report.researchStance ? 'council.report.manualHint' : 'council.report.executionHint')}
        </p>
      </CardContent>
    </Card>
  );
}
