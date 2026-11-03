import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, Loader2, MessageCircle, Send, Sparkles, X, CornerUpLeft } from 'lucide-react';
import { toast } from 'sonner';
import type { CouncilMessage, CouncilSession } from '@shared/council.interface';
import type { useCouncilActions } from '@/hooks/use-council';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import { shouldSendCouncilMessage, shouldStartCouncilAfterMessage } from '@/utils/council-state';
import { researchConversation } from '@/utils/research-events';
import CouncilChatMessage from './CouncilChatMessage';
import CouncilResearchProgress from './CouncilResearchProgress';
import CouncilWorkflowPanel from './CouncilWorkflowPanel';
import CouncilMemberAvatar from './CouncilMemberAvatar';
import { councilPersona } from './council-persona';
import { councilReplyExcerpt } from '@/utils/council-message-text';

interface CouncilConversationProps {
  session: CouncilSession;
  actions: ReturnType<typeof useCouncilActions>;
  profileChanged: boolean;
}

export default function CouncilConversation({ session, actions, profileChanged }: CouncilConversationProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ content: string; reply: CouncilMessage | null }>({ content: '', reply: null });
  const { content, reply } = draft;
  const setContent = (next: SetStateAction<string>) => setDraft(current => ({ ...current,
    content: typeof next === 'function' ? next(current.content) : next }));
  const setReply = (next: CouncilMessage | null) => setDraft(current => ({ ...current, reply: next }));
  const [unread, setUnread] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const sending = useRef(false);
  const composing = useRef(false);
  const lastMessageId = session.messages.at(-1)?.id;
  const conversation = researchConversation(session);
  const researchCursor = conversation.cursor;
  const hasCurrentResearchEvents = session.researchEvents?.some(event => event.revision === session.revision);
  const messageLimitReached = session.messages.filter((message: CouncilMessage) => message.role === 'user').length >= 30;
  const replyPrefix = reply ? `${t('council.studio.replyPrefix', { name: reply.memberName, excerpt: councilReplyExcerpt(reply) })}\n\n` : '';
  const draftLimit = Math.max(0, 2000 - replyPrefix.length);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [content]);

  const addQuestion = (question: string) => {
    const next = content ? `${content}\n${question}` : question;
    if (next.length > draftLimit) { toast.error(t('council.studio.tooLong')); return; }
    setContent(next);
    inputRef.current?.focus();
  };

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (stickToBottom.current) viewport.scrollTop = viewport.scrollHeight;
    else setUnread(true);
  }, [lastMessageId, session.status, researchCursor]);

  const jumpToLatest = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    stickToBottom.current = true;
    setUnread(false);
  };

  const submit = async () => {
    if (!content.trim() || sending.current || messageLimitReached) return;
    if (replyPrefix.length + content.trim().length > 2000) { toast.error(t('council.studio.tooLong')); return; }
    const submittedDraft = content;
    const submittedReply = reply;
    const previousStatus = session.status;
    sending.current = true;
    let saved: CouncilSession;
    try {
      saved = await actions.send.mutateAsync({ id: session.id, content: replyPrefix + submittedDraft.trim() });
      setDraft(current => current.content === submittedDraft && current.reply === submittedReply
        ? { content: '', reply: null } : current);
      jumpToLatest();
    } catch (cause) {
      toast.error(errorMessage(cause, t('council.actionFailed')));
      sending.current = false;
      return;
    }
    try {
      if (shouldStartCouncilAfterMessage(previousStatus, saved.status)) await actions.run.mutateAsync(session.id);
    } catch (cause) {
      toast.error(`${t('council.messageSavedRunFailed')} ${errorMessage(cause, t('council.actionFailed'))}`);
    } finally { sending.current = false; }
  };

  return <>
    {Boolean(session.members?.length) && <div className="council-roster" aria-label={t('council.team.title')}>
      {session.members?.map(member => <div key={member.id} className="council-roster-member"
        data-persona={councilPersona(member.avatar, member.role)}
        data-active={session.status === 'running' && session.progress?.memberId === member.id}
        title={member.personality || member.roleTitle}>
        <CouncilMemberAvatar role={member.role} avatar={member.avatar} className="size-8" />
        <div><strong>{member.name}</strong><small>{member.roleTitle || t(`council.roles.${member.role}`)}</small></div>
      </div>)}
      <span className="council-roster-note">{t('council.studio.yourCall')}</span>
    </div>}
    <CouncilWorkflowPanel session={session} actions={actions} />
    <div className="council-studio relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions" aria-label={t('council.conversation')}
        className="council-chat-scroll min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain"
        onScroll={() => {
          const viewport = scrollRef.current;
          if (!viewport) return;
          stickToBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
          if (stickToBottom.current) setUnread(false);
        }}>
        <p className="mx-auto max-w-md text-center text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{session.members?.length
          ? t('council.members.roomHint', { names: session.members.map((member) => member.name).join(' · ') }) : t('council.roomHint')}</p>
        {profileChanged && <p className="mx-auto max-w-xl rounded-lg bg-card p-3 text-center text-xs leading-5 text-muted-foreground">{t('council.profileChanged')}</p>}
        {session.messages.length === 0 && !session.researchEvents?.length && <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-12 text-center text-muted-foreground">
          <MessageCircle className="size-8 text-primary/60" />
          <p className="text-sm leading-6">{t(session.status === 'running' ? 'council.startingHint'
            : session.reports.some((report) => report.engine === 'basic') ? 'council.noMessagesBasic' : 'council.noMessages')}</p>
        </div>}
        {conversation.entries.map((entry) => entry.legacyActivity
          ? <CouncilResearchProgress key={entry.key} message={entry.legacyActivity} />
          : <CouncilChatMessage key={entry.key} message={entry.message} task={entry.task} session={session} onQuestion={addQuestion}
            onReply={message => { setReply(message); inputRef.current?.focus(); }} />)}
        {conversation.truncated && <p className="text-xs leading-5 text-muted-foreground">{t('council.progress.truncated')}</p>}
        {session.status === 'running' && !hasCurrentResearchEvents && <div role="status" className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card"><Loader2 className="size-4 animate-spin text-primary" /></span>
          {t('council.runningHint')}
        </div>}
        {session.error && <div role="alert" className="mx-auto max-w-xl rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs leading-6">
          <p className="whitespace-pre-wrap break-words text-destructive">{session.error}</p>
          <div className="mt-1 flex flex-wrap gap-x-4 text-muted-foreground">
            <Link to="/settings" className="hover:underline">{t('council.apiSettings')}</Link>
            <Link to="/settings/budget" className="hover:underline">{t('council.budget.open')}</Link>
          </div>
        </div>}
      </div>
      {unread && <Button type="button" size="sm" variant="secondary" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md" onClick={jumpToLatest}>
        <ArrowDown className="size-3.5" />{t('council.latestMessages')}</Button>}
    </div>
    <form className="council-composer shrink-0 border-t border-border p-3 sm:px-5 sm:py-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="council-composer-inner">
      {!content && !reply && !messageLimitReached && <div className="council-quick-prompts" aria-label={t('council.studio.prompts')}>
        {['upside', 'downside', 'evidence'].map(key => <button key={key} type="button" onClick={() => addQuestion(t(`council.studio.promptText.${key}`))}>
          {t(`council.studio.promptLabels.${key}`)}</button>)}
      </div>}
      {reply && <div className="council-reply-context"><CornerUpLeft className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0"><strong>{t('council.studio.replyingTo', { name: reply.memberName })}</strong>
          <p className="mt-1 line-clamp-2 break-words text-muted-foreground">{councilReplyExcerpt(reply)}</p></div>
        <button type="button" aria-label={t('council.studio.cancelReply')} onClick={() => { setReply(null); inputRef.current?.focus(); }}><X className="size-3.5" /></button>
      </div>}
      <p className="council-composer-label"><Sparkles className="size-3.5" />{t('council.studio.join')}</p>
      <Label htmlFor="council-message" className="sr-only">{t('council.composerLabel')}</Label>
      <div className="council-composer-box flex items-end gap-2 border border-input bg-background focus-within:ring-2 focus-within:ring-ring/20">
        <Textarea ref={inputRef} id="council-message" value={content} onChange={(event) => setContent(event.target.value)}
          rows={1} maxLength={draftLimit} disabled={messageLimitReached} aria-describedby="council-composer-hint"
          className="min-h-[42px] max-h-40 resize-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          placeholder={t('council.composerPlaceholder')} onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => {
            if (shouldSendCouncilMessage({ key: event.key, shiftKey: event.shiftKey,
              isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
              event.preventDefault(); void submit();
            }
          }} />
        <Tooltip><TooltipTrigger asChild>
          <Button type="submit" size="icon" className="mb-1 shrink-0 rounded-xl" aria-label={t('council.send')}
            disabled={!content.trim() || content.trim().length > draftLimit || actions.send.isPending || messageLimitReached}>
            {actions.send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </TooltipTrigger><TooltipContent>{t('council.send')}</TooltipContent></Tooltip>
      </div>
      <div id="council-composer-hint" className="mt-2 flex items-center justify-between gap-2 text-[11px] leading-4 text-muted-foreground">
        <p>{content.length > draftLimit ? t('council.studio.tooLong') : t(messageLimitReached ? 'council.messageLimit' : session.status === 'paused' ? 'council.pausedHint'
          : session.status === 'failed' ? 'council.failedHint' : 'council.composerHint')}</p>
        <span className="hidden shrink-0 sm:inline">{t('council.keyboardHint')}</span>
      </div>
      </div>
    </form>
  </>;
}
