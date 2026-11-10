import type { PortfolioCompanionId } from '@shared/portfolio-workspace.interface';

interface Companion {
  id: PortfolioCompanionId;
  name: [string, string];
  focus: [string, string];
  description: [string, string];
  blindSpot: [string, string];
}

/** Stable identities match the original animal SVGs, independently of account ordering. */
export const companions: Companion[] = [
  { id: 'value', name: ['老周', 'Lao Zhou'], focus: ['长期价值', 'Long-term value'],
    description: ['关心现金流、估值和安全边际。', 'Cash flow, valuation and margin of safety.'],
    blindSpot: ['也要检查长期假设是否已经改变。', 'Long-term assumptions still need to be challenged.'] },
  { id: 'technical', name: ['阿杰', 'Jay'], focus: ['趋势观察', 'Market trends'],
    description: ['关注趋势、量价和执行纪律。', 'Trends, price action and execution discipline.'],
    blindSpot: ['价格信号不能替代基本面证据。', 'Price signals do not replace fundamental evidence.'] },
  { id: 'macro', name: ['小柒', 'Qi'], focus: ['宏观情景', 'Macro scenarios'],
    description: ['把利率、政策与资产放在一起看。', 'Rates, policy and assets in a wider context.'],
    blindSpot: ['宏观判断需要落到具体资产验证。', 'Broad views need validation for each asset.'] },
  { id: 'growth', name: ['小芽', 'Nova'], focus: ['成长研究', 'Growth research'],
    description: ['寻找可验证的增长和竞争优势。', 'Measurable growth and competitive advantages.'],
    blindSpot: ['好的故事也需要检查价格与兑现。', 'A good story still needs delivery at a sensible price.'] },
  { id: 'risk', name: ['知秋', 'Sage'], focus: ['风险审视', 'Risk review'],
    description: ['先问最坏的情景和可能遗漏的证据。', 'Downside scenarios and overlooked evidence.'],
    blindSpot: ['谨慎也应评估错过机会的代价。', 'Caution also has an opportunity cost.'] },
  { id: 'news', name: ['闻溪', 'Quinn'], focus: ['事件研究', 'Event research'],
    description: ['核对来源、日期和事件的影响范围。', 'Sources, dates and the scope of an event.'],
    blindSpot: ['新消息不一定改变长期判断。', 'Fresh news does not always change a long-term view.'] },
  { id: 'moderator', name: ['知衡', 'Avery'], focus: ['多元思考', 'Multiple perspectives'],
    description: ['梳理共识，也保留尚未解决的分歧。', 'Clarify common ground and unresolved disagreement.'],
    blindSpot: ['共识本身不是正确性的证明。', 'Agreement alone is not proof.'] },
];

export function companionById(id: PortfolioCompanionId | null | undefined) {
  return companions.find(companion => companion.id === id);
}
