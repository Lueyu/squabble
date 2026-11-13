import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import type { ConfirmPreview, TeamArchivePreviewInput, TeamDetail, TeamPreview } from '@shared/team-workspace.interface';
import { teamsApi } from '@/api/teams';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { friendlyError } from '@/utils/error-message';
import { PreviewReview, usePreviewExpired } from './TeamLifecycleDialogs';
import { TeamInflightCommissions, readInflightCommissions } from './TeamInflightCommissions';
import { TeamNotice } from './TeamPrimitives';

type Stage = 'idle' | 'reviewing' | 'review-unknown' | 'ready' | 'confirming' | 'uncertain' | 'rejected';

function definitiveRejection(error: unknown): boolean {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && ![408, 429].includes(status);
}

/** A pending receipt keeps its original team, reviewed revisions and request key. */
export function TeamRemovalDialog({ team, open, close, committed, zh, online }: {
  team: { id: string; name: string }; open: boolean; close: () => void;
  committed: (team: TeamDetail) => void; zh: boolean; online: boolean;
}) {
  const client = useQueryClient();
  const [stage, setStage] = useState<Stage>('idle');
  const [preview, setPreview] = useState<TeamPreview | null>(null);
  const [reviewed, setReviewed] = useState<TeamDetail | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reviewIntent = useRef<{ teamId: string; input: TeamArchivePreviewInput } | null>(null);
  const confirmIntent = useRef<{ teamId: string; input: ConfirmPreview } | null>(null);
  const operationLock = useRef(false);
  const busy = stage === 'reviewing' || stage === 'confirming';
  const unresolved = stage === 'uncertain';
  const expired = usePreviewExpired(preview);
  const accounts = useQuery({ queryKey: portfolioWorkspaceKeys.accounts, queryFn: portfolioWorkspaceApi.accounts,
    enabled: open, retry: false });
  const completeImpact = preview !== null && readInflightCommissions(preview.result) !== null;

  useEffect(() => {
    if (open && !confirmIntent.current && !reviewIntent.current) {
      setStage('idle'); setPreview(null); setReviewed(null); setAck(false); setError(null);
    }
  }, [open]);

  async function prepare(): Promise<void> {
    if (operationLock.current || busy || unresolved) return;
    operationLock.current = true;
    setStage('reviewing'); setError(null); setAck(false);
    try {
      if (!reviewIntent.current || stage === 'rejected' || stage === 'ready') {
        const current = await teamsApi.detail(team.id);
        setReviewed(current);
        reviewIntent.current = { teamId: current.id, input: { requestKey: crypto.randomUUID(),
          expectedBindingRevision: current.bindingRevision, expectedCurrentVersionId: current.currentVersionId,
          executionChoice: 'pause_all' } };
      }
      const intent = reviewIntent.current;
      const value = await teamsApi.archivePreview(intent.teamId, intent.input);
      setPreview(value);
      confirmIntent.current = { teamId: intent.teamId, input: { requestKey: crypto.randomUUID(),
        previewId: value.previewId, previewHash: value.previewHash } };
      setStage('ready');
    } catch (failure) {
      if (definitiveRejection(failure)) reviewIntent.current = null;
      setError(failure); setStage('review-unknown');
    } finally { operationLock.current = false; }
  }

  async function confirm(): Promise<void> {
    if (operationLock.current || busy || !confirmIntent.current || !ack || !completeImpact || (expired && !unresolved)) return;
    operationLock.current = true;
    setStage('confirming'); setError(null);
    const intent = confirmIntent.current;
    try {
      const value = await teamsApi.archive(intent.teamId, intent.input);
      confirmIntent.current = null; reviewIntent.current = null;
      await client.invalidateQueries({ queryKey: ['teams'] });
      await client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts });
      await client.invalidateQueries({ queryKey: ['team-run'] });
      committed(value.team); close();
    } catch (failure) {
      setError(failure); setStage(definitiveRejection(failure) ? 'rejected' : 'uncertain');
    } finally { operationLock.current = false; }
  }

  const dismiss = (): void => { if (!busy && !unresolved) { reviewIntent.current = null; confirmIntent.current = null; close(); } };
  return <Dialog open={open} onOpenChange={value => { if (!value) dismiss(); }}>
    <DialogContent className="team-dialog" onInteractOutside={event => { if (busy || unresolved) event.preventDefault(); }}
      onEscapeKeyDown={event => { if (busy || unresolved) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{zh ? '移除团队' : 'Remove team'}</DialogTitle>
        <DialogDescription>{zh
          ? '团队将移至“已归档”，从当前列表移除。账户、成交、报告与版本保留。该团队自动运行及当前关联模拟账户的全部自动单（包括保护单）停止；已派发的远端任务仍需核对结局，未知费用不会视为已结清。'
          : 'This team moves to Archived and leaves the current list. Accounts, trades, reports and versions are retained. This team’s automatic runs and all automated paper orders in its currently linked account, including protective orders, stop. Dispatched remote work still needs a confirmed outcome; unknown costs remain unsettled.'}</DialogDescription>
      </DialogHeader>
      <p className="break-words font-medium">{reviewed?.name ?? team.name}</p>
      {preview && <><TeamInflightCommissions result={preview.result} zh={zh} kind="archive"
        teams={reviewed ? [reviewed] : []} accounts={accounts.data} close={dismiss} />
        <PreviewReview preview={preview} zh={zh} />
        <label className="team-check-row"><Checkbox checked={ack} disabled={busy || unresolved || !completeImpact}
          onCheckedChange={value => setAck(value === true)} />{zh
          ? '已核对影响，同意移至已归档并停止上述自动执行。'
          : 'I reviewed the impact and agree to archive this team and stop this automation.'}</label></>}
      {error !== null && <TeamNotice error>{friendlyError(error, zh, { zh: '移除结果尚未确认，请核对同一请求。', en: 'Removal is unconfirmed. Check the same request.' })}</TeamNotice>}
      {unresolved && <p role="status" className="team-muted">{zh
        ? '原移除请求仍待确认。保持原团队、预览与请求不变，核对同一回执后再继续。'
        : 'The original removal is unresolved. Its team, preview and request stay fixed until the same receipt is confirmed.'}</p>}
      <div className="team-dialog-actions">
        <Button variant="outline" disabled={busy || unresolved} onClick={dismiss}>{zh ? '取消' : 'Cancel'}</Button>
        <Button variant="outline" disabled={!online || busy || unresolved} onClick={() => void prepare()}>{stage === 'review-unknown'
          ? (zh ? '重试同一影响检查' : 'Retry the same review') : (zh ? '检查移除影响' : 'Review removal impact')}</Button>
        <Button variant="destructive" disabled={!online || busy || !preview || !ack || !completeImpact || stage === 'rejected' || (expired && !unresolved)}
          onClick={() => void confirm()}>{unresolved ? (zh ? '核对同一移除回执' : 'Check same removal receipt') : (zh ? '确认移除' : 'Confirm removal')}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
