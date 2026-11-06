import { useTranslation } from 'react-i18next';
import { displayInvestmentStatus } from '@/utils/ai-investment';

export default function InvestmentStatus({ status, lastHeartbeatAt }: { status: string; lastHeartbeatAt: string | null }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const visible = displayInvestmentStatus(status, lastHeartbeatAt);
  const labels = { observing: zh ? '已创建，先观察' : 'Created and observing', not_started: zh ? '尚未开启' : 'Not started', needs_information: zh ? '需要补充资料' : 'More information needed', needs_confirmation: zh ? '等待确认接管' : 'Awaiting takeover confirmation', running: zh ? '自动交易已开启' : 'Automatic trading enabled', paused: zh ? '自动交易已暂停' : 'Automatic trading paused', attention_required: zh ? '需要关注' : 'Attention needed', offline: zh ? '服务离线或心跳未知' : 'Service offline or heartbeat unknown', reassessing: zh ? '正在重新评估' : 'Reassessing current conditions' };
  return <div role="status" className="space-y-2"><p className="inline-flex items-center gap-2 text-lg font-semibold"><span className={`size-2 rounded-full ${visible === 'running' ? 'bg-success' : 'bg-muted-foreground'}`} />{labels[visible] || status}</p>
    {visible === 'paused' && <p className="text-sm leading-6 text-muted-foreground">{zh ? '全部自动买卖均已停止，包括自动止损与保护性退出。主动研究仍可继续。' : 'All automatic buys and sells are stopped, including stop-loss and protective exits. You can still research manually.'}</p>}
    {visible === 'reassessing' && <p className="text-sm text-muted-foreground">{zh ? '核对当前持仓、限制、行情与连接后再制定计划，不补执行旧指令。' : 'Checking current positions, limits, quotes and connections before creating a fresh plan. Old instructions will not replay.'}</p>}
    {(visible === 'offline' || lastHeartbeatAt) && <p className="text-xs text-muted-foreground">{zh ? '最后在线：' : 'Last online: '}{lastHeartbeatAt ? new Date(lastHeartbeatAt).toLocaleString(i18n.language) : (zh ? '未知' : 'Unknown')}</p>}
  </div>;
}
