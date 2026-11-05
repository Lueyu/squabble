import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ConstraintProposal } from '@/api/ai-investment';
import { confirmInvestmentConstraint } from '@/api/ai-investment';
import { createRequestIntent } from '@/utils/simple-experience';
import { Button } from '@/components/ui/button';

export default function ConstraintProposalCard({ proposal, onClose }: { proposal: ConstraintProposal; onClose: () => void }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [pending, setPending] = useState(false); const [applied, setApplied] = useState(false); const [error, setError] = useState(false);
  const lock = useRef(false); const intent = useRef(createRequestIntent(() => crypto.randomUUID())); const client = useQueryClient();
  const expired = Date.parse(proposal.expiresAt) <= Date.now();
  const confirm = async () => {
    if (lock.current || applied || expired || proposal.needsInput.length) return;
    lock.current = true; setPending(true); setError(false);
    const input = { expectedPolicyRevision: proposal.expectedPolicyRevision };
    try { await confirmInvestmentConstraint(proposal.id, { ...input, requestKey: intent.current.keyFor({ id: proposal.id, ...input }) }); setApplied(true); intent.current.complete(); await client.invalidateQueries({ queryKey: ['ai-investment'] }); }
    catch { setError(true); } finally { lock.current = false; setPending(false); }
  };
  return <section className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4" aria-label={zh ? '投资限制确认' : 'Confirm investment restriction'}>
    <h3 className="font-semibold">{applied ? (zh ? '已应用' : 'Applied') : (zh ? '确认对 AI 账户的影响' : 'Confirm the effect on your AI account')}</h3>
    <p className="break-words text-sm">{proposal.text}</p><p className="break-words text-sm leading-6">{proposal.impact}</p>
    {proposal.constraint?.kind === 'no_sell' && <p className="text-sm font-semibold">{zh ? '完全禁止自动卖出，也会停止该股的自动止损及保护性退出。' : 'This blocks every automatic sale, including this stock’s stop-loss and protective exits.'}</p>}
    <p className="text-xs text-muted-foreground">{proposal.constraint?.expiresAt ? `${zh ? '生效至：' : 'Effective until: '}${new Date(proposal.constraint.expiresAt).toLocaleString(i18n.language)}` : (zh ? '持续生效，直到你取消。' : 'Effective until you revoke it.')}</p>
    {!!proposal.needsInput.length && <p role="status" className="text-sm">{zh ? '请补充明确的股票、额度或期限，再提出限制。' : 'Specify the security, amount or expiry before proposing this restriction.'}</p>}
    {expired && !applied && <p role="alert" className="text-sm">{zh ? '确认卡已过期，请重新提出。' : 'This confirmation expired. Propose it again.'}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{zh ? '未能确认应用。限制可能已变化，请刷新并重新核对。' : 'Application could not be confirmed. Restrictions may have changed; refresh and review again.'}</p>}
    <div className="flex flex-wrap gap-2">{!applied && <Button disabled={pending || expired || !!proposal.needsInput.length || !proposal.constraint} onClick={() => void confirm()}>{pending ? (zh ? '正在应用…' : 'Applying…') : (zh ? '应用到 AI 账户' : 'Apply to AI account')}</Button>}<Button variant="ghost" onClick={onClose}>{zh ? '关闭' : 'Close'}</Button></div>
  </section>;
}
