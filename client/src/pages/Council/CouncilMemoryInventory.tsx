import { useTranslation } from 'react-i18next';
import type { MemoryContextInventory } from '@shared/research-memory.interface';

const copy = {
  en: { title: 'Initial prompt memory', requested: 'Requested pins', selected: 'Selected', prepared: 'Prepared', submitted: 'Submitted',
    estimate: 'Conservative UTF-8 estimate', exact: 'Exact counter', budget: 'Memory budget', request: 'Request estimate', empty: 'None',
    api: 'Submitted to the API. Submission does not establish model use.', agent: 'Submitted to the native runtime. Its private model context is not observable.',
    command: 'Emitted in a companion command. Receipt by its private model is not observable.',
    scope: 'Known application prompt and evidence snapshot; private Agent context is unknown.', shared: 'Shared review request',
    pending: 'Not submitted.', omitted: 'Omissions', reasons: { budget: 'Whole item exceeds budget', disabled: 'Recall disabled',
      revoked: 'Unavailable or revoked', 'version-changed': 'Pinned version changed', 'structure-missing': 'Atomic structure unavailable' } },
  'zh-CN': { title: '初始提示词记忆', requested: '请求的固定版本', selected: '已选择', prepared: '已准备', submitted: '已提交',
    estimate: 'UTF-8 保守估计', exact: '精确计数器', budget: '记忆预算', request: '完整请求估计', empty: '无',
    api: '已提交到 API。提交不代表模型实际采用。', agent: '已提交到原生运行时。其私有模型上下文不可观测。',
    command: '已随伴随程序命令发出。其私有模型是否收到不可观测。',
    scope: '仅核算已知应用提示词与证据快照；Agent 私有上下文未知。', shared: '共用验收请求',
    pending: '尚未提交。', omitted: '省略原因', reasons: { budget: '整条超过预算', disabled: '已关闭召回',
      revoked: '不可用或已撤回', 'version-changed': '固定版本已变化', 'structure-missing': '缺少独立论点结构' } },
};

export default function CouncilMemoryInventory({ inventory }: { inventory?: MemoryContextInventory }) {
  const { i18n } = useTranslation();
  if (!inventory) return null;
  const text = copy[i18n.language.startsWith('zh') ? 'zh-CN' : 'en'];
  return <details className="mt-2 text-xs">
    <summary className="cursor-pointer text-muted-foreground">{text.title} · {text.selected} {inventory.counts.selected}
      {' · '}{text.prepared} {inventory.counts.prepared}{' · '}{text.submitted} {inventory.counts.submitted}</summary>
    <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-2 leading-5 [overflow-wrap:anywhere]">
      <p>{inventory.nativeDelivery === 'companion-command' ? text.command
        : inventory.submission === 'agent' ? text.agent : inventory.submission === 'api' ? text.api : text.pending}</p>
      {inventory.requestScope === 'application-prompt-and-snapshot' && <p>{text.scope}</p>}
      {inventory.sharedRequestAttemptId && <p>{text.shared}: {inventory.sharedRequestAttemptId}</p>}
      <p>{inventory.basis === 'exact' ? text.exact : text.estimate} · {text.budget}: {inventory.usedTokens}/{inventory.budgetTokens}
        {inventory.requestTokens !== undefined && <> · {text.request}: {inventory.requestTokens}/{inventory.requestBudgetTokens}</>}</p>
      {(['requested', 'selected', 'prepared', 'submitted'] as const).map(stage => <p key={stage}>
        <strong>{text[stage]} ({inventory.counts[stage]}): </strong>
        {inventory[stage].map(ref => `${ref.id} v${ref.version}`).join(' · ') || text.empty}
      </p>)}
      {!!inventory.omissions.length && <div><strong>{text.omitted}</strong><ul className="list-inside list-disc">
        {inventory.omissions.map((item, index) => <li key={`${item.id}:${index}`}>{item.id} v{item.version} · {text.reasons[item.reason]}
          {item.currentVersion !== undefined && ` → v${item.currentVersion}`}</li>)}
      </ul></div>}
    </div>
  </details>;
}
