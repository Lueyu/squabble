import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import AnimalAvatar from '@/components/AnimalAvatar';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TelemetryAgent, TelemetryWorkspace } from '@shared/telemetry.interface';
import { TelemetryPanel, TelemetryEmpty } from './TelemetryPrimitives';
import { formatAmount, formatCost, formatDuration, formatRate, telemetryAvatar } from './telemetry-state';

export default function TelemetryAgents({ data, selectAgent }: { data: TelemetryWorkspace; selectAgent: (id: string) => void }) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  return <>
    <div className="telemetry-banner"><strong>{zh ? '同类任务比较' : 'Compare like tasks'}</strong><p>{zh ? '使用上方场景、时间与执行方式筛选。混合任务的差异不能视为能力排名。' : 'Use scene, time and execution filters above. Different task mixes do not establish an ability ranking.'}</p></div>
    {!data.agents.length ? <TelemetryEmpty>{zh ? '当前范围没有可识别的成员执行记录。' : 'No attributable member executions in this range.'}</TelemetryEmpty> : <>
      <div className="telemetry-agent-cards" data-ai-section-type="card-list">{data.agents.map((agent: TelemetryAgent) => <Card className="telemetry-agent-card" key={agent.id}>
        <div className="telemetry-agent-identity"><AnimalAvatar avatar={telemetryAvatar(`${agent.role} ${agent.id}`)} role="researcher" className="size-8" />
          <div><h3>{agent.name}</h3><p className="telemetry-muted telemetry-mono">{agent.executionMode || '—'} · {agent.model ?? (zh ? '模型未知' : 'Unknown model')}</p></div></div>
        <div className="telemetry-coverage-value"><strong>{formatAmount(agent.executions)}</strong><span className="telemetry-muted">{zh ? '次成员执行' : 'executions'}</span></div>
        <p className="telemetry-muted">P95 {formatDuration(agent.p95DurationMs)} · {zh ? '估算' : 'est.'} {formatCost(agent.estimatedCostUsd)}</p>
        <div className="telemetry-progress"><i style={{ width: `${(agent.completionRate ?? 0) * 100}%` }} /></div>
        <div className="telemetry-row-between"><span className="telemetry-muted">{formatRate(agent.completionRate)} {zh ? '完成率' : 'completed'}</span>
          <Button variant="ghost" size="sm" onClick={() => selectAgent(agent.id)}>{zh ? '查看运行' : 'View runs'}</Button></div>
      </Card>)}</div>
      <TelemetryPanel title={zh ? '对比明细' : 'Comparison details'} description={zh ? '仅展示记录中的实际执行器与模型；身份未验证时保持未知。' : 'Actual recorded executors and models; unverified identities remain unknown.'}>
        <div className="telemetry-table-scroll"><Table className="telemetry-table"><TableHeader><TableRow>
          {[zh ? 'Agent / 角色' : 'Agent / role', zh ? '实际执行器 / 模型' : 'Executor / model', zh ? '执行数' : 'Executions', zh ? '完成率' : 'Completion', 'P95', zh ? '已知 tokens' : 'Known tokens', zh ? '估算费用' : 'Est. cost', zh ? '结果接受' : 'Accepted'].map((label: string) => <TableHead key={label}>{label}</TableHead>)}
        </TableRow></TableHeader><TableBody>{data.agents.map((agent: TelemetryAgent) => <TableRow key={agent.id}>
          <TableCell><Button variant="ghost" className="telemetry-table-link" onClick={() => selectAgent(agent.id)}>{agent.name}</Button><p className="telemetry-muted">{agent.role}</p></TableCell>
          <TableCell>{agent.provider ?? agent.executionMode ?? '—'} / {agent.model ?? (zh ? '未知' : 'Unknown')}</TableCell>
          <TableCell>{formatAmount(agent.executions)}</TableCell><TableCell>{formatRate(agent.completionRate)}</TableCell>
          <TableCell>{formatDuration(agent.p95DurationMs)}</TableCell><TableCell>{formatAmount(agent.totalTokens, true)}</TableCell>
          <TableCell>{formatCost(agent.estimatedCostUsd)}</TableCell><TableCell>{agent.acceptanceKnown ? `${agent.accepted} / ${agent.acceptanceKnown}` : '—'}</TableCell>
        </TableRow>)}</TableBody></Table></div>
        <p className="telemetry-muted">{zh ? '完成率 = 完成 /（完成 + 失败）。接受率仅覆盖交付状态已知的执行。费用覆盖不足时不作全量成本排名。' : 'Completion = completed / (completed + failed). Acceptance covers known delivery outcomes. Incomplete usage does not support a total-cost ranking.'}</p>
      </TelemetryPanel>
    </>}
  </>;
}
