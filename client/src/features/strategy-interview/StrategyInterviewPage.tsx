import { useRef, useState } from 'react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CircleHelp, Send, Check } from 'lucide-react';
import type {
  StrategyInterviewField,
  StrategyInterviewPreview,
  StrategyInterviewView,
} from '@shared/strategy-interview.interface';
import {
  strategyInterviewsApi,
  strategyInterviewKeys,
} from '@/api/strategy-interviews';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { portfolioWorkspaceError } from '@/utils/portfolio-workspace';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import InterviewSummary, { interviewValueLabel } from './InterviewSummary';
import InterviewReview from './InterviewReview';
import {
  createInterviewIntent,
  interviewFieldLabels,
  isInterviewReviewCurrent,
  readComposer,
  readComposerField,
  saveComposer,
  stageInterviewAllocation,
} from './interview-state';
import './strategy-interview.css';
import InterviewFlowNavigation from './InterviewFlowNavigation';
import CompanionIdentity from '@/features/companions/CompanionIdentity';

export default function StrategyInterviewPage() {
  const { interviewId = '' } = useParams();
  return <InterviewWorkspace key={interviewId} id={interviewId} />;
}

function InterviewWorkspace({ id }: { id: string }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const language = zh ? 'zh-CN' : 'en';
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const reviewing = params.get('step') === 'review';
  const [message, setMessage] = useState(() => readComposer(id));
  const [editing, setEditing] = useState<StrategyInterviewField | null>(() =>
    readComposerField(id),
  );
  const [help, setHelp] = useState(false);
  const [lastPreview, setLastPreview] =
    useState<StrategyInterviewPreview | null>(null);
  const intent = useRef(createInterviewIntent(id, () => crypto.randomUUID()));
  const query = useQuery({
    queryKey: strategyInterviewKeys.item(id),
    queryFn: () => strategyInterviewsApi.get(id),
    retry: false,
  });
  const view = query.data;
  const accountsQuery = useQuery({
    queryKey: portfolioWorkspaceKeys.accounts,
    queryFn: portfolioWorkspaceApi.accounts,
    enabled: !!view,
    retry: false,
  });
  const companionId = Array.isArray(accountsQuery.data)
    ? accountsQuery.data.find((account) => account.id === view?.accountId)
        ?.companionId
    : undefined;
  const strategyQuery = useQuery({
    queryKey: ['strategy-interview-review', id, view?.revision],
    queryFn: () => strategyInterviewsApi.review(id),
    enabled: !!view?.review && reviewing,
    retry: false,
  });
  const latestStrategy =
    strategyQuery.data?.strategy ??
    (lastPreview?.interview.revision === view?.revision
      ? lastPreview?.strategy
      : undefined);
  const field = editing ?? view?.currentQuestion?.field ?? 'idea';
  const libraryPath =
    '/strategies' +
    (view ? '?accountId=' + encodeURIComponent(view.accountId) : '');
  const updateComposer = (
    text: string,
    target: StrategyInterviewField = field,
  ) => {
    setMessage(text);
    saveComposer(id, text, target);
  };
  const showStep = (step: 'chat' | 'review') => {
    const next = new URLSearchParams(params);
    if (step === 'review') next.set('step', step);
    else next.delete('step');
    setParams(next, { replace: true });
  };
  const receive = (next: StrategyInterviewView) => {
    client.setQueryData<StrategyInterviewView>(
      strategyInterviewKeys.item(id),
      (previous) =>
        !previous || next.revision >= previous.revision ? next : previous,
    );
    void client.invalidateQueries({ queryKey: ['strategy-interviews'] });
  };
  type Action =
    | { kind: 'answer'; exit?: boolean }
    | { kind: 'accept'; suggestionId: string }
    | { kind: 'preview'; observationOnly?: boolean }
    | { kind: 'stage' };
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: Action) => {
      if (!view)
        throw new Error(
          zh ? '请先重新读取对话。' : 'Reload the conversation first.',
        );
      if (action.kind === 'answer') {
        if (!message.trim()) {
          if (action.exit) navigate(libraryPath);
          return;
        }
        const payload = {
          field,
          message,
          expectedRevision: view.revision,
        };
        const request = intent.current.prepare(action.kind, payload);
        const next = await strategyInterviewsApi.answer(id, {
          ...request.input,
          requestKey: request.requestKey,
        });
        receive(next);
        updateComposer('');
        setEditing(null);
        setLastPreview(null);
        if (action.exit) navigate(libraryPath);
      } else if (action.kind === 'accept') {
        const payload = {
          suggestionId: action.suggestionId,
          expectedRevision: view.revision,
        };
        const request = intent.current.prepare(action.kind, payload);
        receive(
          await strategyInterviewsApi.accept(id, {
            ...request.input,
            requestKey: request.requestKey,
          }),
        );
        setLastPreview(null);
      } else if (action.kind === 'preview') {
        const payload = {
          expectedRevision: view.revision,
          observationOnly: action.observationOnly,
        };
        const request = intent.current.prepare(action.kind, payload);
        const next = await strategyInterviewsApi.preview(id, {
          ...request.input,
          requestKey: request.requestKey,
        });
        receive(next.interview);
        setLastPreview(next);
        client.setQueryData(
          ['strategy-interview-review', id, next.interview.revision],
          next,
        );
        showStep('review');
      } else {
        const freshInterview = await strategyInterviewsApi.get(id);
        const freshStrategy = freshInterview.review
          ? await investmentStrategiesApi.get(freshInterview.review.strategyId)
          : undefined;
        if (
          !isInterviewReviewCurrent(freshInterview, freshStrategy) ||
          freshInterview.revision !== view.revision ||
          !freshStrategy?.preview?.canConfirm
        ) {
          receive(freshInterview);
          throw new Error(
            zh
              ? '对话或规则已有变化，请重新生成预览。'
              : 'The conversation or rules changed. Generate a fresh review.',
          );
        }
        const account = await portfolioWorkspaceApi.account(
          freshInterview.accountId,
        );
        if (
          account.combination.draft &&
          account.combination.draft.expectedPolicyRevision !==
            account.combination.policyRevision
        ) {
          throw new Error(
            zh
              ? '账户组合已有新版本，请先在账户中重新核对现有草稿。'
              : 'The account combination changed. Review its existing draft in the account first.',
          );
        }
        const allocations = stageInterviewAllocation(
          account.combination.draft?.allocations ??
            account.combination.allocations,
          freshStrategy.id,
          freshStrategy.revision,
          freshInterview.baseStrategyId,
        );
        const payload = {
          expectedPolicyRevision: account.combination.policyRevision,
          allocations,
        };
        await portfolioWorkspaceApi.saveDraft(account.id, {
          ...payload,
          requestKey: intent.current.keyFor({
            kind: action.kind,
            accountId: account.id,
            ...payload,
          }),
        });
        await Promise.all([
          client.invalidateQueries({
            queryKey: portfolioWorkspaceKeys.account(account.id),
          }),
          client.invalidateQueries({
            queryKey: portfolioWorkspaceKeys.combination(account.id),
          }),
        ]);
        navigate('/paper/' + encodeURIComponent(account.id) + '/strategies');
      }
    },
    onSuccess: () => intent.current.complete(),
  });
  const busy = mutation.isPending;
  const edit = (nextField: StrategyInterviewField, quote: string) => {
    setEditing(nextField);
    updateComposer(quote, nextField);
    showStep('chat');
    document.getElementById('interview-answer')?.focus();
  };
  if (query.isPending)
    return (
      <div className="portfolio-workspace" role="status">
        {zh ? '正在恢复对话…' : 'Restoring conversation…'}
      </div>
    );
  if (query.isError || !view)
    return (
      <div className="portfolio-workspace">
        <p role="alert">
          {zh ? '无法读取这份对话。' : 'Could not load this conversation.'}
        </p>
        <Button onClick={() => void query.refetch()}>
          {zh ? '重试' : 'Retry'}
        </Button>
        <Button asChild variant="ghost">
          <Link to="/strategies">
            {zh ? '返回策略库' : 'Back to strategies'}
          </Link>
        </Button>
      </div>
    );
  const question =
    view.pending.find((item) => item.field === field) ?? view.currentQuestion;
  return (
    <div className="portfolio-workspace strategy-interview">
      <InterviewFlowNavigation>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            reviewing
              ? showStep('chat')
              : mutation.mutate({ kind: 'answer', exit: true })
          }
        >
          <ArrowLeft size={15} />
          {reviewing
            ? zh
              ? '返回对话'
              : 'Back to conversation'
            : zh
              ? '保存退出'
              : 'Save & exit'}
        </Button>
        <span role="status">
          {message
            ? zh
              ? '未发送内容暂存在此浏览器'
              : 'Unsent text is kept in this browser'
            : zh
              ? '对话已保存 · 可随时继续'
              : 'Conversation saved · resume anytime'}
        </span>
        <span className="interview-step">
          {reviewing ? '3' : '2'} / 4 ·{' '}
          {reviewing
            ? zh
              ? '核对规则'
              : 'Review rules'
            : zh
              ? '一起问清楚'
              : 'Clarify together'}
        </span>
      </InterviewFlowNavigation>
      <header className="portfolio-page-heading">
        <div>
          <h1>{zh ? '把想法聊成策略' : 'Turn your idea into a strategy'}</h1>
          <p>
            {view.account.name} ·{' '}
            {zh
              ? '每次只问清楚一件事，你来确认股友的理解。'
              : 'One question at a time. You confirm each interpretation.'}
          </p>
        </div>
        {companionId && <CompanionIdentity id={companionId} zh={zh} />}
      </header>
      {mutation.isError && (
        <div className="interview-error" role="alert">
          <p>
            {portfolioWorkspaceError(mutation.error, zh, {
              zh: '保存失败，内容仍保留，请重试。',
              en: 'Could not save. Your text is preserved; please retry.',
            })}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              intent.current.complete();
              void query.refetch();
            }}
          >
            {zh ? '重新读取已保存内容' : 'Reload saved conversation'}
          </Button>
        </div>
      )}
      <div className="interview-layout">
        {reviewing ? (
          <InterviewReview
            strategy={latestStrategy}
            examples={
              strategyQuery.data?.examples ??
              (lastPreview?.interview.revision === view.revision
                ? lastPreview.examples
                : [])
            }
            zh={zh}
            busy={busy}
            loading={strategyQuery.isPending && !latestStrategy}
            loadError={strategyQuery.isError}
            replacesBase={!!view.baseStrategyId}
            current={isInterviewReviewCurrent(view, latestStrategy)}
            stage={() => mutation.mutate({ kind: 'stage' })}
            back={() => showStep('chat')}
            checkExamples={() => void strategyQuery.refetch()}
          />
        ) : (
          <section className="interview-conversation-card">
            <details className="interview-history">
              <summary>
                {zh ? '查看对话记录' : 'Conversation history'} ·{' '}
                {view.messages.length}
              </summary>
              <div
                className="interview-transcript"
                aria-label={zh ? '已保存的对话' : 'Saved conversation'}
              >
                {view.messages.map((item) => (
                  <article
                    key={item.id}
                    className={
                      'interview-message interview-message-' + item.role
                    }
                  >
                    <span>
                      {item.role === 'user'
                        ? zh
                          ? '你'
                          : 'You'
                        : zh
                          ? '策略助手'
                          : 'Strategy assistant'}{' '}
                      · {interviewFieldLabels[item.field][zh ? 0 : 1]}
                    </span>
                    <p>
                      {item.role === 'assistant'
                        ? (item.localizedText?.[language] ?? item.text)
                        : item.text}
                    </p>
                    {item.supersedesMessageId && (
                      <small>
                        {zh
                          ? '这是一次修改，之前的原话仍保留。'
                          : 'This revision preserves your previous words.'}
                      </small>
                    )}
                  </article>
                ))}
              </div>
            </details>
            {view.suggestions.map((suggestion) => (
              <article className="interview-suggestion" key={suggestion.id}>
                <span className="interview-eyebrow">
                  {zh
                    ? '股友这样理解，等你确认'
                    : 'An interpretation for you to confirm'}
                </span>
                <strong>{interviewValueLabel(suggestion.value, zh)}</strong>
                <p>{suggestion.explanation[language]}</p>
                <blockquote>{suggestion.quote}</blockquote>
                <div className="interview-actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => edit(suggestion.field, suggestion.quote)}
                  >
                    {zh ? '不是这个意思' : 'Change this'}
                  </Button>
                  <Button
                    disabled={busy || !!message.trim()}
                    onClick={() =>
                      mutation.mutate({
                        kind: 'accept',
                        suggestionId: suggestion.id,
                      })
                    }
                  >
                    <Check size={14} />
                    {zh ? '确认这个理解' : 'Accept this interpretation'}
                  </Button>
                </div>
              </article>
            ))}
            <div className="interview-composer">
              <div className="interview-question">
                <Label htmlFor="interview-answer">
                  {editing
                    ? (zh ? '修改：' : 'Revise: ') +
                      interviewFieldLabels[field][zh ? 0 : 1]
                    : (question?.text[language] ??
                      (zh
                        ? '条件已问清楚，可以开始核对。'
                        : 'The details are clear. You can review the rules.'))}
                </Label>
                {question && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setHelp(true)}
                  >
                    <CircleHelp size={15} />
                    {zh ? '怎么回答' : 'Help'}
                  </Button>
                )}
              </div>
              <Textarea
                id="interview-answer"
                rows={3}
                maxLength={1500}
                value={message}
                disabled={busy}
                onChange={(event) => {
                  setEditing(field);
                  updateComposer(event.target.value);
                }}
                placeholder={question?.help[language]}
              />
              <div className="interview-actions">
                {editing && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      updateComposer('');
                    }}
                  >
                    {zh ? '取消修改' : 'Cancel edit'}
                  </Button>
                )}
                <Button
                  disabled={busy || !message.trim()}
                  onClick={() => mutation.mutate({ kind: 'answer' })}
                >
                  <Send size={14} />
                  {busy
                    ? zh
                      ? '正在保存…'
                      : 'Saving…'
                    : zh
                      ? '发送回答'
                      : 'Send answer'}
                </Button>
              </div>
            </div>
            <div className="interview-actions">
              <Button
                variant="outline"
                disabled={busy || !!message.trim()}
                onClick={() =>
                  mutation.mutate({ kind: 'preview', observationOnly: true })
                }
              >
                {zh ? '先保留为观察想法' : 'Keep as an observation'}
              </Button>
              <Button
                disabled={
                  busy ||
                  !!message.trim() ||
                  !!view.pending.length ||
                  !!view.suggestions.length
                }
                onClick={() => mutation.mutate({ kind: 'preview' })}
              >
                {zh ? '条件齐了，核对规则' : 'Review the rules'}
              </Button>
            </div>
            <p className="interview-note">
              {zh
                ? '当前助手先核对股票、价格条件、仓位、频率和有效期。无法明确表达的条件会继续提问或留为观察项。'
                : 'The assistant clarifies security, price, position, frequency and dates. Unresolved conditions stay as questions or observations.'}
            </p>
          </section>
        )}
        <InterviewSummary view={view} zh={zh} busy={busy} edit={edit} />
      </div>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {zh ? '这一步怎么回答' : 'How to answer this question'}
            </DialogTitle>
            <DialogDescription>{question?.help[language]}</DialogDescription>
          </DialogHeader>
          <p>
            {zh
              ? '可以先说你确定的部分。输入的原话会被保留，之后仍可修改。'
              : 'Start with the part you are sure about. Your original words are saved and can be revised.'}
          </p>
          <Button onClick={() => setHelp(false)}>
            {zh ? '回到当前问题' : 'Back to this question'}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
