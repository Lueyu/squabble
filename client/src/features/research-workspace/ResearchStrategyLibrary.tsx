import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { strategyInterviewsApi, strategyInterviewKeys } from '@/api/strategy-interviews';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';

export function ResearchStrategyLibrary({ selected, search, onSelect }: {
  selected: string | null; search: string; onSelect: (kind: 'interview' | 'strategy', id: string) => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const interviews = useQuery({ queryKey: strategyInterviewKeys.list(), queryFn: () => strategyInterviewsApi.list(), retry: false });
  const library = useQuery({ queryKey: ['investment-strategies'], queryFn: investmentStrategiesApi.workspace, retry: false });
  const rules = [...(library.data?.drafts ?? []), ...(library.data?.history ?? []), ...(library.data?.current ? [library.data.current] : [])]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const drafts = interviews.data ?? [];
  const matches = (text: string) => text.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  return <>
    {(interviews.isPending || library.isPending) && <p role="status" className="research-history-notice">{zh ? '正在读取策略…' : 'Loading strategies…'}</p>}
    {(interviews.isError || library.isError) && <Button variant="ghost" onClick={() => { void interviews.refetch(); void library.refetch(); }}>{zh ? '重新读取策略' : 'Reload strategies'}</Button>}
    <h2>{zh ? '访谈草稿' : 'Interview drafts'} · {drafts.length}</h2>
    <ul className="research-history-list">{drafts.filter(item => matches(item.messages.find(message => message.role === 'user')?.text ?? '')).map(item => {
      const title = item.messages.find(message => message.role === 'user')?.text ?? (zh ? '策略访谈' : 'Strategy interview');
      return <li key={item.id} className={selected === item.id ? 'is-selected' : ''}><button type="button" className="research-history-select"
        aria-current={selected === item.id ? 'page' : undefined} onClick={() => onSelect('interview', item.id)}>
        <strong>{title}</strong><span>{item.account.name} · {item.pending.length ? (zh ? '待补充' : 'To clarify') : (zh ? '可核对' : 'Ready to review')}</span>
      </button></li>;
    })}</ul>
    <h2>{zh ? '已有策略' : 'Saved strategies'} · {rules.length}</h2>
    <ul className="research-history-list">{rules.filter(item => matches(item.content.title)).map(item => <li key={item.id} className={selected === item.id ? 'is-selected' : ''}>
      <button type="button" className="research-history-select" aria-current={selected === item.id ? 'page' : undefined} onClick={() => onSelect('strategy', item.id)}>
        <strong>{item.content.title}</strong><span>{item.status === 'confirmed' ? (zh ? '已确认' : 'Confirmed') : (zh ? '草稿' : 'Draft')} · v{item.revision}</span>
      </button></li>)}</ul>
    {!interviews.isPending && !library.isPending && !drafts.length && !rules.length && <p className="research-history-notice">{zh ? '输入 /strategy，从一个想法开始。' : 'Type /strategy to start with an idea.'}</p>}
  </>;
}

export function ResearchSavedStrategy({ id }: { id: string }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const query = useQuery({ queryKey: ['research-saved-strategy', id], queryFn: () => investmentStrategiesApi.get(id), retry: false });
  const accounts = useQuery({ queryKey: portfolioWorkspaceKeys.accounts, queryFn: portfolioWorkspaceApi.accounts, retry: false });
  if (query.isPending) return <p role="status">{zh ? '正在读取策略…' : 'Loading strategy…'}</p>;
  if (!query.data || query.isError) return <Button onClick={() => void query.refetch()}>{zh ? '重新读取策略' : 'Reload strategy'}</Button>;
  const strategy = query.data;
  return <article className="research-saved-strategy">
    <header><h1>{strategy.content.title}</h1><p>{strategy.status === 'confirmed' ? (zh ? '已确认' : 'Confirmed') : (zh ? '草稿' : 'Draft')} · v{strategy.revision}</p></header>
    <p className="whitespace-pre-wrap">{strategy.content.body}</p>
    <h2>{zh ? '规则与观察条件' : 'Rules and observation conditions'}</h2>
    <ol>{strategy.content.entries.map(entry => <li key={entry.id}>{entry.text}</li>)}</ol>
    {strategy.sources.length > 0 && <details><summary>{zh ? '来源' : 'Sources'} · {strategy.sources.length}</summary>{strategy.sources.map(source => <p key={source.key}>{source.title}</p>)}</details>}
    <section className="research-strategy-accounts"><h2>{zh ? '选择模拟仓核对组合' : 'Choose a simulation to review the combination'}</h2>
      <p>{zh ? '进入对应账户核对后再应用，查看策略不会启用交易。' : 'Review the target account before applying. Viewing a strategy does not enable trading.'}</p>
      {accounts.data?.filter(account => account.status !== 'archived').map(account => <Button key={account.id} asChild variant="outline"><Link to={`/paper/${encodeURIComponent(account.id)}/strategies?investmentStrategyId=${encodeURIComponent(id)}`}>{account.name}</Link></Button>)}
      {accounts.isError && <Button onClick={() => void accounts.refetch()}>{zh ? '重新读取账户' : 'Reload accounts'}</Button>}
    </section>
  </article>;
}
