import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TelemetryRatio, TelemetryRun, TelemetryWorkspace } from '@shared/telemetry.interface';
import { IntegrationStatus, TelemetryEmpty, TelemetryMetric, TelemetryPanel } from './TelemetryPrimitives';
import { formatRate, telemetryRunPath } from './telemetry-state';

export function qualityDefinitions(zh: boolean): Array<{ label: string; basis: string; excluded: string }> {
  return zh ? [
    { label: '完整交付率', basis: '已保存报告中，交付完整性明确的运行', excluded: '没有保存交付完整性记录的运行不计入分母' },
    { label: '证据可追溯率', basis: '需要来源与版本可验证的去重证据清单', excluded: '当前没有可验证清单，显示未覆盖；引用数不是准确率' },
    { label: '反向核查完成率', basis: '已保存且核查结果可验证的运行', excluded: '未执行、无法验证与未知不能视为完成' },
    { label: '7 日报告采纳率', basis: '需要完整 7 日观察窗口及按版本去重的报告', excluded: '当前未验证完整观察窗口，显示未覆盖；当前采纳指针不等于 7 日采纳' },
  ] : [
    { label: 'Complete delivery', basis: 'Runs with explicit saved report-completeness records', excluded: 'Runs without saved completeness records are excluded from the denominator' },
    { label: 'Traceable evidence', basis: 'Requires deduplicated evidence with verifiable sources and versions', excluded: 'No verifiable inventory is available; citation count is not accuracy' },
    { label: 'Reverse-check completion', basis: 'Runs with saved, verifiable reverse-check outcomes', excluded: 'Not performed, unverifiable and unknown are not completed' },
    { label: '7-day report adoption', basis: 'Requires a full 7-day observation window and version-deduplicated reports', excluded: 'The full window is not verified. Current adoption pointers are not 7-day adoption' },
  ];
}

export default function TelemetryQuality({ data, params }: { data: TelemetryWorkspace; params: URLSearchParams }) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const definitions = qualityDefinitions(zh);
  const ratios: TelemetryRatio[] = [data.quality.completeDelivery, data.quality.traceableEvidence, data.quality.reverseCheck, data.quality.adoption];
  const samples: TelemetryRun[] = data.runs.filter((run: TelemetryRun) => run.accepted !== null || run.reportVersionId !== null).slice(0, 3);
  const yesNo = (value: boolean | null): string => value === null ? (zh ? '未知' : 'Unknown') : value ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No');
  return <>
    <dl className="telemetry-metrics" data-ai-section-type="card-stat">{ratios.map((ratio: TelemetryRatio, index: number) => <TelemetryMetric key={definitions[index].label} label={definitions[index].label} value={formatRate(ratio.value)}
      note={`${ratio.numerator} / ${ratio.denominator} · ${ratio.denominator ? (zh ? '可验证记录' : 'verifiable records') : (zh ? '尚无覆盖' : 'no coverage')}`} />)}</dl>
    <div className="telemetry-banner"><p>{zh ? '执行完成、交付接受、报告采纳是不同阶段。缺少观察窗口与评测样本时，保持未知，不使用财务收益替代运行准确率。' : 'Execution, delivery acceptance and report adoption are separate stages. Missing observation windows or evaluation samples remain unknown; financial returns do not measure run accuracy.'}</p></div>
    <div className="telemetry-two-columns">
      <TelemetryPanel title={zh ? '评估样本' : 'Evaluation samples'} description={zh ? '当前页中有交付或报告记录的运行' : 'Runs on this page with delivery or report records'}>
        {samples.length ? <div className="telemetry-quality-samples">{samples.map((run: TelemetryRun) => <article key={run.id}><h3>{run.title || run.id}</h3>
          <dl className="telemetry-facts"><dt>{zh ? '交付接受' : 'Delivery accepted'}</dt><dd>{yesNo(run.accepted)}</dd>
            <dt>{zh ? '报告版本' : 'Report version'}</dt><dd className="telemetry-mono">{run.reportVersionId ?? '—'}</dd>
            <dt>{zh ? '用户采纳' : 'User adopted'}</dt><dd>{yesNo(run.adopted)}</dd></dl>
          <Button asChild variant="outline"><Link to={telemetryRunPath(run.id, params)}>{zh ? '查看对应执行链路' : 'Inspect execution'}</Link></Button></article>)}</div> : <TelemetryEmpty>{zh ? '当前页没有可验证的交付或报告样本。' : 'No verifiable delivery or report samples on this page.'}</TelemetryEmpty>}
      </TelemetryPanel>
      <TelemetryPanel title={zh ? '标准化评测' : 'Standardized evaluation'} description={zh ? '固定题集与版本化量表' : 'Fixed datasets and versioned rubrics'}>
        <h3>{zh ? '当前没有可展示的标准评测分数' : 'No standardized evaluation scores available'}</h3>
        <p className="telemetry-muted">{zh ? '在 Langfuse 配置评测数据集、评分量表与实验后，前往项目查看。应用不补造分数或版本对比。' : 'Configure datasets, rubrics and experiments in Langfuse and inspect them in the project. The app does not invent scores or version comparisons.'}</p>
        <p className="telemetry-muted">{zh ? `人工反馈：${data.quality.feedback.positive} 次正面 · ${data.quality.feedback.negative} 次负面。反馈不是标准评测。` : `Human feedback: ${data.quality.feedback.positive} positive · ${data.quality.feedback.negative} negative. Feedback is not a standardized evaluation.`}</p>
        <IntegrationStatus integration={data.integration} />
      </TelemetryPanel>
    </div>
    <TelemetryPanel title={zh ? '指标口径与覆盖' : 'Metric definitions and coverage'} description={zh ? '每个比例保留分母与未覆盖项。' : 'Every ratio retains its denominator and exclusions.'}>
      <div className="telemetry-table-scroll"><Table className="telemetry-table"><TableHeader><TableRow>
        <TableHead>{zh ? '指标' : 'Metric'}</TableHead><TableHead>{zh ? '统计单位与分母' : 'Unit and denominator'}</TableHead><TableHead>{zh ? '未覆盖 / 排除项' : 'Uncovered / excluded'}</TableHead>
      </TableRow></TableHeader><TableBody>{definitions.map(row => <TableRow key={row.label}><TableCell>{row.label}</TableCell><TableCell>{row.basis}</TableCell><TableCell>{row.excluded}</TableCell></TableRow>)}</TableBody></Table></div>
    </TelemetryPanel>
  </>;
}
