import type { CouncilScene } from '@shared/council.interface';

export function threadCopy(language: string) {
  const zh = language.startsWith('zh');
  const scenes: Record<CouncilScene, string> = zh ? { portfolio_daily: '本日持仓讨论', stock: '单股研究', period_strategy: '期间策略',
    trade_pre_review: '交易执行前复核', trade_post_review: '交易与模拟盘复盘' }
    : { portfolio_daily: 'Daily portfolio', stock: 'Stock research', period_strategy: 'Period strategy',
      trade_pre_review: 'Pre-trade review', trade_post_review: 'Post-trade review' };
  return { scenes, scene: zh ? '讨论场景' : 'Discussion scene', title: zh ? '讨论标题' : 'Discussion title',
    subject: zh ? '本轮问题' : 'Research question', start: zh ? '开始日期（YYYY-MM-DD）' : 'Start date (YYYY-MM-DD)',
    end: zh ? '结束日期（YYYY-MM-DD）' : 'End date (YYYY-MM-DD)',
    pinned: zh ? '固定版本资料' : 'Pinned report versions', fork: zh ? '从这里另开讨论' : 'Fork from here',
    parent: zh ? '父讨论' : 'Parent discussion', inherited: zh ? '分支继承的原文（固定快照）' : 'Frozen parent transcript',
    limit: zh ? '接近本轮30条消息上限，可审阅摘要后另开分支继续。' : 'Near the 30-message limit. Review a summary and continue in a branch.',
    archive: zh ? '保存为报告版本' : 'Save report version', open: zh ? '查看或修订报告' : 'Open or revise report',
    draft: zh ? '生成策略草案' : 'Create strategy draft',
    generated: zh ? '已生成并归档；采纳主结论请在报告页确认。' : 'Generated and archived. Adopt the conclusion on the report page.',
    invalid: zh ? '已撤销或缺少来源：仅作待反证历史材料，不能作为交易事实依据。' : 'Revoked or missing source: historical claims to challenge, never trading evidence.',
    asOf: zh ? '数据截至' : 'Data as of', unknown: zh ? '未知' : 'Unknown',
    summary: zh ? '阶段总结' : 'Stage summary', summaryHint: zh ? '本轮阶段总结保留分歧和待验证事项，未自动成为交易依据。' : 'Stage summaries retain dissent and open checks. They do not authorize orders.',
    continuing: zh ? '继续现有讨论' : 'Continue existing discussion',
  };
}
