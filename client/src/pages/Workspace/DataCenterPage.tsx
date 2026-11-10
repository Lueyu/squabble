import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import DataMaterials from '@/features/data-library/DataMaterials';
import SubscriptionWorkspace from '@/features/data-library/SubscriptionWorkspace';
import FinancialSources from '@/features/data-library/FinancialSources';
import './workspace-v4.css';
import '@/features/data-library/data-library.css';

export default function DataCenterPage() {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const tab = ['subscriptions', 'financial'].includes(params.get('tab') || '') ? params.get('tab')! : 'library';
  return <main className="workspace-v4 data-workspace">
    <header className="workspace-v4-header"><div><h1>{zh ? '数据中心' : 'Data center'}</h1><p className="muted">{zh ? '把研究材料与金融数据放在一起，让每次研究都有来源。' : 'Keep research material and financial data together, with sources for every investigation.'}</p></div></header>
    <div className="data-tabs" role="tablist" aria-label={zh ? '数据中心视图' : 'Data center views'}>{(['library', 'subscriptions', 'financial'] as const).map(value => <Button role="tab" id={`data-tab-${value}`} aria-controls={`data-panel-${value}`} aria-selected={tab === value} key={value} variant={tab === value ? 'default' : 'outline'} onClick={() => { const next = new URLSearchParams(params); if (value === 'library') next.delete('tab'); else next.set('tab', value); setParams(next, { replace: true }); }}>{({ library: zh ? '资料库' : 'Library', subscriptions: zh ? '网站订阅' : 'Subscriptions', financial: zh ? '金融数据源' : 'Financial sources' })[value]}</Button>)}</div>
    <section role="tabpanel" id={`data-panel-${tab}`} aria-labelledby={`data-tab-${tab}`}>
      {tab === 'library' && <DataMaterials />}
      {tab === 'subscriptions' && <SubscriptionWorkspace />}
      {tab === 'financial' && <FinancialSources />}
    </section>
  </main>;
}
