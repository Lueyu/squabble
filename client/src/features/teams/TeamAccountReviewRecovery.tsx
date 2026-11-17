import { useState } from 'react';
import type { AiInvestmentPreview } from '@shared/investment-policy.interface';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TeamAccountSeedReview } from './TeamAccountSeedReview';
import { guidedSeedBlockers } from './guided-team-state';

export function TeamAccountReviewRecovery({ zh, read, confirm }: { zh: boolean; read: () => Promise<AiInvestmentPreview>; confirm: (preview: AiInvestmentPreview) => void }) {
  const [preview, setPreview] = useState<AiInvestmentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = async (): Promise<void> => {
    setBusy(true); setFailed(false);
    try { setPreview(await read()); setAck(false); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3">
    <p className="text-sm">{zh ? '模拟盘尚未创建，起点已过期或实仓有变化。重新核对起点后继续，已经创建的团队和发布版本不会重复。' : 'The account has not been created. Its seed expired or real positions changed. Review a fresh seed to continue; the team and publication will not be created again.'}</p>
    <Button variant="outline" disabled={busy} onClick={() => void refresh()}>{zh ? '重新核对模拟盘起点' : 'Refresh paper account seed'}</Button>
    {failed && <p role="alert">{zh ? '新快照尚未读取成功，原进度已保留。' : 'The new snapshot could not be read; original progress is retained.'}</p>}
    {preview && <><TeamAccountSeedReview preview={preview} zh={zh} /><label className="flex items-start gap-2 text-sm"><Checkbox checked={ack} onCheckedChange={value => setAck(value === true)} />{zh ? '我已重新核对这次持仓和虚拟现金起点。' : 'I reviewed these refreshed positions and virtual opening cash.'}</label><Button disabled={!ack || busy || guidedSeedBlockers(preview.needsInput).length > 0 || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => confirm(preview)}>{zh ? '继续创建原团队的模拟盘' : 'Continue the original team account'}</Button></>}
  </div>;
}
