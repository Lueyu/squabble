import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { strategyInterviewsApi } from '@/api/strategy-interviews';
import { portfolioWorkspaceError } from '@/utils/portfolio-workspace';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import CompanionIdentity from '@/features/companions/CompanionIdentity';
import {
  createInterviewIntent,
  readComposer,
  saveComposer,
} from './interview-state';
import './strategy-interview.css';
import InterviewFlowNavigation from './InterviewFlowNavigation';

export default function NewStrategyInterviewPage() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState(params.get('accountId') ?? '');
  const [message, setMessage] = useState(() => readComposer('new'));
  const intent = useRef(
    createInterviewIntent('new', () => crypto.randomUUID()),
  );
  const query = useQuery({
    queryKey: portfolioWorkspaceKeys.accounts,
    queryFn: portfolioWorkspaceApi.accounts,
    retry: false,
  });
  const accounts =
    query.data?.filter((item) => item.status !== 'archived') ?? [];
  const selected = accounts.find((item) => item.id === accountId);
  const mutation = useMutation({
    retry: false,
    mutationFn: () =>
      strategyInterviewsApi.create({
        accountId,
        message,
        requestKey: intent.current.keyFor({
          accountId,
          message,
        }),
      }),
    onSuccess: (view) => {
      intent.current.complete();
      saveComposer('new', '');
      navigate('/strategies/interviews/' + encodeURIComponent(view.id), {
        replace: true,
      });
    },
  });
  return (
    <div className="portfolio-workspace strategy-interview">
      <InterviewFlowNavigation>
        <Button asChild variant="outline">
          <Link
            to={
              '/strategies' +
              (accountId ? '?accountId=' + encodeURIComponent(accountId) : '')
            }
          >
            {zh ? '返回策略库' : 'Back to strategy library'}
          </Link>
        </Button>
        <span>{zh ? '1 / 4 · 表达想法' : '1 / 4 · Your idea'}</span>
      </InterviewFlowNavigation>
      <header className="portfolio-page-heading">
        <div>
          <h1>{zh ? '有个想法，先和股友聊聊' : 'Start with an idea'}</h1>
          <p>
            {zh
              ? '不用一次说清楚。先选一个目标账户，再一步步确认。'
              : 'You do not need all the details yet. Choose an account, then clarify together.'}
          </p>
        </div>
      </header>
      {query.isError ? (
        <div role="alert">
          <p>
            {zh ? '无法读取你的股友账户。' : 'Could not load your accounts.'}
          </p>
          <Button onClick={() => void query.refetch()}>
            {zh ? '重试' : 'Retry'}
          </Button>
        </div>
      ) : (
        <div className="interview-conversation-card">
          <Label htmlFor="interview-account">
            {zh
              ? '这次为哪个股友制定策略？'
              : 'Which account is this strategy for?'}
          </Label>
          <Select
            value={accountId}
            onValueChange={setAccountId}
            disabled={mutation.isPending || query.isPending}
          >
            <SelectTrigger id="interview-account">
              <SelectValue
                placeholder={
                  zh ? '选择独立模拟仓' : 'Choose a simulation account'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && <CompanionIdentity id={selected.companionId} zh={zh} />}
          {!query.isPending && !accounts.length && (
            <Button asChild variant="outline">
              <Link to="/paper?create=1">
                {zh ? '先创建一个股友账户' : 'Create a companion account first'}
              </Link>
            </Button>
          )}
          <Label htmlFor="interview-idea">
            {zh ? '你想尝试什么？' : 'What would you like to try?'}
          </Label>
          <Textarea
            id="interview-idea"
            rows={5}
            maxLength={1500}
            value={message}
            disabled={mutation.isPending}
            onChange={(event) => {
              setMessage(event.target.value);
              saveComposer('new', event.target.value);
            }}
            placeholder={
              zh
                ? '例如：想尝试长期分红，但不想在估值太高的时候追进去。'
                : 'For example: I want long-term dividends without buying at a high valuation.'
            }
          />
          <p className="interview-note">
            {zh
              ? '这一步只保存想法，不会启用策略或执行交易。'
              : 'This saves your idea. It does not enable a strategy or execute a trade.'}
          </p>
          {mutation.isError && (
            <p role="alert">
              {portfolioWorkspaceError(mutation.error, zh, {
                zh: '保存失败，请重试。',
                en: 'Could not save. Please retry.',
              })}
            </p>
          )}
          <Button
            disabled={!selected || !message.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending
              ? zh
                ? '正在保存…'
                : 'Saving…'
              : zh
                ? '开始，一起聊清楚'
                : 'Start clarifying together'}
          </Button>
        </div>
      )}
    </div>
  );
}
