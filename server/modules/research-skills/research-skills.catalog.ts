import type { ResearchSkillDescriptor } from '@shared/research-skills.interface';
import { BUNDLED_RESEARCH_SKILLS, pinResearchSkill } from './research-skills.registry';

const catalog: Array<Omit<ResearchSkillDescriptor, 'requiredTools' | 'version' | 'mode'>> = [
  { id: 'financial-verification', command: '/financials', title: '财报解读', titleEn: 'Financial results', description: '核对口径，解释经营变化与验证点', descriptionEn: 'Verify reported figures, causes and next checks' },
  { id: 'peer-comparison', command: '/peers', title: '同业对比', titleEn: 'Peer comparison', description: '说明业务差异与数据可比性', descriptionEn: 'Compare businesses and accounting bases' },
  { id: 'valuation-ranges', command: '/valuation', title: '估值区间', titleEn: 'Valuation ranges', description: '区分已知事实与情景假设', descriptionEn: 'Separate sourced facts from scenario assumptions' },
  { id: 'contrarian-invalidation', command: '/challenge', title: '挑战假设', titleEn: 'Challenge a thesis', description: '寻找反证，明确判断何时失效', descriptionEn: 'Find counterevidence and invalidation conditions' },
  { id: 'source-reading', command: '/read', title: '资料精读', titleEn: 'Read sources', description: '阅读资料库，保留原文版本和引用', descriptionEn: 'Read library sources with versioned citations' },
  { id: 'announcement-analysis', command: '/announcement', title: '公告解读', titleEn: 'Announcements', description: '核验公告原文与事件的实际影响', descriptionEn: 'Verify original disclosures and their impact' },
  { id: 'daily-stock', command: '/daily-stock', title: '个股复盘', titleEn: 'Stock recap', description: '区分量价、事件与基本面变化', descriptionEn: 'Separate price, events and business changes' },
  { id: 'portfolio-review', command: '/portfolio-review', title: '账户复盘', titleEn: 'Portfolio review', description: '从真实持仓检查集中度与共同风险', descriptionEn: 'Check concentration and shared portfolio risks' },
  { id: 'industry-analysis', command: '/industry', title: '行业研究', titleEn: 'Industry research', description: '梳理产业链、竞争与传导条件', descriptionEn: 'Review value chains, competition and transmission' },
];

export function researchSkillCatalog(): ResearchSkillDescriptor[] {
  return [{ id: 'strategy', command: '/strategy', title: '聊出策略', titleEn: 'Clarify a strategy',
    description: '一步步问清目标，形成可检验草案', descriptionEn: 'Clarify your intent into a testable draft',
    mode: 'interview', version: '1.0.0', requiredTools: [] },
  ...catalog.map(entry => {
    const pin = pinResearchSkill(entry.id).find(item => item.id === entry.id)!;
    const manifest = BUNDLED_RESEARCH_SKILLS.find(item => item.id === pin.id && item.version === pin.version)!;
    return { ...entry, mode: 'research' as const, version: pin.version, requiredTools: [...manifest.requiredTools] };
  })];
}

export function researchSkillTitle(id: string, language: string): string {
  const item = catalog.find(entry => entry.id === id);
  return item ? language === 'en' ? item.titleEn : item.title : id;
}
