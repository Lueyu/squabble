import { Link } from 'react-router-dom';
import { TEAM_COMMISSION_STATES, type TeamCommissionState } from '@shared/team-workspace.interface';
import { Button } from '@/components/ui/button';
import { commissionStateLabel } from './team-commission-state';
import { TeamNotice } from './TeamPrimitives';
import './team-preview-review.css';

interface InflightCommission {
  id: string; teamId: string; accountId: string; state: TeamCommissionState; teamVersionId: string; objective: string;
  handoverEffect: 'stop_new_work_settle_dispatched'; canRequestCancellation: boolean;
}
export function readInflightCommissions(result: Record<string, unknown>): InflightCommission[] | null {
  if (!Array.isArray(result.inflightCommissions)) return null;
  const valid = result.inflightCommissions.every(value => {
    if (!value || typeof value !== 'object') return false;
    return ['id', 'teamId', 'accountId', 'teamVersionId', 'objective'].every(key => typeof value[key] === 'string')
      && TEAM_COMMISSION_STATES.includes(value.state) && value.handoverEffect === 'stop_new_work_settle_dispatched' && typeof value.canRequestCancellation === 'boolean';
  });
  return valid ? result.inflightCommissions : null;
}
export function TeamInflightCommissions({ result, zh, kind, teams = [], accounts = [], close }: { result: Record<string, unknown>; zh: boolean; kind: 'binding' | 'archive'; teams?: { id: string; name: string }[]; accounts?: { id: string; name: string }[]; close?: () => void }) {
  const commissions = readInflightCommissions(result);
  return <section className="team-inflight-impact" aria-label={zh ? '在途委托及处理影响' : 'Inflight commissions and impact'}><h3>{zh ? '本次影响的在途委托' : 'Inflight commissions affected by this step'}</h3>
    {commissions === null ? <TeamNotice error>{zh ? '服务器未返回完整在途委托清单，当前影响未知。请重新检查后再确认。' : 'The server did not return a complete inflight commission list. Impact is unknown. Check again before confirming.'}</TeamNotice> : !commissions.length ? <p className="team-muted team-small">{zh ? '本次服务器检查未发现受影响的在途委托。确认前如出现新的委托，需重新检查。' : 'This server check found no affected inflight commissions. New work before confirmation requires another review.'}</p> : <>
      <TeamNotice>{kind === 'archive' ? (zh ? '归档后停止这些委托的新工作派发。' : 'No new work will be dispatched for these commissions after archiving.') : (zh ? '交接后停止这些委托的新工作派发。' : 'No new work will be dispatched for these commissions after the handoff.')} {zh ? '已派发调用仍按原团队、账户和版本记录结算；接受交付仍须复验来源。未知结果与可能费用不会自动结清，取消必须另行请求并核对远端结果。' : 'Already dispatched calls still settle against the original team, account and version; delivery acceptance rechecks sources. Unknown results and possible costs remain unsettled. Cancellation must be requested separately and its remote outcome checked.'}</TeamNotice>
      <ul className="team-inflight-list">{commissions.map(item => <li key={item.id}><article><div className="team-section-title"><h4>{item.objective || (zh ? '未记录研究问题' : 'Research question unrecorded')}</h4><strong>{commissionStateLabel(item.state, zh)}</strong></div><dl className="team-inflight-identities"><div><dt>{zh ? '原团队' : 'Original team'}</dt><dd>{teams.find(team => team.id === item.teamId)?.name ?? item.teamId}</dd></div><div><dt>{zh ? '原账户' : 'Original account'}</dt><dd>{accounts.find(account => account.id === item.accountId)?.name ?? item.accountId}</dd></div><div><dt>{zh ? '固定团队版本' : 'Frozen team version'}</dt><dd>{item.teamVersionId}</dd></div><div><dt>{zh ? '委托标识' : 'Commission ID'}</dt><dd>{item.id}</dd></div></dl><p className="team-small">{zh ? '不派发新的岗位或依赖工作；已派发部分仅按原快照结算，不迁队、不迁盘。' : 'No new role or dependency work. Dispatched work settles only under its original snapshot; it does not move to another team or account.'}</p>{item.canRequestCancellation ? <Button asChild variant="outline" size="sm"><Link to={`/teams/${encodeURIComponent(item.teamId)}?panel=history&commissionId=${encodeURIComponent(item.id)}`} onClick={close}>{zh ? '查看原委托并请求取消' : 'View original commission and request cancellation'}</Link></Button> : <p className="team-muted team-small">{zh ? '当前不能通过此连接确认取消，请核对连接端状态；未知不能视为已取消。' : 'Cancellation cannot currently be confirmed through this connection. Check the connection; unknown does not mean cancelled.'}</p>}</article></li>)}</ul>
    </>}
  </section>;
}
