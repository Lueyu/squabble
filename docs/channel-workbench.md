# Channel workbench

Squabble 不养辩论社。严肃研究沉在报告里，频道里住着的是：记得你、有自己活法、只在真需要时出现、错了敢认、办完不邀功的那个人。它话痨在反应，不话痨在分析。

## 使用方式

在简洁模式下，今日的每日研究先独立调查并封存交付，再经过单独的反向核查，生成可阅读报告和策略草稿。未发现反证不表示判断正确；缺失成员和资料会明确保留。历史报告和旧讨论仍可从原入口查阅。

频道上方显示模拟盘的当前规则、尚未应用的建议和实际执行记录。规则生效不等于订单成交，部分成交只显示实际数量。没有确认策略时显示“尚未应用策略 · 模拟盘仅观察”。

实际完整成交和部分成交都会由股友发出可见回执，点击可到模拟盘查看对应订单；重复检查同一笔成交不会重复发言。只含观察事项的策略明确显示“仅观察”。策略更换后，仍有效的报告提醒会跟随新策略重新核对；同一条件只有再次由未满足变为满足时才重复提醒。删除的草稿不再作为待应用建议展示。

Complete and partial paper fills produce visible stock-friend receipts linked to the exact order. Repeated polling does not duplicate a receipt. Observation-only strategies remain labelled as observations. Report reminders are rechecked for a changed strategy context, retaining the last threshold observation so only a new crossing produces another reminder. Deleted drafts leave the proposal list.

频道按事件聚合关键变化，待处理事项只置顶一条。随口区不通知、不抢滚动；quiet/deskmate/chatty 仅调整普通 tap 的密度。只有 poke 会产生频道提醒，普通 nudge 和 tap 不生成通知。资料、核查和实际公开工具记录在折叠抽屉中查看，不展示模型私密推理。

每句台词来自有版本的审核模板，绑定报告段落或事实记录。后台发现先由发布契约编译器自动授予资格，再核对当前来源和模板；不等待逐条人工审稿。只有可由用户补授予的权限才进入待授权队列。模板退役和来源更正会阻止旧候选发布。

追问一次只核查一个事实，最多调用一个查询工具；重试不会获得第二次调用。多个问题先冻结并进入待办，选定一项后才核查。查不到时保留证据缺口，不生成安慰式投资结论。

用户可以把自己确实发送的内容保存为偏好，或为真实策略决策补写采纳理由和后来复盘。系统只记录当时的客观快照，不代写心理动机。规则修改仍需在现有策略编辑页明确应用到模拟盘。

## Upgrade and verification

Migration `43_channel_workbench.sql` adds owner-scoped channel artifacts and an exact-version template registry. Existing holdings, cash, reports, trades and confirmed strategies are retained. The same migration is included in the fresh-install schema and startup migration list. No fictional seed is applied to existing installations.

Daily research uses sealed independent submissions followed by a mandatory reverse-check gate, even when the initial answers agree. Full findings remain in Today. A report can produce deterministic monitoring briefs only from explicit, supported conditions; unmeasurable conditions remain visible in research rather than receiving invented thresholds.

The channel projects committed paper-account state. It never grants real-account trading permissions. New findings use the same anchor, template, stance and publication checks as precompiled briefs. Finding, event and bubble share one semantic delta; compiler upgrades do not create another publication. Facts and template dependencies are rechecked before committing the bubble and its outbox records.

Contract tests cover empty relationship-memory attachments, compiler resealing, concurrent duplicate delivery, retired templates, corrected sources, frozen multi-question scope and user-authored reflection. Database tests cover upgrade parity, owner isolation, report preservation, real brief compilation and one-tool request budgets. Responsive browser fixtures include the dense legal state and the no-strategy state. Human comprehension timing and research-quality gains require measured user sessions; fixture tests do not establish those results.
