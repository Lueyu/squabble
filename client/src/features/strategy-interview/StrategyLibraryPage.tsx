import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MessageCircle, Plus, ArrowRight } from 'lucide-react';
import {
  strategyInterviewsApi,
  strategyInterviewKeys,
} from '@/api/strategy-interviews';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import { Button } from '@/components/ui/button';
import { interviewFieldLabels } from './interview-state';
import './strategy-interview.css';

export default function StrategyLibraryPage() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params] = useSearchParams();
  const accountId = params.get('accountId') ?? undefined;
  const query = useQuery({
    queryKey: strategyInterviewKeys.list(accountId),
    queryFn: () => strategyInterviewsApi.list(accountId),
    retry: false,
  });
  const library = useQuery({
    queryKey: ['investment-strategies'],
    queryFn: investmentStrategiesApi.workspace,
    retry: false,
  });
  return (
    <div className="portfolio-workspace strategy-library">
      <header className="portfolio-page-heading">
        <div>
          <h1>{zh ? '策略库' : 'Strategy library'}</h1>
          <p>
            {zh
              ? '已应用的规则和聊到一半的想法，都在这里。'
              : 'Applied rules and unfinished conversations, in one place.'}
          </p>
        </div>
        <Button asChild>
          <Link
            to={
              '/strategies/new' +
              (accountId ? '?accountId=' + encodeURIComponent(accountId) : '')
            }
          >
            <Plus size={16} />
            {zh ? '聊一个新想法' : 'Start a conversation'}
          </Link>
        </Button>
      </header>
      <h2>{zh ? '继续你的想法' : 'Continue your ideas'}</h2>
      {query.isPending && (
        <p role="status">
          {zh ? '正在读取已保存的对话…' : 'Loading saved conversations…'}
        </p>
      )}
      {query.isError && (
        <div role="alert">
          <p>{zh ? '暂时无法读取草稿。' : 'Could not load drafts.'}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {zh ? '重试' : 'Retry'}
          </Button>
        </div>
      )}
      {query.data && !query.data.length && (
        <div className="interview-empty">
          <MessageCircle size={28} />
          <p>
            {zh
              ? '还没有对话草稿。只要有一个想法，就可以开始。'
              : 'No conversation drafts yet. Start with an idea.'}
          </p>
        </div>
      )}
      <div className="interview-draft-grid">
        {query.data?.map((item) => (
          <article key={item.id} className="interview-draft-card">
            <span className="interview-eyebrow">{item.account.name}</span>
            <h3>
              {item.messages
                .find((message) => message.role === 'user')
                ?.text.slice(0, 100) || (zh ? '策略草稿' : 'Strategy draft')}
            </h3>
            <p>
              {zh ? '已确认' : 'Confirmed'} {item.confirmed.length} ·{' '}
              {zh ? '待问清' : 'To clarify'} {item.pending.length}
            </p>
            <p className="text-sm text-muted-foreground">
              {item.currentQuestion
                ? interviewFieldLabels[item.currentQuestion.field][zh ? 0 : 1]
                : zh
                  ? '可以核对规则'
                  : 'Ready to review rules'}
            </p>
            <Button asChild variant="outline">
              <Link
                to={'/strategies/interviews/' + encodeURIComponent(item.id)}
              >
                {zh ? '从上次继续聊' : 'Continue where you left off'}
                <ArrowRight size={15} />
              </Link>
            </Button>
          </article>
        ))}
      </div>
      <section className="interview-saved-rules">
        <h2>{zh ? '已有策略与版本' : 'Existing strategies & versions'}</h2>
        {library.isError && (
          <Button variant="outline" onClick={() => void library.refetch()}>
            {zh ? '重新读取策略' : 'Reload strategies'}
          </Button>
        )}
        {[
          ...(library.data?.drafts ?? []),
          ...(library.data?.history ?? []),
          ...(library.data?.current ? [library.data.current] : []),
        ]
          .filter(
            (item, index, all) =>
              all.findIndex((other) => other.id === item.id) === index,
          )
          .map((item) => (
            <article key={item.id} className="interview-rule-row">
              <div>
                <strong>{item.content.title}</strong>
                <p>
                  {zh ? '修订' : 'Revision'} {item.revision} ·{' '}
                  {item.status === 'confirmed'
                    ? zh
                      ? '已确认'
                      : 'Confirmed'
                    : zh
                      ? '草稿'
                      : 'Draft'}
                </p>
              </div>
              <Button asChild variant="ghost">
                <Link
                  to={
                    accountId
                      ? '/paper/' +
                        encodeURIComponent(accountId) +
                        '/strategies?investmentStrategyId=' +
                        encodeURIComponent(item.id)
                      : '/paper'
                  }
                >
                  {accountId
                    ? zh
                      ? '在账户中管理'
                      : 'Manage in account'
                    : zh
                      ? '选择股友管理'
                      : 'Choose an account'}
                </Link>
              </Button>
            </article>
          ))}
      </section>
    </div>
  );
}
