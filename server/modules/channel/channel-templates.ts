import type { ChannelStance, ChannelTemplate, ChannelWeight, TemplateSlot } from '../../../shared/channel.interface';

export function builtinChannelTemplates(language = 'zh-CN'): ChannelTemplate[] {
  const en = language === 'en';
  const slot = (name: string, factKey: string, format: TemplateSlot['format'] = 'decimal'): TemplateSlot => ({ name, source: { kind: 'fact', factKey }, format });
  const line = (id: string, zh: string, english: string, stance: ChannelStance, weight: ChannelWeight,
    slots: TemplateSlot[] = [], extra: Partial<ChannelTemplate> = {}): ChannelTemplate => ({
    id: `channel.${id}`, revision: 1, kind: 'bubble', status: 'active', body: en ? english : zh,
    slotSchema: slots, allowedStances: [stance], allowedWeights: [weight], family: 'fact', isFactualStatusOnly: true,
    subject: 'verified_fact', changesConclusion: false, impliesInvestmentAdvice: false,
    reviewedAt: '2026-11-06T00:00:00.000Z', retiredAt: null, contentHash: '', ...extra,
  });
  const mood: Partial<ChannelTemplate> = { family: 'mood', subject: 'research_process', isFactualStatusOnly: false, speaker: 'xiaoqi' };
  return [
    line('process.countdown', '电话会还有 {minutes} 分钟，先等它开场。', 'The call starts in {minutes} minutes. Waiting for the source.', 'mood', 'tap', [slot('minutes', 'process.waitMinutes')], mood),
    line('process.arrived', '等了 {minutes} 分钟，这份数据总算到了。', 'The data arrived after {minutes} minutes.', 'mood', 'tap', [slot('minutes', 'process.elapsedMinutes')], mood),
    line('process.footnote', '这份公告把关键口径藏得够深。', 'That definition was buried deep in the filing.', 'mood', 'tap', [], { ...mood, subject: 'information_quality' }),
    line('source.missing', '一手源还没拿到，这条先不替你定性。', 'The primary source is missing; this remains unconfirmed.', 'unsure_honest', 'nudge', [], { speaker: 'xiaoqi' }),
    line('source.period_missing', '原文没写统计期间，这个数字暂时没法直接比较。', 'The period is missing, so this figure cannot be compared yet.', 'unsure_honest', 'tap', [], { speaker: 'xiaoqi' }),
    line('judgment.retracted', '原文不支持我之前那句，撤回，依据放下面。', 'The source does not support my earlier statement. I retract it.', 'admit_wrong', 'nudge'),
    line('monitor.near', '离模拟保护线只剩 {distance}，还没触发，我盯着。', 'Distance to the paper protection level: {distance}. Not triggered.', 'watchful', 'tap', [slot('distance', 'monitor.distance')], { speaker: 'laozhou' }),
    line('monitor.persisted', '在这条线附近停了 {minutes} 分钟，还没触发。', 'Near the level for {minutes} minutes; not triggered.', 'watchful', 'tap', [slot('minutes', 'monitor.persistedMinutes')], { speaker: 'laozhou' }),
    line('monitor.breached', '行情已穿过模拟保护线，执行状态以上方为准。', 'The quote crossed the paper protection level. Execution status is above.', 'plain_fact', 'poke', [], { speaker: 'laozhou' }),
    line('monitor.recovered', '回到观察区外了，这次没有触发规则。', 'Back outside the watch zone. No rule triggered this episode.', 'quiet_win', 'tap', [], { family: 'episode_close_no_user_action', speaker: 'laozhou' }),
    line('monitor.recovered_after_user', '行情已回到观察区外，用户操作结果以盘面状态为准。', 'The quote left the watch zone. Your action status is shown above.', 'plain_fact', 'nudge', [], { family: 'episode_close_after_user_action', speaker: 'laozhou' }),
    line('finding.discrepancy', '找到一处说法与原始依据不一致，具体对照在下面。', 'A statement differs from its source. The comparison is below.', 'plain_fact', 'nudge', [], { speaker: 'xiaoqi' }),
    line('finding.gap', '关键依据仍有缺口，这条判断暂时不能确认。', 'A material evidence gap remains. This claim is unconfirmed.', 'unsure_honest', 'nudge', [], { speaker: 'xiaoqi' }),
    line('finding.weakened', '新证据削弱了原来的前提，修订依据在下面。', 'New evidence weakens the original premise. Details are below.', 'plain_fact', 'nudge'),
    line('finding.refuted', '新证据推翻了原判断的关键前提，当前标为待复核。', 'New evidence contradicts a key premise. The claim needs review.', 'plain_fact', 'poke', [], { speaker: 'laozhou' }),
    line('opportunity.ready', '报告中的条件已满足，模拟方案尚未应用。', 'The report condition is met. The paper proposal is not applied.', 'plain_fact', 'poke', [], { speaker: 'ajie' }),
    line('paper.filled', '模拟盘这笔已成交 {quantity} 股，回执在下面。', 'The paper order filled {quantity} shares. Receipt below.', 'quiet_win', 'tap', [slot('quantity', 'execution.filledQuantity')], { speaker: 'ajie', subject: 'runtime_status' }),
    line('paper.partial', '模拟盘已成交 {filled} 股，剩余 {remaining} 股尚未成交。', 'Paper fill: {filled} shares; {remaining} remain unfilled.', 'plain_fact', 'nudge', [slot('filled', 'execution.filledQuantity'), slot('remaining', 'execution.remainingQuantity')], { speaker: 'ajie', subject: 'runtime_status' }),
    line('research.closed', '今天的研究已归档，完整报告在今日页。', 'Today’s research is archived. The full report is in Today.', 'quiet_win', 'tap', [], { family: 'closing_ritual', speaker: 'laozhou' }),
    line('process.research_arrived', '这轮研究用了 {minutes} 分钟，结果已经归档。', 'This research took {minutes} minutes. The result is archived.', 'mood', 'tap', [slot('minutes', 'process.elapsedMinutes')], mood),
    line('report.condition', '报告中预设的观察条件已满足，行情和原条件放在下面。', 'A report watch condition is met. The quote and original condition are below.', 'plain_fact', 'nudge', [], { speaker: 'xiaoqi' }),
    line('supplement.scope', '这次先查第 {selectedIndex} 项，其余 {count} 项已放进待办。', 'Checking item {selectedIndex}; {count} other questions are saved.', 'plain_fact', 'nudge', [slot('selectedIndex', 'supplement.scope.selectedIndex'), slot('count', 'supplement.scope.deferredCount')], { speaker: 'xiaoqi', subject: 'research_process' }),
    line('supplement.scope_needed', '问题已拆开，先选一个核查，其余保留在待办。', 'The questions are saved. Choose one fact to check first.', 'plain_fact', 'nudge', [], { speaker: 'xiaoqi', subject: 'research_process' }),
    line('supplement.unverified', '这次没有取得足够依据，暂时不能确认，缺口在下面。', 'This check did not establish the fact. The evidence gap is below.', 'unsure_honest', 'nudge', [], { speaker: 'xiaoqi' }),
    line('supplement.price', '当前取得的现价为 {price}，行情时点与来源见下方。', 'The retrieved price is {price}. Quote time and source are below.', 'plain_fact', 'nudge', [slot('price', 'supplement.price')], { speaker: 'xiaoqi' }),
    line('supplement.position', '当前记录的持股数量是 {quantity} 股，账户与时点见下方。', 'Recorded shares: {quantity}. Account and timestamp are below.', 'plain_fact', 'nudge', [slot('quantity', 'supplement.quantity')], { speaker: 'xiaoqi' }),
    line('supplement.cash', '当前记录的现金余额为 {amount}，币种与确认状态见下方。', 'Recorded cash: {amount}. Currency and confirmation are below.', 'plain_fact', 'nudge', [slot('amount', 'supplement.amount')], { speaker: 'xiaoqi' }),
    line('supplement.report_fact', '报告中对应的原文已定位，表述与出处见下方。', 'The matching report passage is located. Wording and source are below.', 'plain_fact', 'nudge', [], { speaker: 'xiaoqi' }),
    line('history.watchful', '上次我确实提醒过接近模拟保护线，原话与时点在下面。', 'I did flag the paper protection level earlier. My wording and timestamp are below.', 'I_told_you', 'nudge', [], { speaker: 'laozhou' }),
    line('card.report', '原报告与本次触发事实的可核验依据。', 'Verifiable sources for the report and this observation.', 'plain_fact', 'nudge', [], { kind: 'evidence_card' }),
    line('data.volume', '这段成交量低于同时间段中位数，原因还没核实。', 'Volume is below the same-period median. The cause is unverified.', 'unsure_honest', 'tap', [], { speaker: 'xiaoqi' }),
  ];
}
