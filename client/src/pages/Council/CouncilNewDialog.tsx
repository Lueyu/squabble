import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, MessageCircle, X } from 'lucide-react';
import type { BuilderProfile } from '@shared/api.interface';
import { COUNCIL_SCENES, type CouncilConfig, type CouncilScene, type CouncilSession, type CreateCouncilSession } from '@shared/council.interface';
import type { ReportReference } from '@shared/research-document.interface';
import { createCouncilPreset } from '@shared/council-templates';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateCouncilSettings } from '@/utils/council-state';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import CouncilTeamEditor from './CouncilTeamEditor';
import { useQuery } from '@tanstack/react-query';
import { fetchLocalAgents } from '@/api/local-agents';
import { assignLocalAgents } from './useCouncilModels';
import CouncilWorkflowOptions, { type WorkflowDraft } from './CouncilWorkflowOptions';
import { workflowCopy } from './workflow-copy';
import { threadCopy } from './thread-copy';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Link } from 'react-router-dom';
import CouncilReportPicker from './CouncilReportPicker';
import { resolveResearchReferences } from '@/api/research-documents';

interface CouncilNewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: BuilderProfile[];
  loading: boolean;
  error: unknown;
  pending: boolean;
  initialProfileId: string;
  initialTicker: string;
  initialTeam?: CouncilConfig;
  initialScene?: CouncilScene;
  initialReferences?: ReportReference[];
  initialPeriod?: { start: string; end: string };
  existingSessions?: CouncilSession[];
  onCreate: (request: CreateCouncilSession) => Promise<void>;
}

export default function CouncilNewDialog({ open, onOpenChange, profiles, loading, error, pending,
  initialProfileId, initialTicker, initialTeam, initialScene = 'stock', initialReferences = [], initialPeriod, existingSessions = [], onCreate }: CouncilNewDialogProps) {
  const { t, i18n } = useTranslation();
  const [profileId, setProfileId] = useState(initialProfileId);
  const [ticker, setTicker] = useState(initialTicker);
  const [scene, setScene] = useState<CouncilScene>(initialScene);
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [start, setStart] = useState(initialPeriod?.start ?? '');
  const [end, setEnd] = useState(initialPeriod?.end ?? '');
  const copy = threadCopy(i18n.language);
  const [selectedReferences, setSelectedReferences] = useState<ReportReference[]>(initialReferences);
  const stockScene = scene === 'stock' || scene === 'trade_pre_review';
  const references = useQuery({ queryKey: ['research-documents', 'resolve', selectedReferences],
    queryFn: () => resolveResearchReferences(selectedReferences), enabled: open && selectedReferences.length > 0, retry: false });
  const existing = existingSessions.filter(session => (session.scene ?? 'stock') === scene && selectedReferences.length > 0
    && selectedReferences.every(ref => session.references?.some(current => current.versionId === ref.versionId)));
  const [workflow, setWorkflow] = useState<WorkflowDraft>({ goal: 'comprehensive', peers: '', recallEnabled: true, parallelism: 2 });
  const [team, setTeam] = useState<CouncilConfig>(() => initialTeam ?? {
    enabled: true, members: createCouncilPreset('balanced', i18n.language), webResearch: false,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const agents = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents });
  const initializedAgents = useRef(Boolean(initialTeam) || Boolean(initialProfileId));
  const initializedProfile = useRef(Boolean(initialTeam) || !initialProfileId);
  useEffect(() => {
    if (initializedProfile.current) return;
    const profile = profiles.find((item: BuilderProfile) => item.id === initialProfileId);
    if (!profile) return;
    if (profile.config.council?.members.length) setTeam({ enabled: true, webResearch: false,
      members: profile.config.council.members.map((member) => ({ ...member, researchFocus: member.researchFocus?.filter((focus) => focus !== 'web' || member.executionMode === 'local') })) });
    initializedProfile.current = true;
  }, [profiles, initialProfileId]);
  useEffect(() => {
    if (initializedAgents.current || !agents.isSuccess) return;
    initializedAgents.current = true;
    setTeam(current => ({ ...current, members: assignLocalAgents(current.members, agents.data) }));
  }, [agents.isSuccess, agents.data]);
  const changeTeam = (value: CouncilConfig) => { initializedProfile.current = true; initializedAgents.current = true; setTeam(value); setFormError(null); };
  const create = async () => {
    if (pending) return;
    const symbol = stockScene ? ticker.trim().toUpperCase() : 'PORTFOLIO';
    if (!/^[A-Z0-9][A-Z0-9.^-]{0,19}$/u.test(symbol)
      || (profileId && !profiles.some((profile: BuilderProfile) => profile.id === profileId))) {
      setFormError(t('council.newInvalid')); return;
    }
    const invalid = validateCouncilSettings(team, undefined);
    if (invalid) { setFormError(t(`council.${invalid}`)); return; }
    const peers = workflow.peers.split(/[,，\s]+/u).map(p => p.trim().toUpperCase()).filter(Boolean);
    if (peers.length > 3 || new Set(peers).size !== peers.length || peers.includes(symbol)
      || peers.some(p => !/^[A-Z0-9][A-Z0-9.^-]{0,19}$/u.test(p)) || (workflow.goal === 'peers' && !peers.length)) {
      setFormError(workflowCopy[i18n.language.startsWith('zh') ? 'zh-CN' : 'en'].invalidPeers); return;
    }
    setFormError(null);
    try { await onCreate({ ticker: symbol, ...(profileId ? { profileId } : {}), members: team.members,
      scene, title: title.trim() || `${copy.scenes[scene]}${stockScene ? ` · ${symbol}` : ''}`, subject: subject.trim() || copy.scenes[scene],
      references: selectedReferences, ...(start || end ? { period: { start, end } } : {}),
      ...(stockScene ? { goal: workflow.goal, peers, parallelism: workflow.parallelism, recallEnabled: workflow.recallEnabled } : {}),
      webResearch: Boolean(team.webResearch), language: i18n.language.startsWith('zh') ? 'zh-CN' : 'en' }); }
    catch (cause) { setFormError(errorMessage(cause, t('council.actionFailed'))); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[92dvh] max-w-2xl flex-col gap-0 overflow-hidden p-0" showCloseButton={false}>
      <DialogHeader className="shrink-0 border-b border-border p-5 pr-14 text-left"><DialogTitle>{t('council.newTitle')}</DialogTitle>
        <DialogDescription>{t('council.newHint')}</DialogDescription></DialogHeader>
      <div className="absolute right-3 top-3"><DialogClose asChild><Button type="button" variant="ghost" size="icon" aria-label={t('council.close')}><X className="size-4" /></Button></DialogClose></div>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div className="space-y-2"><Label htmlFor="council-scene">{copy.scene}</Label>
            <Select value={scene} onValueChange={value => setScene(value as CouncilScene)}><SelectTrigger id="council-scene"><SelectValue /></SelectTrigger>
              <SelectContent>{COUNCIL_SCENES.map(value => <SelectItem value={value} key={value}>{copy.scenes[value]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label htmlFor="council-title">{copy.title}</Label><Input id="council-title" value={title} maxLength={160} onChange={event => setTitle(event.target.value)} placeholder={copy.scenes[scene]} /></div>
          <div className="space-y-2"><Label htmlFor="council-subject">{copy.subject}</Label><Input id="council-subject" value={subject} maxLength={240} onChange={event => setSubject(event.target.value)} /></div>
          {stockScene && <div className="space-y-2"><Label htmlFor="council-ticker">{t('council.ticker')}</Label>
            <Input autoFocus id="council-ticker" value={ticker} maxLength={20} placeholder="AAPL / 0700.HK / 600519.SS"
              onChange={(event) => setTicker(event.target.value)} /></div>}
          {(scene === 'period_strategy' || scene === 'trade_post_review') && <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="council-start">{copy.start}</Label><Input id="council-start" value={start} maxLength={10} placeholder="2026-11-01" onChange={event => setStart(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="council-end">{copy.end}</Label><Input id="council-end" value={end} maxLength={10} placeholder="2026-11-30" onChange={event => setEnd(event.target.value)} /></div>
          </div>}
          <CouncilReportPicker value={selectedReferences} onChange={setSelectedReferences} historical={scene !== 'trade_pre_review'} />
          {!!selectedReferences.length && <div className="space-y-2 rounded-md border p-3 text-xs"><p>{copy.pinned}</p>
            {references.isPending && <p>{t('council.loading')}</p>}
            {references.isError && <p role="alert" className="text-destructive">{errorMessage(references.error, copy.invalid)}</p>}
            {references.data?.map((ref, index) => <div key={`${ref.versionId}:${index}`}><Link className="text-primary underline"
              to={`/analysis/reports/${encodeURIComponent(ref.versionId)}${ref.sectionId ? `#${encodeURIComponent(ref.sectionId)}` : ''}`}>
              {ref.title} · v{ref.version}{ref.section ? ` · ${ref.section.title}` : ''}</Link>
              <p className="mt-1 text-muted-foreground">{copy.asOf}: {ref.dataAsOf ?? copy.unknown}</p>
              {ref.excerpt && <p className="mt-1 whitespace-pre-wrap break-words">{ref.excerpt}</p>}
              {(ref.status !== 'valid' || ref.sourceStatus !== 'available') && <p className="text-destructive">{copy.invalid}</p>}
            </div>)}
            {existing.slice(0, 3).map(session => <Button key={session.id} type="button" size="sm" variant="outline" asChild>
              <Link onClick={() => onOpenChange(false)} to={`/council?session=${encodeURIComponent(session.id)}`}>{copy.continuing} · {session.title || session.ticker}</Link></Button>)}
          </div>}
          {stockScene && <CouncilWorkflowOptions ticker={ticker} value={workflow} onChange={setWorkflow} />}
          <CouncilTeamEditor value={team} onChange={changeTeam} />
          <Collapsible defaultOpen={Boolean(initialProfileId)} className="rounded-xl border border-border">
            <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="h-auto min-h-9 w-full justify-between py-2 text-left text-xs">
              <span className="min-w-0 whitespace-normal">{t('council.members.profileOptional')}</span><ChevronDown className="size-3.5" /></Button></CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 px-3 pb-3">
              <Label htmlFor="council-profile" className="sr-only">{t('council.profile')}</Label>
              <select id="council-profile" value={profileId} disabled={loading}
                onChange={(event) => {
                  setProfileId(event.target.value);
                  const profile = profiles.find((item: BuilderProfile) => item.id === event.target.value);
                  if (profile?.config.council?.members.length) changeTeam({ ...team, members: profile.config.council.members.map((member) => ({
                    ...member, researchFocus: member.researchFocus?.filter((focus) => focus !== 'web' || team.webResearch || member.executionMode === 'local'),
                  })) });
                }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">{t('council.members.standalone')}</option>
                {profiles.map((profile: BuilderProfile) => <option key={profile.id} value={profile.id}>{profile.config.name}</option>)}
              </select>
              <p className="text-xs leading-5 text-muted-foreground">{t('council.members.profileHint')}</p>
              {error ? <p role="alert" className="text-xs text-muted-foreground">{t('council.members.profilesLoadFailed')}</p> : null}
            </CollapsibleContent>
          </Collapsible>
        </div>
        <div className="shrink-0 space-y-3 border-t border-border p-4">
          {formError && <p role="alert" className="break-words text-sm text-destructive">{formError}</p>}
          <Button type="submit" className="w-full" disabled={pending || agents.isPending || selectedReferences.length > 0
            && (references.isPending || references.isError || scene === 'trade_pre_review' && references.data?.some(ref => ref.status !== 'valid' || ref.sourceStatus !== 'available'))}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}{t('council.startChat')}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
